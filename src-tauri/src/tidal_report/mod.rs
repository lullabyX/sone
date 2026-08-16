//! Reports completed plays to TIDAL's Event Producer so they appear in the
//! user's TIDAL Recently Played. On by default; users can disable it in
//! Settings. Hooks the same playback lifecycle as the scrobble manager and
//! emits one `playback_session` event per play that meets the listen
//! threshold. Private, undocumented endpoint — the same posture as SONE's
//! existing streaming calls; best-effort, may not surface.

mod event;
mod queue;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use crate::crypto::Crypto;
use event::{SendOutcome, SessionEvent, SourceType};
use queue::ReportQueue;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Actual stream attributes captured at resolve time, consumed at track start.
#[derive(Clone)]
pub struct StreamMeta {
    pub actual_product_id: Option<u64>,
    pub quality: String,
    pub audio_mode: String,
    pub presentation: String,
    pub at_ms: i64,
}

impl Default for StreamMeta {
    fn default() -> Self {
        Self {
            actual_product_id: None,
            quality: "LOSSLESS".into(),
            audio_mode: "STEREO".into(),
            presentation: "FULL".into(),
            at_ms: 0,
        }
    }
}

/// Live accounting for the currently-playing track.
struct PlaySession {
    session_id: String,
    requested_product_id: u64,
    duration_secs: u32,
    meta: StreamMeta,
    source: Option<(SourceType, String)>,
    started_at_ms: i64,
    accumulated_secs: f64,
    last_resumed_at: Option<Instant>,
    reported: bool,
}

impl PlaySession {
    fn new(
        track_id: u64,
        duration_secs: u32,
        meta: StreamMeta,
        source: Option<(SourceType, String)>,
    ) -> Self {
        Self {
            session_id: uuid::Uuid::new_v4().to_string(),
            requested_product_id: track_id,
            duration_secs,
            meta,
            source,
            started_at_ms: now_ms(),
            accumulated_secs: 0.0,
            last_resumed_at: Some(Instant::now()),
            reported: false,
        }
    }

    fn elapsed(&self) -> f64 {
        self.accumulated_secs
            + self
                .last_resumed_at
                .map(|t| t.elapsed().as_secs_f64())
                .unwrap_or(0.0)
    }

    fn pause(&mut self) {
        if let Some(t) = self.last_resumed_at.take() {
            self.accumulated_secs += t.elapsed().as_secs_f64();
        }
    }

    fn resume(&mut self) {
        if self.last_resumed_at.is_none() {
            self.last_resumed_at = Some(Instant::now());
        }
    }

    fn on_seek(&mut self) {
        // Fold live time; restart the timer only if currently playing.
        if let Some(t) = self.last_resumed_at.take() {
            self.accumulated_secs += t.elapsed().as_secs_f64();
            self.last_resumed_at = Some(Instant::now());
        }
    }

    /// TIDAL's own rule: a play over 30 seconds counts as a stream.
    fn meets_threshold(&self) -> bool {
        self.elapsed() >= 30.0
    }

    fn to_event(&self, natural_end: bool) -> SessionEvent {
        let dur = self.duration_secs as f64;
        let end_pos = if natural_end {
            dur
        } else {
            self.elapsed().min(dur)
        };
        SessionEvent {
            session_id: self.session_id.clone(),
            requested_product_id: self.requested_product_id,
            actual_product_id: self
                .meta
                .actual_product_id
                .map(|i| i.to_string())
                .unwrap_or_else(|| self.requested_product_id.to_string()),
            quality: self.meta.quality.clone(),
            audio_mode: self.meta.audio_mode.clone(),
            presentation: self.meta.presentation.clone(),
            source: self.source.clone(),
            start_ts_ms: self.started_at_ms,
            end_ts_ms: now_ms(),
            end_asset_pos: end_pos,
        }
    }
}

pub struct TidalReporter {
    enabled: AtomicBool,
    app_handle: AppHandle,
    current: Mutex<Option<PlaySession>>,
    pending_meta: Mutex<HashMap<u64, StreamMeta>>,
    queue: ReportQueue,
    http: std::sync::Mutex<reqwest::Client>,
}

