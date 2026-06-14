pub mod event;
pub mod session;

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use serde_json::Value;
use tokio::sync::Mutex;

use session::{PlaybackSession, SessionParams};

/// Inputs the frontend supplies when a track starts.
pub struct StartParams {
    pub session_id: String,
    pub product_id: String,
    pub quality: String,
    pub source_type: Option<String>,
    pub source_id: Option<String>,
    pub duration_secs: u32,
}

pub struct PlaybackReporter {
    current: Mutex<Option<PlaybackSession>>,
    enabled: AtomicBool,
}

impl PlaybackReporter {
    pub fn new(enabled: bool) -> Self {
        Self { current: Mutex::new(None), enabled: AtomicBool::new(enabled) }
    }

    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::Relaxed);
    }

    fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Finalize the previous session (if any) and open a new one.
    /// Returns the previous session's `playback_session` payload to POST.
    pub async fn on_track_started(&self, p: StartParams) -> Option<Value> {
        if !self.is_enabled() {
            *self.current.lock().await = None;
            return None;
        }
        if p.session_id.is_empty() {
            *self.current.lock().await = None;
            return None;
        }
        let mut current = self.current.lock().await;
        let prev = current.as_mut().map(|s| s.finalize());
        *current = Some(PlaybackSession::new(SessionParams {
            session_id: p.session_id,
            product_id: p.product_id,
            quality: p.quality,
            source_type: p.source_type,
            source_id: p.source_id,
            duration_secs: p.duration_secs,
            start_ms: crate::now_millis(),
            start_instant: Instant::now(),
        }));
        prev
    }

    pub async fn on_pause(&self) {
        if let Some(s) = self.current.lock().await.as_mut() { s.pause(); }
    }

    pub async fn on_resume(&self) {
        if let Some(s) = self.current.lock().await.as_mut() { s.resume(); }
    }

    /// Finalize and clear the current session (explicit stop / app exit).
    pub async fn on_track_stopped(&self) -> Option<Value> {
        self.current.lock().await.take().map(|mut s| s.finalize())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn started_then_started_finalizes_previous() {
        let r = PlaybackReporter::new(true);
        assert!(r.on_track_started(params("s1", "100")).await.is_none());
        let prev = r.on_track_started(params("s2", "200")).await;
        let prev = prev.expect("should finalize previous session");
        assert_eq!(prev["playbackSessionId"], "s1");
        assert_eq!(prev["actualProductId"], "100");
    }

    #[tokio::test]
    async fn disabled_reporter_emits_nothing() {
        let r = PlaybackReporter::new(false);
        assert!(r.on_track_started(params("s1", "100")).await.is_none());
        assert!(r.on_track_stopped().await.is_none());
    }

    fn params(sid: &str, pid: &str) -> StartParams {
        StartParams {
            session_id: sid.to_string(),
            product_id: pid.to_string(),
            quality: "LOSSLESS".to_string(),
            source_type: None,
            source_id: None,
            duration_secs: 100,
        }
    }
}
