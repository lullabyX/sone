pub mod queue;
pub mod lastfm;
pub mod listenbrainz;
pub mod librefm;
pub mod musicbrainz;

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::sync::{Mutex, RwLock};

use crate::crypto::Crypto;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ScrobbleTrack {
    pub artist: String,
    pub track: String,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub album_artist: Option<String>,
    pub duration_secs: u32,
    #[serde(default)]
    pub track_number: Option<u32>,
    pub timestamp: i64,
    pub chosen_by_user: bool,
    #[serde(default)]
    pub isrc: Option<String>,
    #[serde(default)]
    pub track_id: Option<u64>,
    #[serde(default)]
    pub recording_mbid: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ProviderStatus {
    pub name: String,
    pub connected: bool,
    pub username: Option<String>,
}

pub enum ScrobbleResult {
    Ok,
    AuthError(String),
    Retryable(String),
}

// ---------------------------------------------------------------------------
// Provider trait
// ---------------------------------------------------------------------------

#[async_trait]
pub trait ScrobbleProvider: Send + Sync {
    fn name(&self) -> &str;
    fn is_authenticated(&self) -> bool;
    fn max_batch_size(&self) -> usize;
    async fn username(&self) -> Option<String>;
    async fn now_playing(&self, track: &ScrobbleTrack) -> ScrobbleResult;
    async fn scrobble(&self, tracks: &[ScrobbleTrack]) -> ScrobbleResult;
}

// ---------------------------------------------------------------------------
// Track playback state (private)
// ---------------------------------------------------------------------------

struct TrackPlayback {
    track: ScrobbleTrack,
    accumulated_secs: f64,
    last_resumed_at: Option<Instant>,
    scrobbled: bool,
}

impl TrackPlayback {
    fn new(track: ScrobbleTrack) -> Self {
        Self {
            track,
            accumulated_secs: 0.0,
            last_resumed_at: Some(Instant::now()),
            scrobbled: false,
        }
    }

    /// Total seconds of actual playback so far.
    fn elapsed(&self) -> f64 {
        let live = self
            .last_resumed_at
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        self.accumulated_secs + live
    }

    fn pause(&mut self) {
        if let Some(resumed) = self.last_resumed_at.take() {
            self.accumulated_secs += resumed.elapsed().as_secs_f64();
        }
    }

    fn resume(&mut self) {
        if self.last_resumed_at.is_none() {
            self.last_resumed_at = Some(Instant::now());
        }
    }

    /// After a seek, reset the live timer but keep accumulated time.
    fn on_seek(&mut self) {
        // Flush current live segment into accumulated, restart timer
        if let Some(resumed) = self.last_resumed_at.take() {
            self.accumulated_secs += resumed.elapsed().as_secs_f64();
        }
        self.last_resumed_at = Some(Instant::now());
    }

    /// Meets the scrobble threshold:
    /// - track is longer than 30 seconds
    /// - listened to at least 50% of the track OR at least 4 minutes
    fn meets_threshold(&self) -> bool {
        if self.track.duration_secs < 30 {
            return false;
        }
        let listened = self.elapsed();
        let half = self.track.duration_secs as f64 / 2.0;
        listened >= half || listened >= 240.0
    }
}

// ---------------------------------------------------------------------------
// ScrobbleManager
// ---------------------------------------------------------------------------

pub struct ScrobbleManager {
    providers: RwLock<Vec<Box<dyn ScrobbleProvider>>>,
    queue: queue::ScrobbleQueue,
    current_track: Arc<Mutex<Option<TrackPlayback>>>,
    app_handle: tauri::AppHandle,
    mb_lookup: Arc<musicbrainz::MusicBrainzLookup>,
}

impl ScrobbleManager {
    pub fn new(app_handle: tauri::AppHandle, crypto: Arc<Crypto>, config_dir: &Path) -> Self {
        let queue_path = config_dir.join("scrobble_queue.bin");
        Self {
            providers: RwLock::new(Vec::new()),
            queue: queue::ScrobbleQueue::new(&queue_path, crypto),
            current_track: Arc::new(Mutex::new(None)),
            app_handle,
            mb_lookup: Arc::new(musicbrainz::MusicBrainzLookup::new(config_dir)),
        }
    }

    pub async fn add_provider(&self, provider: Box<dyn ScrobbleProvider>) {
        let mut providers = self.providers.write().await;
        // Remove existing provider with the same name
        let name = provider.name().to_string();
        providers.retain(|p| p.name() != name);
        providers.push(provider);
    }

    pub async fn remove_provider(&self, name: &str) {
        let mut providers = self.providers.write().await;
        providers.retain(|p| p.name() != name);
    }

    pub async fn provider_statuses(&self) -> Vec<ProviderStatus> {
        let providers = self.providers.read().await;
        let mut statuses = Vec::new();

        let known = ["lastfm", "listenbrainz", "librefm"];
        for &name in &known {
            if let Some(p) = providers.iter().find(|p| p.name() == name) {
                statuses.push(ProviderStatus {
                    name: name.to_string(),
                    connected: p.is_authenticated(),
                    username: p.username().await,
                });
            } else {
                statuses.push(ProviderStatus {
                    name: name.to_string(),
                    connected: false,
                    username: None,
                });
            }
        }
        statuses
    }

    /// Called when a new track begins playing.
    pub async fn on_track_started(&self, track: ScrobbleTrack) {
        // Check previous track for scrobble threshold
        {
            let mut current = self.current_track.lock().await;
            if let Some(prev) = current.take() {
                if !prev.scrobbled && prev.meets_threshold() {
                    let t = prev.track.clone();
                    drop(current);
                    self.dispatch_scrobble(t).await;
                } else {
                    drop(current);
                }
            }
        }

        // Fire now_playing for the new track
        self.fire_now_playing(&track).await;

        // Set new current track
        let isrc = track.isrc.clone();
        let track_name = track.track.clone();
        let artist_name = track.artist.clone();
        let expected_id = track.track_id;

        let mut current = self.current_track.lock().await;
        *current = Some(TrackPlayback::new(track));
        drop(current);

        // Spawn fire-and-forget MBID lookup (only if we have ISRC + track_id for guard)
        if let (Some(isrc), Some(expected_id)) = (isrc, expected_id) {
            let mb = Arc::clone(&self.mb_lookup);
            let ct = Arc::clone(&self.current_track);
            tokio::spawn(async move {
                if let Some(mbid) = mb.lookup_isrc(&isrc, &track_name, &artist_name).await {
                    let mut current = ct.lock().await;
                    if let Some(ref mut playback) = *current {
                        if playback.track.track_id == Some(expected_id) {
                            playback.track.recording_mbid = Some(mbid);
                        }
                    }
                }
            });
        }
    }

    pub async fn on_pause(&self) {
        let mut current = self.current_track.lock().await;
        if let Some(playback) = current.as_mut() {
            playback.pause();
        }
    }

    pub async fn on_resume(&self) {
        let mut current = self.current_track.lock().await;
        if let Some(playback) = current.as_mut() {
            playback.resume();
        }
    }

    pub async fn on_seek(&self) {
        let mut current = self.current_track.lock().await;
        if let Some(playback) = current.as_mut() {
            playback.on_seek();
        }
    }

    /// Called when the current track finishes playing naturally.
    pub async fn on_track_finished(&self) {
        let mut current = self.current_track.lock().await;
        if let Some(mut playback) = current.take() {
            if !playback.scrobbled && playback.meets_threshold() {
                playback.scrobbled = true;
                let track = playback.track.clone();
                drop(current);
                self.dispatch_scrobble(track).await;
            }
        }
    }

    /// Shutdown: scrobble current if threshold met, persist queue.
    pub async fn flush(&self) {
        // Try to scrobble current track with a 2s timeout
        let track_to_scrobble = {
            let mut current = self.current_track.lock().await;
            if let Some(mut playback) = current.take() {
                if !playback.scrobbled && playback.meets_threshold() {
                    playback.scrobbled = true;
                    Some(playback.track.clone())
                } else {
                    None
                }
            } else {
                None
            }
        };

        if let Some(track) = track_to_scrobble {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                self.dispatch_scrobble(track),
            )
            .await;
        }

        self.queue.flush().await;
        self.mb_lookup.persist().await;
    }

    /// Send a scrobbled track to all connected providers.
    /// Queue failures for retry. Emit auth errors to the frontend.
    async fn dispatch_scrobble(&self, track: ScrobbleTrack) {
        // Collect authenticated provider names under the lock, then drop it
        // so we never await provider calls while the lock is held.
        let names: Vec<String> = {
            let providers = self.providers.read().await;
            providers
                .iter()
                .filter(|p| p.is_authenticated())
                .map(|p| p.name().to_string())
                .collect()
        };

        for name in names {
            // Acquire, call, and drop the lock per-provider.
            // The scrobble() call returns a boxed future (async_trait);
            // we must await it while still borrowing the guard, but a read
            // lock is cheap and only blocks writers briefly.
            let providers = self.providers.read().await;
            let Some(provider) = providers.iter().find(|p| p.name() == name) else {
                continue;
            };
            let result = provider.scrobble(&[track.clone()]).await;
            drop(providers);

            match result {
                ScrobbleResult::Ok => {
                    log::debug!("Scrobbled to {name}: {} - {}", track.artist, track.track);
                }
                ScrobbleResult::AuthError(msg) => {
                    log::warn!("Scrobble auth error for {name}: {msg}");
                    let _ = self.app_handle.emit("scrobble-auth-error", &name);
                }
                ScrobbleResult::Retryable(msg) => {
                    log::warn!("Scrobble failed for {name} (will retry): {msg}");
                    self.queue.push(&name, track.clone()).await;
                }
            }
        }
    }

    /// Placeholder for draining the retry queue on startup.
    pub async fn drain_queue(&self) {
        // Will be implemented when providers are ready
        log::debug!("drain_queue: not yet implemented");
    }

    pub async fn queue_size(&self) -> usize {
        self.queue.len().await
    }

    /// Fire now_playing to all providers (non-blocking, with timeout).
    async fn fire_now_playing(&self, track: &ScrobbleTrack) {
        let names: Vec<String> = {
            let providers = self.providers.read().await;
            providers
                .iter()
                .filter(|p| p.is_authenticated())
                .map(|p| p.name().to_string())
                .collect()
        };

        for name in names {
            let providers = self.providers.read().await;
            let Some(provider) = providers.iter().find(|p| p.name() == name) else {
                continue;
            };
            let result = tokio::time::timeout(
                Duration::from_secs(5),
                provider.now_playing(track),
            )
            .await;
            drop(providers);

            match result {
                Ok(ScrobbleResult::Ok) => {
                    log::debug!("Now playing sent to {name}");
                }
                Ok(ScrobbleResult::AuthError(msg)) => {
                    log::warn!("Now playing auth error for {name}: {msg}");
                    let _ = self.app_handle.emit("scrobble-auth-error", &name);
                }
                Ok(ScrobbleResult::Retryable(msg)) => {
                    log::debug!("Now playing failed for {name} (non-critical): {msg}");
                }
                Err(_) => {
                    log::debug!("Now playing timed out for {name}");
                }
            }
        }
    }
}
