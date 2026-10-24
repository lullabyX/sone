use serde::Deserialize;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

/// LinkPlay httpapi transport for pushed-URL casting to the receiver.
///
/// The receiver's `loadLocalQueue` route crashes its process on any payload
/// (documented in findings/tidal_connect_protocol_spec.md section 6), so the
/// media transport rides the LinkPlay HTTP API on TCP 443 instead:
/// `https://<host>/httpapi.asp?command=setPlayerCmd:<sub>:<value>` with the
/// subcommands `play` (URL), `pause`, `resume`, `stop`, `seek` (ms), and
/// `vol` (0-100). Verified against a WiiM Amp (A98, Master Room) on 2026-10-16.
///
/// Quirks calibrated on-device:
/// - `curpos` is reported in milliseconds while a track plays untouched, but
///   switches to microseconds after a `seek` and then freezes (firmware bug).
///   Position is therefore maintained locally in `CastStatus` and only state
///   transitions and `vol` are trusted from the device.
/// - `vol` is 0-100, matching the TIDAL Connect session's 0.0-1.0 level scale.
pub struct LinkPlayClient {
    http: reqwest::Client,
}

/// getPlayerStatus reports numeric fields as JSON strings on some firmware
/// (`"curpos":"1842"`); accept either form.
/// Natural-end proximity: a play-to-stop transition only advances the queue
/// when the extrapolated position is this close to the reported track length
/// (absorbs the 1 s poller sampling skew; mirrors is_track_finished's 1500 ms
/// rule with headroom for the drift-prone post-load receiver clock).
const NATURAL_END_MARGIN_MS: f64 = 2400.0;

fn any_u64<'de, D>(d: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = serde_json::Value::deserialize(d)?;
    Ok(match v {
        serde_json::Value::Number(n) => n.as_u64().unwrap_or(0),
        serde_json::Value::String(s) => s.parse().unwrap_or(0),
        _ => 0,
    })
}

/// Raw device JSON from getPlayerStatus.
#[derive(Clone, Debug, Deserialize, Default)]
pub struct PlayerStatusRaw {
    #[serde(rename = "status", default)]
    pub status: String,
    #[serde(default, deserialize_with = "any_u64")]
    pub curpos: u64,
    #[serde(default, deserialize_with = "any_u64")]
    pub totlen: u64,
    #[serde(default, deserialize_with = "any_u64")]
    pub vol: u64,
    #[serde(default, rename = "Title")]
    pub title: String,
    #[serde(default, rename = "Artist")]
    pub artist: String,
    #[serde(default, rename = "Album")]
    pub album: String,
}

/// Latest known receiver state, maintained by the 1 s poller.
#[derive(Clone, Debug)]
pub struct CastStatus {    /// Device-reported player state: "play", "pause", or "stop".
    pub status: String,
    /// Local extrapolated playback position in milliseconds.
    pub pos_ms: f64,
    /// Position in milliseconds of the seek/start anchor.
    pub anchor_ms: f64,
    /// Monotonic instant of the anchor (start of extrapolation).
    pub anchor_at: Option<Instant>,
    /// Device-reported total length in milliseconds ("totlen").
    pub totlen_ms: u64,
    /// True for exactly one poll cycle after an operator-initiated stop, so
    /// the natural play-to-stop transition is not reported as a track end.
    pub stop_commanded: bool,
    /// Monotonic instant of the push that created this state; the
    /// receiver-first-play confirmation is measured against it.
    pub pushed_at: Instant,
    /// Last observed device volume (0-100); volume events only report deltas.
    pub last_vol: u64,
    /// URL that was pushed to the receiver; the poller uses it for jam
    /// recovery (re-push when the receiver never reached play).
    pub cast_url: Option<String>,
    /// Set on the first observed "play" after a push; a push still unplayed
    /// when the jam grace window expires is re-pushed by the poller.
    pub play_confirmed: bool,
    /// How many jam-recovery re-pushes were issued for this cast.
    pub repushes: u32,
}

impl CastStatus {
    /// Fresh state right after a push: the anchor sits at 0 ms while the
    /// receiver's decoder primes (its first curpos trails the wall clock by
    /// roughly one second), and the very first observed clock restart is NOT
    /// a natural end.
    fn fresh(stop_commanded: bool) -> Self {
        Self {
            pushed_at: Instant::now(),
            status: "stop".into(),
            pos_ms: 0.0,
            anchor_ms: 0.0,
            anchor_at: None,
            totlen_ms: 0,
            stop_commanded,
            last_vol: 0,
            cast_url: None,
            play_confirmed: false,
            repushes: 0,
        }
    }
}

