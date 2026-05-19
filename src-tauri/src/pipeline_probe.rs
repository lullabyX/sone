//! Pipeline probe: gathers ground-truth info about the audio pipeline
//! from /proc/asound (kernel hw_params) and pactl (OS mixer state).
//! Called by the `refresh_signal_path` Tauri command and the modal's
//! 2 s heartbeat. Runs in the Tauri command handler thread — never on
//! the audio thread.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DacHwParams {
    pub card_index: u32,
    pub card_name: String,
    pub pcm_device: String,
    pub format: String,
    pub rate: u32,
    pub channels: u32,
    pub period_size: u32,
    pub buffer_size: u32,
    pub state: HwParamsState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum HwParamsState {
    Active,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsMixerInfo {
    pub server: String,
    pub default_sink_name: String,
    pub sink_format: String,
    pub sink_rate: u32,
    pub sink_channels: u32,
}

/// Pad-caps snapshot from an audio pipeline probe.
#[derive(Debug, Clone, PartialEq)]
pub struct PadCaps {
    pub format: String,
    pub rate: u32,
    pub channels: u32,
}

#[cfg(test)]
mod tests {
    // Tests added in subsequent tasks.
}
