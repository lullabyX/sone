use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingSnapshot {
    pub track_id: Option<u64>,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_seconds: u32,
    pub position_seconds: u32,
    pub is_playing: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueueTrackSnapshot {
    pub id: u64,
    pub title: String,
    pub artist: String,
}

#[derive(Default, Debug)]
pub struct McpState {
    pub now_playing: Option<NowPlayingSnapshot>,
    pub queue: Vec<QueueTrackSnapshot>,
}

pub type McpStateRef = Arc<RwLock<McpState>>;

pub fn new_state() -> McpStateRef {
    Arc::new(RwLock::new(McpState::default()))
}
