//! Cast session: a background task that polls the group coordinator (1s)
//! and mirrors speaker-side truth back as Tauri events. Transport state is
//! speaker-authoritative while casting — the frontend reconciles from these
//! events. GENA push could slot in behind the same event contract later.

use std::time::Duration;

use tauri::Emitter;
use tokio_util::sync::CancellationToken;

use std::sync::Arc;

use crate::sonos::avtransport::{self, TransportState};
use crate::sonos::didl;
use crate::sonos::mirror::MirrorState;
use crate::sonos::rendering;

pub const EVENT_TRANSPORT_CHANGED: &str = "sonos-transport-changed";
pub const EVENT_TRACK_FINISHED: &str = "sonos-track-finished";
pub const EVENT_TRACK_CHANGED: &str = "sonos-track-changed";
/// The speaker self-advanced into a mirrored queue entry (native
/// gapless). Carries the entry's qid so the frontend reconciles the exact
/// queue instance.
pub const EVENT_TRACK_ADVANCED: &str = "sonos-track-advanced";
pub const EVENT_VOLUME_CHANGED: &str = "sonos-volume-changed";
pub const EVENT_SESSION_ENDED: &str = "sonos-session-ended";

/// Consecutive poll failures before the session is declared lost.
const MAX_FAILURES: u32 = 5;
const TICK: Duration = Duration::from_millis(1000);
/// Volume is polled every Nth tick; the transport URI every Mth once armed
/// (pre-arm it is polled every tick so arming isn't delayed).
const VOLUME_EVERY: u64 = 3;
const MEDIA_URI_EVERY: u64 = 5;
/// A position sample older than this many ticks counts as stale for the
/// end-of-track classification.
const POSITION_FRESH_TICKS: u64 = 2;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub coordinator_ip: String,
    pub coordinator_uuid: String,
    pub room_name: String,
}

pub struct SessionHandle {
    pub info: SessionInfo,
    cancel: CancellationToken,
}

impl SessionHandle {
    pub fn stop(&self) {
        self.cancel.cancel();
    }
}

