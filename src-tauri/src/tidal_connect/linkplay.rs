//! LinkPlay httpapi transport for TIDAL Connect receiver casts.
//!
//! [Maintainer walkthrough] This is the module that actually talks to the
//! receiver. The receiver exposes an HTTP control API (`httpapi.asp`) where a
//! percent-encoded `setPlayerCmd:<op>[:<arg>]` command drives the player and
//! `getPlayerStatus` returns a JSON snapshot (status, `curpos`, `totlen`,
//! `vol`). Casting is a push: `setPlayerCmd:play:<url>` plus a URL that Sone
//! itself serves (`manifest_server.rs`), either a single DASH `.mpd`, a
//! trimmed `.mpd` variant (seek), or a native `.m3u8` playlist (album cast).
//!
//! Two things this module owns that are easy to get wrong:
//!
//! - **Position truth.** The receiver's device clock is not a reliable
//!   cross-track reference: `curpos` has been observed cumulative over some
//!   playlists and entry-local in others mid-playlist, `totlen` flips to the
//!   preloaded NEXT entry well before the current one ends, and after a seek
//!   trim clocks are renumbered. `CastStatus` therefore carries its own
//!   wall-clock math (anchor + monotonic elapsed) for BOTH a single cast and
//!   each playlist entry; device numbers are adopted only when they agree
//!   with the wall estimate and lie inside the entry.
//! - **Boundary semantics.** The boundary line between
//!   "receiver stopped playing" and "track/playlist ended naturally" is thin:
//!   the poller reports a natural end only for an UN-commanded play-to-stop,
//!   one poll cycle, with the position in the end margin. See the `poll`
//!   function and `NATURAL_END_MARGIN_MS`; `stop_commanded`, `stop_verified`,
//!   and `last_natural_end` (state) suppress or confirm report paths.
//!
//! Error-return convention: every `Result<_, String>` in this file is
//! human-readable; points of failure log INFO/WARN with the `[cast-poller]`
//! prefix so a single cast run can be narrated from `sone_r*.log` alone.
use serde::Deserialize;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use crate::tidal_api::StreamInfo;
use crate::tidal_connect::manifest_server::QueueEntry;

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

/// A receiver-side seek moves the device clock; an operator stop leaves it
/// where it was playing. Two consecutive `curpos` samples further apart than
/// this are treated as a seek (a normal poll advances the clock by ~1000 ms).
const SEEK_JUMP_MS: f64 = 2000.0;

/// Normalize a stop-time `curpos` sample to milliseconds local to the push
/// that is playing now, or `None` when the value cannot be one.
///
/// The firmware reports `curpos` in three incompatible scales depending on
/// history: entry-local milliseconds normally, CUMULATIVE milliseconds across
/// a native playlist (2026-11-01: 172 s -> 784 s over five entries), and
/// microseconds after a `setPlayerCmd:seek` (2026-10-23: target x 1000, then
/// frozen).
///
/// A value past the entry is one of the last two, and the previous poll
/// separates them: a microsecond sample only appears right after the seek, so
/// the sample before it was a plausible millisecond value; a clock that was
/// already out of range was cumulative all along. Cumulative samples are
/// never usable as a trim offset.
fn normalize_stop_curpos(curpos: u64, prev_curpos: u64, len_ms: f64) -> Option<f64> {
    if curpos == 0 || len_ms <= 0.0 {
        return None;
    }
    let raw = curpos as f64;
    if raw <= len_ms + SEEK_JUMP_MS {
        return Some(raw);
    }
    let prev_local = prev_curpos > 0 && (prev_curpos as f64) <= len_ms + SEEK_JUMP_MS;
    let micros = raw / 1000.0;
    if prev_local && micros <= len_ms + SEEK_JUMP_MS {
        return Some(micros);
    }
    None
}

/// What the receiver clock says about a play-to-stop (or play-to-pause)
/// transition.
enum StopCause {
    /// The engine stopped/paused where it was playing: an operator action.
    Operator,
    /// A receiver-side seek with a usable target (entry-local milliseconds).
    Seek(f64),
    /// A receiver-side seek whose reported target is not usable for this push
    /// (cumulative clock, unknown length): resume where playback had reached.
    SeekUnreadable,
}

