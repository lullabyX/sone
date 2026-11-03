//! TIDAL Connect device model types.
//!
//! [Maintainer walkthrough] `ConnectDevice` is the candidate a renderer sees
//! (mDNS-resolved identity plus addresses). `PlaybackCommand` and
//! `PlaybackState` belong to the legacy WS-command path that predates the
//! LinkPlay push-URL transport and are kept only for the few handshake
//! messages the session still exchanges. Note the naming difference between
//! a TIDAL Connect cast (this module, receiver pulls from TIDAL) and local
//! playback in `audio.rs` (Sone decodes). Device model quirks of record:
//! certified WiiM (A98) receivers idle-close WS sessions ~30 s in and can
//! wedge if pushed while loading; both are handled upstream of this file.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectDevice {
    pub id: String,
    pub name: String,
    pub model_name: String,
    pub host: String,
    pub port: u16,
    pub addresses: Vec<String>,
    pub txt_records: HashMap<String, String>,
    pub is_local: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PlaybackState {
    Idle,
    Buffering,
    Playing,
    Paused,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum PlaybackCommand {
    Play,
    Pause,
    Stop,
    Next,
    Previous,
    Seek { position_ms: u64 },
    SetVolume { volume: f64 },
    SetMute { mute: bool },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMediaInfo {
    pub title: Option<String>,
    pub artists: Vec<String>,
    pub album_title: Option<String>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAudioFormat {
    pub codec: String,
    pub sample_rate: u32,
    pub bit_depth: u8,
    pub channels: u8,
}