impl Drop for SessionHandle {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TransportPayload {
    state: TransportState,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackChangedPayload {
    track_id: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackAdvancedPayload {
    track_id: u64,
    qid: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct VolumePayload {
    volume: u8,
    muted: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionEndedPayload {
    reason: &'static str,
}

/// Spawn the watcher task for a freshly-connected session.
pub fn spawn(
    app: tauri::AppHandle,
    client: reqwest::Client,
    info: SessionInfo,
    mirror: Arc<tokio::sync::Mutex<MirrorState>>,
) -> SessionHandle {
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    let task_info = info.clone();
    tauri::async_runtime::spawn(async move {
        watch(app, client, task_info, mirror, task_cancel).await;
    });
    SessionHandle { info, cancel }
}

async fn watch(
    app: tauri::AppHandle,
    client: reqwest::Client,
    info: SessionInfo,
    mirror: Arc<tokio::sync::Mutex<MirrorState>>,
    cancel: CancellationToken,
) {
    let ip = info.coordinator_ip.as_str();
    let our_queue_uri = didl::queue_uri(&info.coordinator_uuid);

    let mut failures: u32 = 0;
    let mut tick: u64 = 0;
    let mut last_state: Option<TransportState> = None;
    let mut last_track_uri: Option<String> = None;
    let mut last_volume: Option<(u8, bool)> = None;
    // Last observed position + the tick it was sampled on, for the
    // end-of-track vs external-stop classification.
    let mut last_position: Option<(f64, Option<f64>)> = None;
    let mut last_position_tick: u64 = 0;
    // 1-based queue position of the current track, for self-advance
    // detection against the mirrored tail.
    let mut last_track_nr: Option<u32> = None;
    // "Armed" = the coordinator's transport is SONE's queue. Before that, the
    // speaker's leftover state (TV input, radio, another queue) must be
    // neither mirrored into SONE nor mistaken for a takeover.
    let mut armed = false;

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                log::info!("Sonos session on {} stopped", info.room_name);
                return;
            }
            _ = tokio::time::sleep(TICK) => {}
        }
        tick += 1;

        // Transport ownership: every tick until armed (so arming isn't
        // delayed past the first cast), then every Mth tick as the takeover
        // check.
        if !armed || tick.is_multiple_of(MEDIA_URI_EVERY) {
            match avtransport::get_media_info(&client, ip)
                .await
                .map(|m| m.current_uri)
            {
                Ok(uri) if uri == our_queue_uri => {
                    armed = true;
                }
                Ok(uri) if armed && !uri.is_empty() => {
                    log::info!("Sonos transport taken over by another controller: {uri}");
                    if cancel.is_cancelled() {
                        return;
                    }
                    let _ = app.emit(
                        EVENT_SESSION_ENDED,
                        SessionEndedPayload {
                            reason: "takenOver",
                        },
                    );
                    return;
                }
                _ => {}
            }
        }

        let state = match avtransport::get_transport_state(&client, ip).await {
            Ok(s) => s,
            Err(e) => {
                failures += 1;
                log::warn!("Sonos poll failed ({failures}/{MAX_FAILURES}): {e}");
                if failures >= MAX_FAILURES {
                    if cancel.is_cancelled() {
                        return;
                    }
                    let _ = app.emit(
                        EVENT_SESSION_ENDED,
                        SessionEndedPayload {
                            reason: "deviceLost",
                        },
                    );
                    return;
                }
                continue;
            }
        };
        failures = 0;

        let position = avtransport::get_position_info(&client, ip).await.ok();

        // A cancelled watcher must not emit events that would be attributed
        // to a successor session (the swap happens between awaits).
        if cancel.is_cancelled() {
            return;
        }

        // Self-advance through the mirrored tail: the queue position moved
        // forward and the entries it moved through are SONE-enqueued.
        // Consume them and tell the frontend which instances (qids) played.
        let mut advanced = false;
        if let Some(pos) = &position {
            if armed && pos.track_nr > 0 {
                if let Some(prev) = last_track_nr {
                    if pos.track_nr > prev {
                        let steps = pos.track_nr - prev;
                        let mut consumed = Vec::new();
                        {
                            let mut mirror = mirror.lock().await;
                            for _ in 0..steps {
                                match mirror.entries.pop_front() {
                                    Some(entry) => consumed.push(entry),
                                    None => break,
                                }
                            }
                        }
                        if cancel.is_cancelled() {
                            return;
                        }
                        // Only a full match is a clean self-advance; a partial
                        // match means foreign entries got involved — let the
                        // URI-based track-changed path adjudicate.
                        if consumed.len() == steps as usize {
                            advanced = !consumed.is_empty();
                            for entry in consumed {
                                let _ = app.emit(
                                    EVENT_TRACK_ADVANCED,
                                    TrackAdvancedPayload {
                                        track_id: entry.track_id,
                                        qid: entry.qid,
                                    },
                                );
                            }
                        }
                    } else if pos.track_nr < prev {
                        // Backward jump (external Previous / queue jump): the
                        // positional bookkeeping is void — drop it and let the
                        // next sync_tail rewrite from the new position.
                        mirror.lock().await.entries.clear();
                    }
                }
                last_track_nr = Some(pos.track_nr);
            }
        }

        // Track identity change NOT caused by a mirrored self-advance:
        // external skip/previous/jump, or another controller's track.
        if let Some(pos) = &position {
            if !pos.track_uri.is_empty()
                && last_track_uri.as_deref() != Some(pos.track_uri.as_str())
            {
                if armed && !advanced && last_track_uri.is_some() {
                    let _ = app.emit(
                        EVENT_TRACK_CHANGED,
                        TrackChangedPayload {
                            track_id: didl::parse_track_uri(&pos.track_uri),
                        },
                    );
                }
                last_track_uri = Some(pos.track_uri.clone());
            }
        }

        // Transport state transitions. TRANSITIONING is a blip — skip it.
        // Pre-arm states are the speaker's previous life; track them
        // silently so the first armed transition diffs correctly.
        if state != TransportState::Transitioning && last_state != Some(state) {
            if armed {
                // End-of-track = within 5s of the end; relaxed to half the
                // track when the position sample is stale, because a
                // misclassification here silently stalls the queue.
                let finished_naturally = state == TransportState::Stopped
                    && last_state == Some(TransportState::Playing)
                    && matches!(
                        last_position,
                        Some((pos, Some(dur))) if dur > 0.0 && {
                            let fresh = tick.saturating_sub(last_position_tick) <= POSITION_FRESH_TICKS;
                            if fresh { pos >= dur - 5.0 } else { pos >= dur * 0.5 }
                        }
                    );
                if finished_naturally {
                    let _ = app.emit(EVENT_TRACK_FINISHED, ());
                } else if last_state.is_some() || state != TransportState::Stopped {
                    let _ = app.emit(EVENT_TRANSPORT_CHANGED, TransportPayload { state });
                }
            }
            last_state = Some(state);
        }

        if let Some(pos) = &position {
            if let Some(p) = pos.position_secs {
                last_position = Some((p, pos.duration_secs));
                last_position_tick = tick;
            }
        }

        if tick.is_multiple_of(VOLUME_EVERY) {
            let volume = rendering::get_group_volume(&client, ip).await.ok();
            let muted = rendering::get_group_mute(&client, ip).await.ok();
            if cancel.is_cancelled() {
                return;
            }
            if let (Some(volume), Some(muted)) = (volume, muted) {
                if last_volume != Some((volume, muted)) {
                    if last_volume.is_some() {
                        let _ = app.emit(EVENT_VOLUME_CHANGED, VolumePayload { volume, muted });
                    }
                    last_volume = Some((volume, muted));
                }
            }
        }
    }
}
