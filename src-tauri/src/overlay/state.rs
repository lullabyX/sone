use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

/// Snapshot of the currently playing track, pushed by the frontend.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OverlayTrackState {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub cover_url: Option<String>,
    pub is_playing: bool,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    /// Human-readable quality string, e.g. "24-BIT 192KHZ FLAC". Empty = unknown.
    pub quality: String,
}

pub struct OverlayState {
    pub track: Option<OverlayTrackState>,
    /// Serialized CSS block for the active SONE theme, e.g.
    /// `:root { --th-accent: #A855F7; --th-bg-base: #130F1A; ... }`
    pub theme_css: String,
    pub tx: broadcast::Sender<String>,
    pub theme_tx: broadcast::Sender<String>,
}

impl OverlayState {
    pub fn new() -> (Self, broadcast::Receiver<String>, broadcast::Receiver<String>) {
        let (tx, rx) = broadcast::channel(16);
        let (theme_tx, theme_rx) = broadcast::channel(8);
        (
            Self {
                track: None,
                theme_css: String::new(),
                tx,
                theme_tx,
            },
            rx,
            theme_rx,
        )
    }
}

pub type OverlayStateRef = Arc<RwLock<OverlayState>>;

pub fn new_state() -> (OverlayStateRef, broadcast::Receiver<String>, broadcast::Receiver<String>) {
    let (state, rx, theme_rx) = OverlayState::new();
    (Arc::new(RwLock::new(state)), rx, theme_rx)
}
