use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;

pub mod client;
pub mod discovery;
pub mod linkplay;
pub mod manifest_server;
pub mod models;
pub mod protocol;

pub use client::TidalConnectClient;
pub use discovery::DiscoveryEngine;
pub use linkplay::{CastStatus, LinkPlayClient, PlayerStatusRaw};
pub use manifest_server::ManifestServer;
pub use models::{ConnectDevice, PlaybackCommand, PlaybackState};

pub type TidalConnectStateRef = Arc<TidalConnectState>;

/// LinkPlay-side cast context: the receiver host we push to, plus the
/// resurrected poller handle and the last polled status.
pub struct TidalConnectState {
    pub discovery: RwLock<DiscoveryEngine>,
    pub active_device: RwLock<Option<ConnectDevice>>,
    pub client: Arc<TidalConnectClient>,
    /// Push-URL transport (LinkPlay httpapi). Replaces the crashing
    /// loadLocalQueue route for all media operations; the TIDAL Connect
    /// WebSocket session stays up purely for its richer events.
    pub linkplay: Arc<LinkPlayClient>,
    /// Host (`ip:port` style host-only, e.g. `192.168.1.68`) of the receiver
    /// we are currently casting to via LinkPlay, if any.
    pub cast_host: RwLock<Option<String>>,
    /// Local manifest server used to serve DASH XML to the receiver.
    pub manifest_server: ManifestServer,
    /// Last polled receiver status; drives position/track-end reporting.
    pub cast_status: RwLock<Option<CastStatus>>,
    /// 1 s poller task handle for the active cast, for abort on select(local).
    pub poller: RwLock<Option<tokio::task::JoinHandle<()>>>,
}

pub fn new_state(device_http: reqwest::Client) -> TidalConnectStateRef {
    Arc::new(TidalConnectState {
        discovery: RwLock::new(DiscoveryEngine::new()),
        active_device: RwLock::new(None),
        client: Arc::new(TidalConnectClient::new()),
        linkplay: Arc::new(LinkPlayClient::new(device_http)),
        cast_host: RwLock::new(None),
        manifest_server: ManifestServer::new(),
        cast_status: RwLock::new(None),
        poller: RwLock::new(None),
    })
}