/// Classify a stop/pause transition from two consecutive receiver clock
/// samples.
///
/// A companion-app or remote seek halts the engine with the clock moved to the
/// target; an operator stop/pause leaves the clock where playback was. Absolute
/// `curpos` values are meaningless across a playlist, but a JUMP between two
/// consecutive samples is not, whatever the scale (entry-local ms, cumulative
/// ms, or the microseconds the firmware reports after a seek).
fn classify_stop(prev_curpos: u64, curpos: u64, end_pos: f64, len_ms: f64) -> StopCause {
    if prev_curpos == 0 {
        return StopCause::Operator;
    }
    let jumped = (curpos as f64 - prev_curpos as f64).abs() > SEEK_JUMP_MS;
    if !jumped {
        return StopCause::Operator;
    }
    // A zero clock is either a seek back to the very start or the restart at an
    // entry boundary; the position playback had reached separates them.
    if curpos == 0 {
        return if end_pos > 5000.0 {
            StopCause::Seek(0.0)
        } else {
            StopCause::Operator
        };
    }
    // A clock that wrapped at the end of the entry (the receiver's own loop
    // mode restarting the same entry) is a boundary, not a seek.
    let wrapped =
        len_ms > 0.0 && end_pos >= len_ms - NATURAL_END_MARGIN_MS && curpos < 5000;
    if wrapped {
        return StopCause::Operator;
    }
    match normalize_stop_curpos(curpos, prev_curpos, len_ms) {
        Some(local) if (local - end_pos).abs() > SEEK_JUMP_MS => StopCause::Seek(local),
        // A "jump" that lands back near where playback already was is not a
        // seek (entry transition, duplicate sample).
        Some(_) => StopCause::Operator,
        None => StopCause::SeekUnreadable,
    }
}

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
pub struct CastStatus {
    /// Device-reported player state: "play", "pause", or "stop".
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
    /// Full untrimmed DASH manifest of the currently cast track. Kept so a
    /// seek can re-serve a trimmed variant (A98 firmware cannot seek its own
    /// player; see AGENTS.md 5.3 and `trim_mpd`).
    pub manifest_xml: Option<String>,
    /// Offset in milliseconds into the ORIGINAL track timeline where the
    /// current push starts: 0 for a normal play, the seek target after a
    /// trimmed-manifest seek. Receiver-clock positions (`pos_ms`) count from
    /// the trimmed start, so wall position = start_offset_ms + pos_ms.
    pub start_offset_ms: f64,
    /// Full length of the cast track in milliseconds, captured while the
    /// push was untrimmed (`start_offset_ms == 0`). Natural-end detection
    /// compares the WALL position against this so a seek-trimmed push (whose
    /// device `totlen` may stay stale at the full length or drop to the
    /// trimmed remainder) still recognizes a genuine play-through.
    pub orig_totlen_ms: u64,
    /// Native playlist cast (A98 `.m3u8` queue): track ids in playlist order.
    /// Empty for a plain single-URL push. Entry boundaries are seamless, so
    /// the receiver never leaves "play" between tracks; `queue_index` follows
    /// it from the polled clock instead.
    pub queue: Vec<u64>,
    /// Playlist entries parallel to `queue`; a seek rebuilds the playlist from
    /// here (trimmed head + the remaining entries).
    pub queue_entries: Vec<QueueEntry>,
    /// Per-entry stream metadata with the manifests stripped, so a native
    /// advance can republish codec/quality to the UI with no TIDAL call.
    pub queue_streams: Vec<StreamInfo>,
    /// Display names (Artist - Title) parallel to `queue`, used for pushing
    /// track-specific named playlists on native advances.
    pub queue_titles: Vec<String>,
    /// Index of the entry the receiver is currently playing.
    pub queue_index: usize,
    /// Entry-local position at `queue_entry_anchor_at`, the wall-clock anchor
    /// for the entry playing now. The receiver's `curpos` is NOT a stable
    /// reference across a playlist (2026-11-01: it ran cumulatively through
    /// five album entries, then in a two-entry run switched to entry-local
    /// partway through the second entry), so entry-local position is carried
    /// by the wall clock and the device value is only adopted when it agrees.
    pub queue_entry_anchor_ms: f64,
    /// When `queue_entry_anchor_ms` was stamped; `None` while paused.
    pub queue_entry_anchor_at: Option<Instant>,
    /// Device-reported duration of the current entry (`totlen`); 0 until the
    /// receiver has loaded it. A change is the entry-transition signal.
    pub queue_entry_totlen_ms: u64,
    /// Receiver `curpos` from the previous poll, in whatever scale the
    /// firmware used for it. Kept ONLY to tell a receiver-side seek (the
    /// clock jumps) from an operator stop (the clock stays where it was):
    /// absolute values are not comparable across a playlist, but two
    /// consecutive samples are. Never used as a position.
    pub last_raw_curpos: u64,
}

