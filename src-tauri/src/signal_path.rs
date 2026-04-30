//! Signal path transparency tracker.
//!
//! Collects what is known at runtime about how audio flows from TIDAL to the
//! DAC: which backend is active, what GStreamer decoded to, what ALSA
//! actually negotiated, and any alterations along the way (resampling,
//! bit-depth promotion, format fallback, software volume, ReplayGain).
//!
//! The tracker is the single source of truth for the frontend
//! "transparency panel". Mutations emit a `signal-path-changed` event so
//! the UI can reactively update without polling.

use serde::Serialize;
use std::sync::Mutex;
use tauri::Emitter;

/// Snapshot of the runtime signal path. Sent to the frontend as the payload
/// of `signal-path-changed` events and as the return of `get_signal_path`.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SignalPath {
    /// "Normal" (autoaudiosink → system mixer) or "DirectAlsa" (exclusive ALSA).
    pub backend: Option<String>,

    /// PCM format the GStreamer pipeline decodes to (DirectAlsa only — the
    /// system mixer hides this in Normal mode).
    pub decoded_format: Option<String>,
    pub decoded_rate: Option<u32>,
    pub decoded_channels: Option<u32>,

    /// What ALSA actually negotiated. DirectAlsa only.
    pub output_format: Option<String>,
    pub output_rate: Option<u32>,
    pub output_channels: Option<u32>,
    pub output_device: Option<String>,

    /// Mode flags reflected from settings.
    pub exclusive_mode: bool,
    pub bit_perfect: bool,
    pub volume_normalization: bool,

    /// User-set volume multiplier (1.0 = unity, no software attenuation).
    pub user_volume: f32,
    /// Linear ReplayGain multiplier currently applied (1.0 = none).
    pub norm_gain_factor: f32,

    /// Resampling that occurred (DAC-supported rate fallback in non-bit-perfect mode).
    pub resampled_from: Option<u32>,
    pub resampled_to: Option<u32>,

    /// Bit-depth container promotion (bit-perfect: source widened to nearest
    /// DAC-supported container; pure bit op via zero-padding).
    pub promoted_from: Option<String>,
    pub promoted_to: Option<String>,

    /// Format fallback (non-bit-perfect: DAC didn't accept requested format).
    pub format_fallback_from: Option<String>,
    pub format_fallback_to: Option<String>,
}

pub struct SignalPathTracker {
    state: Mutex<SignalPath>,
    app_handle: tauri::AppHandle,
}

impl SignalPathTracker {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self {
            state: Mutex::new(SignalPath {
                user_volume: 1.0,
                norm_gain_factor: 1.0,
                ..Default::default()
            }),
            app_handle,
        }
    }

    pub fn snapshot(&self) -> SignalPath {
        self.state.lock().unwrap().clone()
    }

    fn emit(&self, snap: SignalPath) {
        let _ = self.app_handle.emit("signal-path-changed", snap);
    }

    /// Clear per-track signal info but keep mode flags / volume / device.
    /// Called at the start of each `PlayUrl`.
    pub fn reset_for_track(&self) {
        let snap = {
            let mut s = self.state.lock().unwrap();
            s.decoded_format = None;
            s.decoded_rate = None;
            s.decoded_channels = None;
            s.output_format = None;
            s.output_rate = None;
            s.output_channels = None;
            s.resampled_from = None;
            s.resampled_to = None;
            s.promoted_from = None;
            s.promoted_to = None;
            s.format_fallback_from = None;
            s.format_fallback_to = None;
            s.clone()
        };
        self.emit(snap);
    }

    pub fn set_backend(&self, backend: &str, device: Option<String>) {
        let snap = {
            let mut s = self.state.lock().unwrap();
            s.backend = Some(backend.to_string());
            s.output_device = device;
            s.clone()
        };
        self.emit(snap);
    }

    pub fn set_audio_modes(&self, exclusive: bool, bit_perfect: bool) {
        let snap = {
            let mut s = self.state.lock().unwrap();
            s.exclusive_mode = exclusive;
            s.bit_perfect = bit_perfect;
            s.clone()
        };
        self.emit(snap);
    }

    pub fn set_normalization_enabled(&self, enabled: bool) {
        let snap = {
            let mut s = self.state.lock().unwrap();
            s.volume_normalization = enabled;
            if !enabled {
                // RG is off → factor irrelevant, render as 1.0 (unity).
                s.norm_gain_factor = 1.0;
            }
            s.clone()
        };
        self.emit(snap);
    }

    pub fn set_decoded(&self, fmt: &str, rate: u32, channels: u32) {
        let snap = {
            let mut s = self.state.lock().unwrap();
            s.decoded_format = Some(fmt.to_string());
            s.decoded_rate = Some(rate);
            s.decoded_channels = Some(channels);
            s.clone()
        };
        self.emit(snap);
    }

    pub fn set_output(&self, fmt: &str, rate: u32, channels: u32) {
        let snap = {
            let mut s = self.state.lock().unwrap();
            s.output_format = Some(fmt.to_string());
            s.output_rate = Some(rate);
            s.output_channels = Some(channels);
            s.clone()
        };
        self.emit(snap);
    }

    pub fn set_user_volume(&self, vol: f32) {
        let snap = {
            let mut s = self.state.lock().unwrap();
            s.user_volume = vol;
            s.clone()
        };
        self.emit(snap);
    }

    pub fn set_norm_gain_factor(&self, factor: f32) {
        let snap = {
            let mut s = self.state.lock().unwrap();
            s.norm_gain_factor = factor;
            s.clone()
        };
        self.emit(snap);
    }

    pub fn record_resample(&self, from: u32, to: u32) {
        let snap = {
            let mut s = self.state.lock().unwrap();
            s.resampled_from = Some(from);
            s.resampled_to = Some(to);
            s.clone()
        };
        self.emit(snap);
    }

    pub fn record_bit_depth_promotion(&self, from: &str, to: &str) {
        let snap = {
            let mut s = self.state.lock().unwrap();
            s.promoted_from = Some(from.to_string());
            s.promoted_to = Some(to.to_string());
            s.clone()
        };
        self.emit(snap);
    }

    pub fn record_format_fallback(&self, from: &str, to: &str) {
        let snap = {
            let mut s = self.state.lock().unwrap();
            s.format_fallback_from = Some(from.to_string());
            s.format_fallback_to = Some(to.to_string());
            s.clone()
        };
        self.emit(snap);
    }
}
