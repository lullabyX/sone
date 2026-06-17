use std::time::Instant;
use serde_json::Value;
use crate::playback_report::event::build_playback_session_payload;

pub struct SessionParams {
    pub session_id: String,
    pub product_id: String,
    pub quality: String,
    pub source_type: Option<String>,
    pub source_id: Option<String>,
    pub duration_secs: u32,
    pub start_ms: i64,
    pub start_instant: Instant,
}

pub struct PlaybackSession {
    session_id: String,
    product_id: String,
    quality: String,
    source_type: Option<String>,
    source_id: Option<String>,
    duration_secs: u32,
    start_ms: i64,
    accumulated: std::time::Duration,
    segment_start: Option<Instant>,
}

impl PlaybackSession {
    pub fn new(p: SessionParams) -> Self {
        Self {
            session_id: p.session_id,
            product_id: p.product_id,
            quality: p.quality,
            source_type: p.source_type,
            source_id: p.source_id,
            duration_secs: p.duration_secs,
            start_ms: p.start_ms,
            accumulated: std::time::Duration::ZERO,
            segment_start: Some(p.start_instant),
        }
    }

    pub fn pause_at(&mut self, now: Instant) {
        if let Some(seg) = self.segment_start.take() {
            self.accumulated += now.saturating_duration_since(seg);
        }
    }

    pub fn resume_at(&mut self, now: Instant) {
        if self.segment_start.is_none() {
            self.segment_start = Some(now);
        }
    }

    fn played_secs_at(&self, now: Instant) -> f64 {
        let mut total = self.accumulated;
        if let Some(seg) = self.segment_start {
            total += now.saturating_duration_since(seg);
        }
        let secs = total.as_secs_f64();
        let cap = self.duration_secs as f64;
        if cap > 0.0 && secs > cap { cap } else { secs }
    }

    pub fn finalize_at(&mut self, end_ms: i64, now: Instant) -> Value {
        let end_pos = self.played_secs_at(now);
        build_playback_session_payload(
            &self.session_id,
            &self.product_id,
            &self.quality,
            self.source_type.as_deref(),
            self.source_id.as_deref(),
            self.start_ms,
            0.0,
            end_ms,
            end_pos,
        )
    }

    pub fn pause(&mut self) { self.pause_at(Instant::now()); }
    pub fn resume(&mut self) { self.resume_at(Instant::now()); }

    pub fn finalize(&mut self) -> Value {
        let end_ms = crate::now_millis();
        self.finalize_at(end_ms, Instant::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn mk() -> (PlaybackSession, Instant) {
        let t0 = Instant::now();
        let s = PlaybackSession::new(SessionParams {
            session_id: "s1".into(),
            product_id: "100".into(),
            quality: "LOSSLESS".into(),
            source_type: Some("ALBUM".into()),
            source_id: Some("55".into()),
            duration_secs: 200,
            start_ms: 1_000_000,
            start_instant: t0,
        });
        (s, t0)
    }

    #[test]
    fn finalize_caps_position_at_duration() {
        let (mut s, t0) = mk();
        let end = t0 + Duration::from_secs(300);
        let v = s.finalize_at(1_300_000, end);
        assert_eq!(v["endAssetPosition"], 200.0);
        assert_eq!(v["endTimestamp"], 1_300_000i64);
        assert_eq!(v["startAssetPosition"], 0.0);
    }

    #[test]
    fn pause_excludes_paused_time_from_position() {
        let (mut s, t0) = mk();
        s.pause_at(t0 + Duration::from_secs(10));
        s.resume_at(t0 + Duration::from_secs(40));
        let v = s.finalize_at(1_050_000, t0 + Duration::from_secs(50));
        assert_eq!(v["endAssetPosition"], 20.0);
    }
}