impl LinkPlayClient {
    /// The device client arrives pre-built by `proxy_http::build_local_device_client`.
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }

    /// Issue one raw httpapi command and return the body text.
    ///
    /// The receiver's HTTP service occasionally returns an empty body while
    /// it is busy (observed on A98 during player state transitions, ~1 in 20
    /// polls); callers treat that like any other transient failure.
    pub async fn raw(&self, host: &str, command: &str) -> Result<String, String> {
        let url = format!("https://{}/httpapi.asp?command={}", host, command);
        let resp = self
            .http
            .get(&url)
            // Per-request override: the device must not hold a 1 Hz poller
            // for the shared client's full default timeout.
            .timeout(Duration::from_secs(4))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("httpapi request failed: {}", e))?;
        let text = resp
            .text()
            .await
            .map_err(|e| format!("httpapi body read failed: {}", e))?;
        if text.trim().is_empty() {
            return Err("empty httpapi response (receiver busy)".to_string());
        }
        Ok(text)
    }

    /// Replace current playback with the given URL (HTTP/S only).
    pub async fn push_play(&self, host: &str, url: &str) -> Result<(), String> {
        let cmd = format!("setPlayerCmd%3Aplay%3A{}", url.replace(':', "%3A"));
        let body = self
            .raw(host, &cmd)
            .await
            .map_err(|e| format!("LinkPlay play request failed: {}", e))?;
        if body.trim() != "OK" {
            return Err(format!("LinkPlay play rejected ({}): {}", body.trim(), url));
        }
        Ok(())
    }

    /// Push-URL variant that also resets the local position machine.
    pub async fn push_url(
        &self,
        host: &str,
        url: &str,
        status_slot: &RwLock<Option<CastStatus>>,
    ) -> Result<(), String> {
        self.push_play(host, url).await?;
        let mut slot = status_slot.write().await;
        let mut fresh = CastStatus::fresh(false);
        fresh.cast_url = Some(url.to_string());
        *slot = Some(fresh);
        Ok(())
    }

    pub async fn pause(&self, host: &str) -> Result<(), String> {
        self.expect_ok(host, "setPlayerCmd%3Apause").await
    }

    pub async fn resume(&self, host: &str) -> Result<(), String> {
        self.expect_ok(host, "setPlayerCmd%3Aresume").await
    }

    /// Operator stop: suppresses the next play-to-stop transition so the
    /// poller does not report it as a natural track end.
    pub async fn stop(&self, host: &str, status_slot: &RwLock<Option<CastStatus>>) -> Result<(), String> {
        self.expect_ok(host, "setPlayerCmd%3Astop").await?;
        if let Some(cur) = status_slot.write().await.as_mut() {
            cur.stop_commanded = true;
        }
        Ok(())
    }

    pub async fn seek(
        &self,
        host: &str,
        position_ms: f64,
        status_slot: &RwLock<Option<CastStatus>>,
    ) -> Result<(), String> {
        let cmd = format!("setPlayerCmd%3Aseek%3A{}", position_ms as u64);
        self.expect_ok(host, &cmd).await?;
        let mut slot = status_slot.write().await;
        let fresh = match slot.as_ref() {
            Some(s) => CastStatus {
                status: s.status.clone(),
                pos_ms: position_ms,
                anchor_ms: position_ms,
                anchor_at: Some(Instant::now()),
                totlen_ms: s.totlen_ms,
                stop_commanded: s.stop_commanded,
                pushed_at: s.pushed_at,
                last_vol: s.last_vol,
                cast_url: s.cast_url.clone(),
                play_confirmed: s.play_confirmed,
                repushes: s.repushes,
            },
            None => CastStatus::fresh(true),
        };
        *slot = Some(fresh);
        Ok(())
    }

    /// Volume on the LinkPlay 0-100 scale (matches the TIDAL 0.0-1.0 scale).
    pub async fn set_volume(&self, host: &str, level: f64) -> Result<(), String> {
        let volume = level.clamp(0.0, 100.0) as u64;
        let cmd = format!("setPlayerCmd%3Avol%3A{}", volume);
        self.expect_ok(host, &cmd).await
    }

    async fn expect_ok(&self, host: &str, command: &str) -> Result<(), String> {
        let body = self
            .raw(host, command)
            .await
            .map_err(|e| format!("LinkPlay request failed ({})", e))?;
        if body.trim() != "OK" {
            return Err(format!(
                "LinkPlay command rejected ({}): {}",
                body.trim(),
                command
            ));
        }
        Ok(())
    }

    /// One status poll; updates the extrapolation state machine in `slot` and
    /// returns `(status, track_ended)` plus the observed volume (0-100) when
    /// the device reported a CHANGE in `vol`. `track_ended` fires on an
    /// un-commanded play-to-stop transition so the caller can emit
    /// `tidal-connect:track-ended` for queue advancement.
    pub async fn poll(
        &self,
        host: &str,
        slot: &RwLock<Option<CastStatus>>,
    ) -> Result<(PlayerStatusRaw, bool, Option<u64>), String> {
        let body = self
            .raw(host, "getPlayerStatus")
            .await
            .map_err(|e| format!("LinkPlay status request failed: {}", e))?;
        let raw: PlayerStatusRaw = serde_json::from_str(&body)
            .map_err(|e| format!("LinkPlay status parse failed: {} body={}", e, body))?;

        let mut slot_guard = slot.write().await;
        let mut volume = None;
        if let Some(cur) = slot_guard.as_mut() {
            let new_status = raw.status.clone();
            if cur.status != new_status {
                if new_status == "play" {
                    // Clock restart: extrapolation resumes from anchor_ms.
                    cur.anchor_at = Some(Instant::now());
                    cur.play_confirmed = true;
                    // The first play confirmation after a push is the cast
                    // startup latency; it is measured against pushed_at and
                    // logged so a connection-time series can be derived from
                    // the app log alone (see AGENTS.md section 5.3). The
                    // intermediate "load" state some firmware reports between
                    // stop and play is allowed to precede it.
                    if cur.status == "stop" || cur.status == "load" {
                        log::info!(
                            "[cast-poller] receiver confirmed play {} ms after cast push",
                            cur.pushed_at.elapsed().as_millis()
                        );
                    }
                } else if new_status == "pause" {
                    // Freeze the anchor at the extrapolated position.
                    if let Some(started) = cur.anchor_at.take() {
                        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
                        cur.anchor_ms += elapsed;
                    }
                } else if new_status == "stop" && cur.status == "play" {
                    if cur.stop_commanded {
                        cur.stop_commanded = false;
                    } else if cur.totlen_ms > 0
                        && cur.pos_ms >= cur.totlen_ms as f64 - NATURAL_END_MARGIN_MS
                    {
                        // Natural end at the track boundary: report and drop
                        // the cast position. Uses the same proximity rule as
                        // is_track_finished (commands/playback.rs), widened
                        // for the 1 s sampling skew.
                        *slot_guard = None;
                        return Ok((raw, true, volume));
                    } else {
                        // Stop far from the track boundary: an operator stop
                        // on the receiver itself, or the transient stop some
                        // firmware emits around a load. Never advance the
                        // queue from here; the receiver may return to play.
                        log::debug!(
                            "[cast-poller] ignoring mid-track stop at {:.1}/{:.1}s",
                            cur.pos_ms / 1000.0,
                            cur.totlen_ms as f64 / 1000.0
                        );
                    }
                }
                cur.status = new_status;
            }
            if cur.status == "play" {
                // The device's curpos is in ms and advances correctly until a
                // seek happens, after which it switches to microseconds (and
                // freezes). A curpos beyond twice the track length is that
                // broken post-seek scale; extrapolate locally instead.
                if raw.totlen > 0 && raw.curpos > raw.totlen.saturating_mul(2) {
                    if let Some(started) = cur.anchor_at {
                        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
                        cur.pos_ms = cur.anchor_ms + elapsed;
                    }
                } else {
                    cur.pos_ms = raw.curpos as f64;
                }
            } else {
                cur.pos_ms = cur.anchor_ms;
            }
            cur.totlen_ms = raw.totlen;
            volume = if cur.last_vol != raw.vol {
                cur.last_vol = raw.vol;
                Some(raw.vol)
            } else {
                None
            };
        }
        Ok((raw, false, volume))
    }
}