/// One poll's worth of receiver observations.
pub struct PollOutcome {
    pub raw: PlayerStatusRaw,
    /// Un-commanded play-to-stop at the end of the cast (single track) or at
    /// the end of the playlist (queue cast).
    pub track_ended: bool,
    /// Volume (0-100) when the receiver reported a change.
    pub volume: Option<u64>,
    /// New playlist index when the receiver advanced natively to the next
    /// entry. `None` for plain casts and for polls without a boundary.
    pub advanced: Option<usize>,
    /// Target position in milliseconds if the receiver experienced an unexpected
    /// mid-stream stop (e.g. from an external seek on companion app/remote)
    /// that requires manifest-trim recovery.
    pub seek_recovery_ms: Option<f64>,
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
            manifest_xml: None,
            start_offset_ms: 0.0,
            orig_totlen_ms: 0,
            queue: Vec::new(),
            queue_entries: Vec::new(),
            queue_streams: Vec::new(),
            queue_titles: Vec::new(),
            queue_index: 0,
            queue_entry_anchor_ms: 0.0,
            queue_entry_anchor_at: None,
            queue_entry_totlen_ms: 0,
            last_raw_curpos: 0,
        }
    }

    /// True when this cast is a native playlist (`.m3u8` queue).
    pub fn is_queue(&self) -> bool {
        !self.queue.is_empty()
    }

    /// Track id the receiver is currently playing.
    pub fn current_track_id(&self) -> Option<u64> {
        self.queue.get(self.queue_index).copied()
    }

    /// True when the receiver is on the last playlist entry (the only place a
    /// queue cast can reach a natural end).
    pub fn on_last_entry(&self) -> bool {
        self.queue_index + 1 >= self.queue.len()
    }

    /// Wall position in milliseconds on the ORIGINAL track timeline.
    fn wall_pos_ms(&self) -> f64 {
        self.start_offset_ms + self.pos_ms
    }

    /// Reference full length in milliseconds for natural-end detection.
    /// Prefers the length captured while untrimmed; falls back to the
    /// device-reported totlen (correct for plain pushes and for trimmed
    /// pushes whose device picked up the manifest duration).
    fn full_len_ms(&self) -> f64 {
        if self.orig_totlen_ms > 0 {
            self.orig_totlen_ms as f64
        } else {
            self.totlen_ms as f64
        }
    }

    /// Position extrapolated to now. For a playlist entry that is the wall
    /// clock since the entry started (see `queue_entry_anchor_ms`); for a
    /// plain cast it is the last polled position (the device clock is
    /// authoritative there).
    fn live_pos_ms(&self) -> f64 {
        match self.queue_entry_anchor_at {
            Some(started) if self.is_queue() => {
                self.queue_entry_anchor_ms + started.elapsed().as_secs_f64() * 1000.0
            }
            _ => self.pos_ms,
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
            Some(s) => {
                // Clone-and-adjust instead of a field-by-field rebuild: the
                // playlist fields must survive a seek, and a literal here goes
                // stale every time a field is added.
                let mut next = s.clone();
                next.pos_ms = position_ms;
                next.anchor_ms = position_ms;
                next.anchor_at = Some(Instant::now());
                next
            }
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

    pub(crate) async fn expect_ok(&self, host: &str, command: &str) -> Result<(), String> {
        // First attempt plus one transparent retry: the receiver answers
        // push-priming windows with transient empty bodies (and the engine
        // can be too busy to apply a transport command at all). Callers of
        // pause/stop discard the error (`let _ =`), so an un-retried
        // transient left receiver/app state diverged: the app believed a
        // stop the engine never applied and the stream kept playing
        // (2026-10-24 smoke run). Everything routed through expect_ok is
        // idempotent, so one retry is safe; two attempts are bounded by
        // the 4 s raw timeout.
        match self.raw(host, command).await {
            Ok(body) if body.trim() == "OK" => Ok(()),
            first => {
                tokio::time::sleep(Duration::from_millis(600)).await;
                let body = match first {
                    Ok(body) => body,
                    Err(_) => self
                        .raw(host, command)
                        .await
                        .map_err(|e| format!("LinkPlay request failed ({})", e))?,
                };
                if body.trim() != "OK" {
                    return Err(format!(
                        "LinkPlay command rejected ({}): {}",
                        body.trim(),
                        command
                    ));
                }
                Ok(())
            }
        }
    }

    /// Operator stop with receiver-verify: the engine can acknowledge the
    /// stop (or ignore it inside a priming window) yet keep streaming the
    /// pushed URL. Up to three stop attempts, each followed by a short
    /// settle and a raw status read; `play`/`load` after the settle means
    /// the command did not take and is retried. A failing verify read is
    /// treated as inconclusive (no extra command storm).
    pub async fn stop_verified(
        &self,
        host: &str,
        status_slot: &RwLock<Option<CastStatus>>,
    ) -> Result<(), String> {
        const ATTEMPTS: u8 = 3;
        for attempt in 1..=ATTEMPTS {
            self.stop(host, status_slot).await?;
            tokio::time::sleep(Duration::from_millis(900)).await;
            match self.raw(host, "getPlayerStatus").await {
                Ok(body) => {
                    let playing = serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|v| {
                            v.get("status")
                                .and_then(|s| s.as_str().map(|s| s == "play" || s == "load"))
                        })
                        .unwrap_or(false);
                    if !playing {
                        return Ok(());
                    }
                    log::debug!(
                        "[linkplay] stop attempt {} not applied (receiver {})",
                        attempt,
                        if playing { "still playing" } else { "?" }
                    );
                }
                Err(_) => return Ok(()),
            }
        }
        log::warn!(
            "[linkplay] receiver ignored stop after {} attempts; state may be diverged",
            ATTEMPTS
        );
        Ok(())
    }

    /// One status poll; updates the extrapolation state machine in `slot` and
    /// returns the observed state plus the transition signals the caller
    /// reports to the UI: a natural end (`track_ended`), a native playlist
    /// advance (`advanced`), and a device volume change (`volume`).
    pub async fn poll(
        &self,
        host: &str,
        slot: &RwLock<Option<CastStatus>>,
    ) -> Result<PollOutcome, String> {
        let body = self
            .raw(host, "getPlayerStatus")
            .await
            .map_err(|e| format!("LinkPlay status request failed: {}", e))?;
        let raw: PlayerStatusRaw = serde_json::from_str(&body)
            .map_err(|e| format!("LinkPlay status parse failed: {} body={}", e, body))?;

        let mut slot_guard = slot.write().await;
        let mut volume = None;
        let mut advanced = None;
        // True on the poll that confirmed a fresh push. The receiver's clock
        // legitimately restarts then, so it must not be mistaken for a
        // receiver-side skip below.
        let mut just_started = false;
        if let Some(cur) = slot_guard.as_mut() {
            // Previous receiver clock sample, for the seek-vs-stop decision
            // below (`SEEK_JUMP_MS`). Sampled before any branch so every path
            // leaves it current.
            let prev_curpos = cur.last_raw_curpos;
            cur.last_raw_curpos = raw.curpos;
            let new_status = raw.status.clone();
            if cur.status != new_status {
                if new_status == "play" {
                    // Clock restart: extrapolation resumes from anchor_ms.
                    cur.anchor_at = Some(Instant::now());
                    // A playlist entry carries its own clock: it starts at
                    // zero for a NEW push (push, jam re-push, advance re-push)
                    // and resumes from the frozen anchor after a pause or an
                    // operator stop. `play_confirmed` is the discriminator:
                    // every push path clears it, and only a real start sets it.
                    let fresh_push = !cur.play_confirmed;
                    cur.play_confirmed = true;
                    just_started = fresh_push;
                    if cur.is_queue() {
                        if (cur.status == "stop" || cur.status == "load") && fresh_push {
                            cur.queue_entry_anchor_ms = 0.0;
                            cur.pos_ms = 0.0;
                        }
                        cur.queue_entry_anchor_at = Some(Instant::now());
                    }
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
                    let end_pos = cur.live_pos_ms();
                    // A playlist entry's position rides its own wall anchor, so
                    // freeze that one instead of the single-track anchor.
                    if cur.is_queue() {
                        cur.queue_entry_anchor_ms = end_pos;
                        cur.queue_entry_anchor_at = None;
                        cur.pos_ms = end_pos;
                    }
                    // A companion-app seek lands in "pause" on this firmware as
                    // readily as in "stop" (2026-11-08: mobile-app seek paused
                    // the engine, nothing recovered it, and the operator's play
                    // restarted the track). Same jump signal as the stop paths;
                    // an ordinary pause does not move the device clock.
                    let len_ms = if cur.is_queue() {
                        cur.queue_entry_totlen_ms as f64
                    } else {
                        cur.full_len_ms()
                    };
                    let target = match classify_stop(prev_curpos, raw.curpos, end_pos, len_ms) {
                        // An explicit target may legitimately be 0 (a seek back
                        // to the start); only the fallback position is rejected
                        // when unknown.
                        StopCause::Seek(local) => Some(cur.start_offset_ms + local),
                        StopCause::SeekUnreadable => {
                            Some(cur.start_offset_ms + end_pos).filter(|t| *t > 0.0)
                        }
                        StopCause::Operator => None,
                    };
                    if let Some(target_pos) = target {
                        log::info!(
                            "[cast-poller] receiver paused at a seek target {:.1}s; recovering",
                            target_pos / 1000.0
                        );
                        // Record the transition so a failed recovery does not
                        // re-enter this branch on every poll.
                        cur.status = new_status;
                        return Ok(PollOutcome {
                            raw,
                            track_ended: false,
                            volume,
                            advanced: None,
                            seek_recovery_ms: Some(target_pos),
                        });
                    }
                } else if new_status == "stop" && cur.status == "play" {
                    if cur.stop_commanded {
                        cur.stop_commanded = false;
                    } else if cur.is_queue() {
                        // Playlist cast: entry boundaries are seamless, so the
                        // receiver only stops at the END of the playlist. A
                        // stop mid-playlist is an operator stop (or a jam) and
                        // never advances the app's queue.
                        let end_pos = cur.live_pos_ms();
                        if cur.on_last_entry()
                            && cur.totlen_ms > 0
                            && end_pos >= cur.totlen_ms as f64 - NATURAL_END_MARGIN_MS
                        {
                            *slot_guard = None;
                            return Ok(PollOutcome {
                                raw,
                                track_ended: true,
                                volume,
                                advanced: None,
                                seek_recovery_ms: None,
                            });
                        }
                        // Freeze the entry clock at the stop position.
                        cur.queue_entry_anchor_ms = end_pos;
                        cur.queue_entry_anchor_at = None;
                        // Seek or operator stop? A companion-app seek halts
                        // the engine in "stop" with the clock moved to the
                        // target; an operator stop halts it where it was
                        // playing. Absolute values cannot separate them
                        // (`curpos` may be entry-local or cumulative), but a
                        // JUMP between two consecutive samples can, whatever
                        // the scale.
                        let entry_len = cur.queue_entry_totlen_ms as f64;
                        let cause =
                            classify_stop(prev_curpos, raw.curpos, end_pos, entry_len);
                        if let StopCause::SeekUnreadable = cause {
                            log::warn!(
                                "[cast-poller] seek target {}ms is not local to entry {}/{} ({:.0}ms); resuming at the wall position",
                                raw.curpos,
                                cur.queue_index + 1,
                                cur.queue.len(),
                                entry_len
                            );
                        }
                        let target = match cause {
                            StopCause::Seek(local) => Some(cur.start_offset_ms + local),
                            StopCause::SeekUnreadable => {
                                Some(cur.start_offset_ms + end_pos).filter(|t| *t > 0.0)
                            }
                            StopCause::Operator => None,
                        };
                        log::debug!(
                            "[cast-poller] mid-playlist stop at entry {}/{} ({:.1}/{:.1}s, curpos={} prev={}, {})",
                            cur.queue_index + 1,
                            cur.queue.len(),
                            end_pos / 1000.0,
                            cur.totlen_ms as f64 / 1000.0,
                            raw.curpos,
                            prev_curpos,
                            if target.is_some() { "receiver seek" } else { "operator stop" }
                        );
                        if let Some(target_pos) = target {
                            // Record the transition: if the recovery push fails
                            // the engine stays stopped, and a stale "play" here
                            // would re-fire this edge on every poll.
                            cur.status = new_status;
                            return Ok(PollOutcome {
                                raw,
                                track_ended: false,
                                volume,
                                advanced: None,
                                seek_recovery_ms: Some(target_pos),
                            });
                        }
                        // Operator stop: leave the engine stopped and fall
                        // through so `status` records "stop" (pre-2026-11-08
                        // behaviour). Returning here would leave a stale
                        // "play" status re-firing this edge on every poll.
                    } else if cur.full_len_ms() > 0.0
                        && cur.wall_pos_ms() >= cur.full_len_ms() - NATURAL_END_MARGIN_MS
                    {
                        // Natural end at the track boundary: report and drop
                        // the cast position. Wall position vs the ORIGINAL
                        // length so a seek-trimmed push (receiver clock
                        // renumbered from the trim offset) still lands here.
                        *slot_guard = None;
                        return Ok(PollOutcome {
                            raw,
                            track_ended: true,
                            volume,
                            advanced: None,
                            seek_recovery_ms: None,
                        });
                    } else {
                        // Stop far from the track boundary: an operator stop
                        // on the receiver itself, or an external seek stop on
                        // single track casts. Same seek signal as the playlist
                        // branch: a jump in the receiver's own clock.
                        let end_pos = cur.pos_ms;
                        let full_len = cur.full_len_ms();
                        let cause = classify_stop(prev_curpos, raw.curpos, end_pos, full_len);
                        if let StopCause::SeekUnreadable = cause {
                            log::warn!(
                                "[cast-poller] seek target {}ms is not local to the track ({:.0}ms); resuming at the wall position",
                                raw.curpos,
                                full_len
                            );
                        }
                        let target = match cause {
                            StopCause::Seek(local) => Some(cur.start_offset_ms + local),
                            StopCause::SeekUnreadable => {
                                Some(cur.start_offset_ms + end_pos).filter(|t| *t > 0.0)
                            }
                            StopCause::Operator => None,
                        };
                        log::debug!(
                            "[cast-poller] mid-track stop at {:.1}/{:.1}s (curpos={} prev={}, {})",
                            cur.wall_pos_ms() / 1000.0,
                            full_len / 1000.0,
                            raw.curpos,
                            prev_curpos,
                            if target.is_some() { "receiver seek" } else { "operator stop" }
                        );
                        if let Some(target_pos) = target {
                            cur.status = new_status;
                            return Ok(PollOutcome {
                                raw,
                                track_ended: false,
                                volume,
                                advanced: None,
                                seek_recovery_ms: Some(target_pos),
                            });
                        }
                    }
                }
                cur.status = new_status;
            }
            if cur.status == "play" {
                if cur.is_queue() {
                    // Native playlist: the receiver plays entry to entry with
                    // no stop and no gap, and reports only `totlen` for the
                    // entry playing now (`curpos` is not a dependable
                    // reference - see `queue_entry_anchor_ms`). So:
                    // - entry-local position comes from the wall clock since
                    //   the entry started, corrected by the device clock when
                    //   that clock agrees with it (then it is more precise);
                    // - the boundary is that entry's own length, not an
                    //   accumulated offset;
                    // - `totlen` swapping to the next entry's length is the
                    //   hint that the boundary is near (measured ~37 s early
                    //   in one run, so it only counts once the length is
                    //   actually used up).
                    let mut pos = cur.live_pos_ms();
                    let curpos = raw.curpos as f64;
                    let device_is_entry_local = raw.totlen > 0
                        && curpos <= raw.totlen as f64 + 1000.0
                        && (curpos - pos).abs() < 5000.0;
                    if device_is_entry_local {
                        pos = curpos;
                        cur.queue_entry_anchor_ms = pos;
                        cur.queue_entry_anchor_at = Some(Instant::now());
                    }
                    let entry_len = cur.queue_entry_totlen_ms as f64;
                    let swapped = raw.totlen > 0 && raw.totlen != cur.queue_entry_totlen_ms;
                    let used_up = entry_len > 0.0 && pos >= entry_len - 500.0;
                    // Equal-duration neighbours never change `totlen`, so a
                    // clock that has plainly run past the entry proves the
                    // change on its own.
                    let overran = entry_len > 0.0 && pos >= entry_len + 2000.0;
                    // A skip from the receiver's own UI (WiiM Home next, or the
                    // hardware remote) restarts the entry clock; a `totlen`
                    // swap alone is only a hint (equal-duration neighbours never
                    // produce one, and a seek re-push produces one with a fresh
                    // clock too), so the clock restart is the signal. Guarded
                    // against a fresh push (its clock legitimately restarts),
                    // against the first seconds of an entry, and against a wrap
                    // at the entry's own end (receiver loop mode), which is a
                    // boundary, not a skip.
                    let clock_restart = prev_curpos > 5000
                        && (raw.curpos as f64) + SEEK_JUMP_MS < prev_curpos as f64;
                    let at_entry_end =
                        entry_len > 0.0 && pos >= entry_len - NATURAL_END_MARGIN_MS;
                    let manual_skip = !just_started
                        && pos > 3000.0
                        && !at_entry_end
                        && clock_restart;
                    if !cur.on_last_entry() && ((swapped && used_up) || manual_skip || overran) {
                        let previous_len = cur.queue_entry_totlen_ms;
                        cur.queue_index += 1;
                        cur.pos_ms = 0.0;
                        cur.queue_entry_anchor_ms = 0.0;
                        cur.queue_entry_anchor_at = Some(Instant::now());
                        // Take the swapped length as the new entry's length;
                        // an equal-duration neighbour keeps the old one.
                        cur.queue_entry_totlen_ms = if raw.totlen > 0 && raw.totlen != previous_len
                        {
                            raw.totlen
                        } else {
                            0
                        };
                        // The seek path trims the CURRENT entry's manifest;
                        // keep the stash pointing at the entry on screen.
                        cur.manifest_xml = cur
                            .queue_entries
                            .get(cur.queue_index)
                            .and_then(|e| e.manifest())
                            .map(|xml| xml.to_string());
                        cur.start_offset_ms = 0.0;
                        advanced = Some(cur.queue_index);
                    } else {
                        cur.pos_ms = pos;
                    }
                    if cur.queue_entry_totlen_ms == 0 && raw.totlen > 0 {
                        cur.queue_entry_totlen_ms = raw.totlen;
                    }
                } else if raw.totlen > 0 && raw.curpos > raw.totlen.saturating_mul(2) {
                    // The device's curpos is in ms and advances correctly until a
                    // seek happens, after which it switches to microseconds (and
                    // freezes). A curpos beyond twice the track length is that
                    // broken post-seek scale; extrapolate locally instead.
                    if let Some(started) = cur.anchor_at {
                        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
                        cur.pos_ms = cur.anchor_ms + elapsed;
                    }
                } else {
                    cur.pos_ms = raw.curpos as f64;
                }
            } else if cur.is_queue() {
                // Queue cast: `anchor_ms` belongs to the single-track path and
                // is never maintained here, so using it would snap the reported
                // position back to zero on every pause or operator stop. Freeze
                // the entry clock where the engine actually stopped (a commanded
                // stop does not freeze it earlier) and report that.
                let frozen = cur.live_pos_ms();
                cur.queue_entry_anchor_ms = frozen;
                cur.queue_entry_anchor_at = None;
                cur.pos_ms = frozen;
            } else {
                cur.pos_ms = cur.anchor_ms;
            }
            cur.totlen_ms = raw.totlen;
            // Capture the full length for a currently-untrimmed cast. Gated
            // on an already-confirmed play so the pre-stash race around a
            // seek-trim push (slot freshly reset, start_offset not yet
            // re-applied) cannot stamp the reference with a stale or trimmed
            // device register. A playlist cast reports per-entry lengths, so
            // its reference lives in `queue_entry_*` instead.
            if cur.play_confirmed && cur.start_offset_ms == 0.0 && !cur.is_queue() {
                cur.orig_totlen_ms = raw.totlen;
            }
            volume = if cur.last_vol != raw.vol {
                cur.last_vol = raw.vol;
                Some(raw.vol)
            } else {
                None
            };
        }
        Ok(PollOutcome {
            raw,
            track_ended: false,
            volume,
            advanced,
            seek_recovery_ms: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_stop, normalize_stop_curpos, StopCause};

    /// Receiver clocks arrive in three scales; only the two that are local to
    /// the current push may become a trim offset (2026-11-01 cumulative clock,
    /// 2026-10-23 microseconds-after-seek).
    #[test]
    fn normalizes_stop_curpos_scales() {
        // Entry-local milliseconds: the normal case.
        assert_eq!(
            normalize_stop_curpos(36_000, 35_000, 196_000.0),
            Some(36_000.0)
        );
        // Microseconds after a firmware seek (target x 1000): the previous
        // sample was still a plausible millisecond value.
        assert_eq!(
            normalize_stop_curpos(30_000_000, 29_000, 196_000.0),
            Some(30_000.0)
        );
        // Cumulative across a playlist: out of range before AND after, so it
        // is never mistaken for a microsecond sample.
        assert_eq!(normalize_stop_curpos(784_000, 783_000, 196_000.0), None);
        assert_eq!(normalize_stop_curpos(600_000, 599_000, 196_000.0), None);
        // No sample, or no known length.
        assert_eq!(normalize_stop_curpos(0, 35_000, 196_000.0), None);
        assert_eq!(normalize_stop_curpos(36_000, 35_000, 0.0), None);
        // A target inside the poll-skew margin is still local.
        assert_eq!(
            normalize_stop_curpos(197_000, 196_000, 196_000.0),
            Some(197_000.0)
        );
    }

    /// The seek-vs-operator decision that drives recovery (2026-11-08).
    #[test]
    fn classifies_stop_and_pause_causes() {
        // Operator stop mid-entry: the clock did not move.
        assert!(matches!(
            classify_stop(60_000, 60_400, 60_000.0, 196_000.0),
            StopCause::Operator
        ));
        // Companion-app seek backward: the firmware reports the target in
        // microseconds, so the sample jumps by orders of magnitude.
        match classify_stop(120_000, 30_000_000, 120_000.0, 196_000.0) {
            StopCause::Seek(local) => assert_eq!(local, 30_000.0),
            _ => panic!("expected a usable seek target"),
        }
        // Seek forward, reported in milliseconds.
        match classify_stop(30_000, 120_000, 30_000.0, 196_000.0) {
            StopCause::Seek(local) => assert_eq!(local, 120_000.0),
            _ => panic!("expected a usable seek target"),
        }
        // Cumulative clock after a seek: a jump, but no usable local target.
        assert!(matches!(
            classify_stop(120_000, 784_000_000, 120_000.0, 196_000.0),
            StopCause::SeekUnreadable
        ));
        // Clock wrap at the entry's own end (receiver loop mode): a boundary.
        assert!(matches!(
            classify_stop(76_000, 800, 76_000.0, 77_000.0),
            StopCause::Operator
        ));
        // A seek back to the very start reports a zero clock; far from the
        // entry start it is a seek, near it, it is a boundary restart.
        match classify_stop(60_000, 0, 60_000.0, 196_000.0) {
            StopCause::Seek(local) => assert_eq!(local, 0.0),
            _ => panic!("expected a seek to the start"),
        }
        assert!(matches!(
            classify_stop(76_000, 0, 1_200.0, 196_000.0),
            StopCause::Operator
        ));
        // First sample of a push: nothing to compare against.
        assert!(matches!(
            classify_stop(0, 30_000_000, 0.0, 196_000.0),
            StopCause::Operator
        ));
    }
}