/// Spawn (or replace) the 1 s receiver status poller. Emits:
/// - `tidal-connect:track-ended` on un-commanded play-to-stop transitions
/// - `tidal-connect:volume` (0.0-1.0) whenever the receiver reports `vol`
/// Idempotent: an existing poller is aborted first.
pub async fn ensure_cast_poller(
    app: tauri::AppHandle,
    state_ref: &TidalConnectStateRef,
) {
    // Abort any previous poller. `let`-then-`if let` on purpose: an `if let
    // Some(old) = guard.take()` scrutinee keeps the lock guard alive for the
    // whole block, and this exact temporary-lifetime pattern is the known
    // self-deadlock shape in this module (see stop_playback's cast_host fix).
    // Bound the take: this path runs inside the user-facing play command, so
    // a pathological lock holder must fail the cast instead of freezing it.
    let old = match tokio::time::timeout(
        std::time::Duration::from_secs(1),
        state_ref.poller.write(),
    ).await {
        Err(_) => {
            log::error!("[cast-poller] poller write lock not granted within 1s; proceeding without abort");
            None
        }
        Ok(mut guard) => guard.take(),
    };
    if let Some(old) = old {
        old.abort();
    }
    let app = app.clone();
    let state_ref = Arc::clone(state_ref);
    let cast_ref = Arc::clone(&state_ref);
    let handle = tokio::spawn(async move {
        // Rate-limits poll-failure logs: the receiver occasionally returns
        // empty responses for stretches; log the first failure, then only
        // one line every 30 consecutive failures.
        let mut consecutive_failures: u32 = 0;
        let mut poll_interval = std::time::Duration::from_secs(1);
        loop {
            tokio::time::sleep(poll_interval).await;
            let Some(host) = cast_ref.cast_host.read().await.clone() else {
                break;
            };
            let (raw, track_ended, volume) = match cast_ref.linkplay.poll(&host, &cast_ref.cast_status).await {
                Ok(res) => {
                    consecutive_failures = 0;
                    res
                }
                Err(e) => {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    if consecutive_failures == 1 || consecutive_failures % 30 == 0 {
                        log::debug!(
                            "[cast-poller] status poll failed x{} on {}: {}",
                            consecutive_failures,
                            host,
                            e
                        );
                    }
                    poll_interval = std::time::Duration::from_secs(1);
                    continue;
                }
            };
            poll_interval = if raw.status == "pause" {
                std::time::Duration::from_secs(2)
            } else {
                std::time::Duration::from_secs(1)
            };
            if let Some(vol) = volume {
                use tauri::Emitter;
                let normalized = (vol as f64 / 100.0).clamp(0.0, 1.0);
                let _ = app.emit("tidal-connect:volume", normalized);
            }
            if track_ended {
                log::info!("[cast-poller] track ended on receiver {}", host);
                use tauri::Emitter;
                let _ = app.emit("tidal-connect:track-ended", ());
            }
            let _ = raw; // kept for future parity logging
            // Jam recovery: a push that never reaches play within the grace
            // window wedges the receiver (observed when a rapid skip pushes a
            // new URL while the previous one is still priming: the player
            // ends in "pause"/"load" with totlen=0 and stays there until an
            // operator pause/play unblocks it). One bounded re-push is enough
            // in practice. A "pause" with a loaded track is user intent, not
            // a jam, and never triggers this.
            const JAM_GRACE: std::time::Duration = std::time::Duration::from_secs(12);
            let jammed_url = cast_ref.cast_status.read().await.as_ref().and_then(|s| {
                if s.play_confirmed || s.repushes >= 1 {
                    return None;
                }
                let stale = s.pushed_at.elapsed() >= JAM_GRACE;
                let wedged = s.status == "load"
                    || s.status == "stop"
                    || (s.status == "pause" && s.totlen_ms == 0);
                if stale && wedged {
                    s.cast_url.clone()
                } else {
                    None
                }
            });
            if let Some(url) = jammed_url {
                log::info!(
                    "[cast-poller] push jammed (no play within {:?}); re-pushing",
                    JAM_GRACE
                );
                // Stop-first: a stuck engine ignores plain play commands, and
                // the 2026-10-24 wedges showed a stop before the re-push
                // clears the load pipeline (the same sequence every working
                // push runs). The stop settles asynchronously inside the
                // receiver: pushing immediately still jams, so wait the same
                // settle window the seek path uses.
                if let Err(e) = cast_ref.linkplay.expect_ok(&host, "setPlayerCmd%3Astop").await {
                    log::debug!("[cast-poller] jam-recovery stop not accepted: {}", e);
                }
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                match cast_ref.linkplay.push_play(&host, &url).await {
                    Ok(()) => {
                        if let Ok(mut slot) = cast_ref.cast_status.try_write() {
                            if let Some(s) = slot.as_mut() {
                                s.repushes += 1;
                                s.pushed_at = Instant::now();
                                s.play_confirmed = false;
                                s.status = "load".into();
                                s.anchor_at = None;
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("[cast-poller] jam re-push failed: {}", e);
                    }
                }
            }
        }
    });
    // It logged nothing after the push in the 2026-10-22 wedges; whoever
    // stalls the function below (lock, spawn) is what wedged the play
    // command. Per-step INFO markers make the site obvious within one cast.
    let assign = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        state_ref.poller.write(),
    )
    .await;
    match assign {
        Err(_) => {
            log::error!("[cast-poller] poller assign timeout; cast events disabled (stall suspected)");
        }
        Ok(mut guard) => *guard = Some(handle),
    }
}

/// Stop distance: abort the poller and clear the cast context (local
/// selection / teardown).
pub async fn teardown_cast(state_ref: &TidalConnectStateRef) {
    // Same non-retaining guard pattern as `ensure_cast_poller`.
    let old = match tokio::time::timeout(
        std::time::Duration::from_secs(1),
        state_ref.poller.write(),
    ).await {
        Err(_) => {
            log::error!("[cast-poller] teardown: poller write lock not granted within 1s");
            None
        }
        Ok(mut guard) => guard.take(),
    };
    if let Some(old) = old {
        old.abort();
    }
    *state_ref.cast_host.write().await = None;
    *state_ref.cast_status.write().await = None;
}
