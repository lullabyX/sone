use serde::Serialize;

pub const EV_PLAY_TRACKS: &str = "mcp:play-tracks";
pub const EV_PLAY_SOURCE: &str = "mcp:play-source";
pub const EV_PAUSE: &str = "mcp:pause";
pub const EV_RESUME: &str = "mcp:resume";
pub const EV_SKIP_NEXT: &str = "mcp:skip-next";
pub const EV_SKIP_PREVIOUS: &str = "mcp:skip-previous";
pub const EV_SEEK: &str = "mcp:seek";
pub const EV_SET_VOLUME: &str = "mcp:set-volume";
pub const EV_CLEAR_QUEUE: &str = "mcp:clear-queue";
pub const EV_REMOVE_FROM_QUEUE: &str = "mcp:remove-from-queue";
pub const EV_SET_REPEAT: &str = "mcp:set-repeat";
pub const EV_TOGGLE_SHUFFLE: &str = "mcp:toggle-shuffle";
pub const EV_SHUFFLE_SOURCE: &str = "mcp:shuffle-source";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlayTracksPayload {
    pub track_ids: Vec<u64>,
    /// "play_now", "queue", or "play_next"
    pub action: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaySourcePayload {
    /// "playlist", "album", "artist", or "mix"
    pub source_type: String,
    pub id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SeekPayload {
    pub position_seconds: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VolumePayload {
    pub level: f32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoveFromQueuePayload {
    pub track_id: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepeatPayload {
    /// "off", "all", or "one"
    pub mode: String,
}