impl TidalReporter {
    pub fn new(
        app_handle: AppHandle,
        crypto: Arc<Crypto>,
        config_dir: &Path,
        http: reqwest::Client,
        enabled: bool,
    ) -> Self {
        Self {
            enabled: AtomicBool::new(enabled),
            app_handle,
            current: Mutex::new(None),
            pending_meta: Mutex::new(HashMap::new()),
            queue: ReportQueue::new(&config_dir.join("tidal_report_queue.bin"), crypto),
            http: std::sync::Mutex::new(http),
        }
    }

    fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::Relaxed);
    }

    pub fn update_http_client(&self, client: reqwest::Client) {
        *self.http.lock().unwrap() = client;
    }

    pub async fn queue_size(&self) -> usize {
        self.queue.len().await
    }

    // --- Stream metadata ---------------------------------------------------

    /// Record the actual served attributes for a track, keyed by id, to attach
    /// when it becomes current. Called from the stream resolver.
    pub async fn note_stream_resolved(&self, track_id: u64, meta: StreamMeta) {
        if !self.enabled() {
            return;
        }
        let mut pm = self.pending_meta.lock().await;
        pm.insert(track_id, meta);
        if pm.len() > 16 {
            if let Some(oldest) = pm.iter().min_by_key(|(_, m)| m.at_ms).map(|(&k, _)| k) {
                pm.remove(&oldest);
            }
        }
    }

    // --- Lifecycle ---------------------------------------------------------

    pub async fn on_track_started(
        &self,
        track_id: Option<u64>,
        duration_secs: u32,
        source: Option<(String, String)>,
    ) {
        if !self.enabled() {
            log::debug!("tidal-report: track {track_id:?} started, but reporting is OFF");
            return;
        }
        // Dispatch the displaced track (manual skip case; natural end / gapless
        // already fired via try_finish and left `reported` set).
        let prev = {
            let mut cur = self.current.lock().await;
            match cur.take() {
                Some(s) => self.close_for_report(s, false, "displaced"),
                None => None,
            }
        };
        if let Some(ev) = prev {
            self.dispatch(ev).await;
        }

        let Some(tid) = track_id else {
            *self.current.lock().await = None;
            return;
        };
        let meta = self
            .pending_meta
            .lock()
            .await
            .remove(&tid)
            .unwrap_or_default();
        let src = source.and_then(|(t, id)| SourceType::from_sone(&t).map(|st| (st, id)));
        log::debug!(
            "tidal-report: now tracking track={tid} dur={duration_secs}s source={}",
            src.as_ref()
                .map(|(t, id)| format!("{}/{}", t.as_tidal(), id))
                .unwrap_or_else(|| "<none>".into())
        );
        *self.current.lock().await = Some(PlaySession::new(tid, duration_secs, meta, src));
    }

    /// Decide whether a closed session should be reported, logging the reason.
    fn close_for_report(
        &self,
        s: PlaySession,
        natural_end: bool,
        ctx: &str,
    ) -> Option<SessionEvent> {
        if s.reported {
            return None;
        }
        if !s.meets_threshold() {
            log::debug!(
                "tidal-report: NOT reporting track={} ({ctx}): played {:.0}s — under the 30s threshold",
                s.requested_product_id,
                s.elapsed()
            );
            return None;
        }
        Some(s.to_event(natural_end))
    }

    pub async fn on_pause(&self) {
        if !self.enabled() {
            return;
        }
        if let Some(s) = self.current.lock().await.as_mut() {
            s.pause();
        }
    }

    pub async fn on_resume(&self) {
        if !self.enabled() {
            return;
        }
        if let Some(s) = self.current.lock().await.as_mut() {
            s.resume();
        }
    }

    pub async fn on_seek(&self) {
        if !self.enabled() {
            return;
        }
        if let Some(s) = self.current.lock().await.as_mut() {
            s.on_seek();
        }
    }

    /// Natural end / gapless advance: dispatch but keep the session (guard against
    /// a duplicate stale EOS), marking it reported so nothing re-sends it.
    pub async fn try_finish(&self) {
        if !self.enabled() {
            return;
        }
        let ev = {
            let mut cur = self.current.lock().await;
            match cur.as_mut() {
                Some(s) if s.reported => None,
                Some(s) if !s.meets_threshold() => {
                    log::debug!(
                        "tidal-report: NOT reporting track={} (finished): played {:.0}s — under the 30s threshold",
                        s.requested_product_id,
                        s.elapsed()
                    );
                    None
                }
                Some(s) => {
                    s.reported = true;
                    Some(s.to_event(true))
                }
                None => None,
            }
        };
        if let Some(ev) = ev {
            self.dispatch(ev).await;
        }
    }

    pub async fn on_track_stopped(&self) {
        if !self.enabled() {
            return;
        }
        let ev = {
            let mut cur = self.current.lock().await;
            match cur.take() {
                Some(s) => self.close_for_report(s, false, "stopped"),
                None => None,
            }
        };
        if let Some(ev) = ev {
            self.dispatch(ev).await;
        }
    }

    /// Logout: drop everything pending.
    pub async fn clear(&self) {
        *self.current.lock().await = None;
        self.pending_meta.lock().await.clear();
        self.queue.clear().await;
    }

    /// Shutdown: send the in-flight session synchronously (short timeout) and
    /// persist the queue.
    pub async fn flush(&self) {
        if self.enabled() {
            let ev = {
                let mut cur = self.current.lock().await;
                cur.take()
                    .filter(|s| !s.reported && s.meets_threshold())
                    .map(|s| s.to_event(false))
            };
            if let Some(ev) = ev {
                if let Some(body) = self.build_body(&ev).await {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(2),
                        self.post_events(vec![(body, 0)]),
                    )
                    .await;
                }
            }
        }
        self.queue.flush().await;
    }

    /// Startup / on-enable: flush the offline outbox.
    pub async fn drain_queue(&self) {
        if !self.enabled() {
            return;
        }
        let mut remaining = self.queue.len().await;
        while remaining > 0 {
            let batch = self.queue.take_batch(event::MAX_BATCH).await;
            if batch.is_empty() {
                break;
            }
            let took = batch.len();
            self.post_events(batch).await;
            remaining = remaining.saturating_sub(took);
        }
    }

    // --- Sending -----------------------------------------------------------

    /// Snapshot (access_token, oauth_client_id) from the TIDAL client without
    /// holding the lock across any network I/O.
    async fn token_snapshot(&self) -> Option<(String, String)> {
        let state = self.app_handle.state::<crate::AppState>();
        let client = state.tidal_client.lock().await;
        client
            .tokens
            .as_ref()
            .map(|t| (t.access_token.clone(), client.client_id.clone()))
    }

    async fn refresh_snapshot(&self) -> Option<(String, String)> {
        let state = self.app_handle.state::<crate::AppState>();
        let mut client = state.tidal_client.lock().await;
        match client.refresh_token().await {
            Ok(_) => client
                .tokens
                .as_ref()
                .map(|t| (t.access_token.clone(), client.client_id.clone())),
            Err(e) => {
                log::debug!("tidal-report: token refresh failed: {e}");
                None
            }
        }
    }

    /// Build a frozen MessageBody for an event using current JWT claims.
    async fn build_body(&self, ev: &SessionEvent) -> Option<String> {
        let (access_token, _) = self.token_snapshot().await?;
        let claims = event::parse_claims(&access_token);
        Some(event::build_body(ev, &claims))
    }

    /// Build the body inline (fast), then send in the background so lifecycle
    /// hooks never block on the network.
    async fn dispatch(&self, ev: SessionEvent) {
        log::debug!(
            "tidal-report: reporting play track={} source={}",
            ev.requested_product_id,
            ev.source
                .as_ref()
                .map(|(t, id)| format!("{}/{}", t.as_tidal(), id))
                .unwrap_or_else(|| "<none>".into())
        );
        let Some(body) = self.build_body(&ev).await else {
            log::warn!(
                "tidal-report: no TIDAL token — cannot report track={}",
                ev.requested_product_id
            );
            return;
        };
        let handle = self.app_handle.clone();
        tauri::async_runtime::spawn(async move {
            let state = handle.state::<crate::AppState>();
            state.tidal_reporter.post_events(vec![(body, 0)]).await;
        });
    }

    /// POST a batch (bodies with prior attempt counts); requeue/drop on failure.
    async fn post_events(&self, items: Vec<(String, u32)>) {
        if items.is_empty() {
            return;
        }
        let bodies: Vec<String> = items.iter().map(|(b, _)| b.clone()).collect();

        let Some((access_token, client_id)) = self.token_snapshot().await else {
            self.queue.requeue(items).await;
            return;
        };

        match self.try_post(&bodies, &access_token, &client_id).await {
            SendOutcome::Accepted => {
                log::debug!(
                    "tidal-report: {} event(s) accepted by ec.tidal.com",
                    bodies.len()
                )
            }
            SendOutcome::SenderFault => {
                log::warn!(
                    "tidal-report: {} event(s) rejected (SenderFault), dropping",
                    bodies.len()
                );
            }
            SendOutcome::Retryable => self.queue.requeue(items).await,
            SendOutcome::AuthFailed => {
                if let Some((token, cid)) = self.refresh_snapshot().await {
                    match self.try_post(&bodies, &token, &cid).await {
                        SendOutcome::Accepted => {}
                        SendOutcome::SenderFault => {
                            log::warn!("tidal-report: rejected after refresh, dropping");
                        }
                        _ => self.queue.requeue(items).await,
                    }
                } else {
                    self.queue.requeue(items).await;
                }
            }
        }
    }

    async fn try_post(
        &self,
        bodies: &[String],
        access_token: &str,
        client_id: &str,
    ) -> SendOutcome {
        let now = now_ms();
        let events: Vec<(String, String)> = bodies
            .iter()
            .map(|b| {
                (
                    b.clone(),
                    event::build_headers(client_id, access_token, now),
                )
            })
            .collect();
        let form = event::sqs_form(&events);
        let http = self.http.lock().unwrap().clone();

        let send = http
            .post(event::EC_URL)
            .header("Authorization", format!("Bearer {access_token}"))
            .form(&form)
            .send();
        match tokio::time::timeout(Duration::from_secs(10), send).await {
            Ok(Ok(resp)) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                log::debug!("tidal-report: POST {} -> {status}", event::EC_URL);
                event::classify(status, &body)
            }
            Ok(Err(e)) => {
                log::debug!("tidal-report: POST failed: {e}");
                SendOutcome::Retryable
            }
            Err(_) => {
                log::debug!("tidal-report: POST timed out");
                SendOutcome::Retryable
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(duration_secs: u32, played_secs: f64) -> PlaySession {
        PlaySession {
            session_id: "s".into(),
            requested_product_id: 1,
            duration_secs,
            meta: StreamMeta::default(),
            source: None,
            started_at_ms: 0,
            accumulated_secs: played_secs,
            last_resumed_at: None, // elapsed() == accumulated_secs
            reported: false,
        }
    }

    #[test]
    fn threshold_is_flat_30_seconds() {
        // TIDAL's rule: a play over 30 seconds counts, regardless of track length.
        assert!(session(200, 30.0).meets_threshold()); // exactly 30s
        assert!(session(200, 45.0).meets_threshold()); // 45s of a 3-min track (would fail the old 50% rule)
        assert!(session(1000, 30.0).meets_threshold()); // 30s of a long track
        assert!(!session(200, 29.0).meets_threshold()); // under 30s
        assert!(!session(25, 25.0).meets_threshold()); // 25s track played fully = 25s
    }

    #[test]
    fn end_position_clamps_and_natural_end_is_full() {
        // Overshoot clamps to duration on a manual close.
        let ev = session(200, 500.0).to_event(false);
        assert_eq!(ev.end_asset_pos, 200.0);
        // Natural end reports the full duration.
        let ev = session(200, 100.0).to_event(true);
        assert_eq!(ev.end_asset_pos, 200.0);
    }

    #[test]
    fn pause_excludes_paused_time_from_elapsed() {
        let mut s = session(200, 10.0);
        s.resume(); // start counting
        s.pause(); // fold live (~0s) back
        let e = s.elapsed();
        assert!((e - 10.0).abs() < 1.0, "elapsed drifted: {e}");
    }
}
