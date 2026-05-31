use crate::signal_path::SignalPathTracker;
use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use tauri::Emitter;

type Reply<T> = mpsc::Sender<T>;

#[derive(Debug, Clone, Serialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
}

// ── PCM types ──────────────────────────────────────────────────────────

/// Raw PCM chunk from GStreamer appsink
struct AudioChunk {
    data: Vec<u8>,
    format: PcmFormat,
    generation: u64,
}

#[derive(Clone, Debug, PartialEq)]
struct PcmFormat {
    sample_rate: u32,
    channels: u32,
    gst_format: String,
    bytes_per_sample: u32,
}

/// Pre-resolved next track armed for a gapless `about-to-finish` transition.
#[derive(Clone)]
struct NextTrack {
    uri: String,
    norm_gain: f64,
    track_id: u64,
    qid: String,
    replay_gain: f64,
    peak_amplitude: f64,
    is_dash: bool,
}

/// A gapless advance that has been committed to the pipeline and is awaiting
/// the confirming STREAM_START on the bus thread.
#[derive(Clone)]
struct PendingAdvance {
    track_id: u64,
    qid: String,
    norm_gain: f64,
    replay_gain: f64,
    peak_amplitude: f64,
}

/// Commands to the ALSA writer thread
enum WriterCommand {
    Data(AudioChunk),
    EndOfTrack {
        emit_finished: bool,
        generation: u64,
    },
    FormatHint(PcmFormat),
    Resampling { from: u32, to: u32 },
    PendingPromotion { from: String, generation: u64 },
    Flush,
    Shutdown,
}

/// Active playback backend — determines command dispatch.
/// The ALSA writer sender + thread handle live as separate state variables
/// so they persist across PlayUrl calls (track changes keep DAC open).
enum PlaybackBackend {
    /// Normal: full GStreamer pipeline with autoaudiosink (unchanged)
    Normal {
        pipeline: gst::Pipeline,
        user_volume_el: Option<gst::Element>,
        norm_volume_el: Option<gst::Element>,
    },
    /// Exclusive/Bit-perfect: GStreamer decode → appsink, ALSA writer is external
    DirectAlsa {
        pipeline: gst::Pipeline,
        user_volume_el: Option<gst::Element>,
        norm_volume_el: Option<gst::Element>,
    },
}

impl PlaybackBackend {
    fn user_volume_el(&self) -> Option<&gst::Element> {
        match self {
            PlaybackBackend::Normal { user_volume_el, .. }
            | PlaybackBackend::DirectAlsa { user_volume_el, .. } => user_volume_el.as_ref(),
        }
    }

    fn norm_volume_el(&self) -> Option<&gst::Element> {
        match self {
            PlaybackBackend::Normal { norm_volume_el, .. }
            | PlaybackBackend::DirectAlsa { norm_volume_el, .. } => norm_volume_el.as_ref(),
        }
    }
}

// ── Helper functions ───────────────────────────────────────────────────

fn parse_pcm_format(caps: &gst::CapsRef) -> Option<PcmFormat> {
    let s = caps.structure(0)?;
    if !s.name().as_str().starts_with("audio/") {
        return None;
    }
    let format = s.get::<&str>("format").ok()?;
    let rate = s.get::<i32>("rate").ok()? as u32;
    let channels = s.get::<i32>("channels").ok()? as u32;
    let bps = match format {
        "S16LE" => 2,
        "S24LE" => 3,
        "S24_32LE" | "S32LE" | "F32LE" => 4,
        other => {
            log::warn!("[audio] unsupported PCM format: {other}");
            return None;
        }
    };
    Some(PcmFormat {
        sample_rate: rate,
        channels,
        gst_format: format.to_string(),
        bytes_per_sample: bps,
    })
}

#[cfg(target_os = "linux")]
fn gst_format_to_alsa(gst_format: &str) -> alsa::pcm::Format {
    match gst_format {
        "S16LE" => alsa::pcm::Format::S16LE,
        "S24LE" => alsa::pcm::Format::S243LE,
        "S24_32LE" => alsa::pcm::Format::S24LE,
        "S32LE" => alsa::pcm::Format::S32LE,
        "F32LE" => alsa::pcm::Format::FloatLE,
        _ => alsa::pcm::Format::S32LE,
    }
}

#[cfg(target_os = "linux")]
fn alsa_format_to_gst(alsa_fmt: alsa::pcm::Format) -> (&'static str, u32) {
    // Inverse of gst_format_to_alsa. The ALSA/GStreamer 24-bit naming is swapped:
    //   ALSA S24LE  = 24-in-32 container = GStreamer S24_32LE (4 bytes/sample)
    //   ALSA S243LE = packed 24-bit       = GStreamer S24LE   (3 bytes/sample)
    match alsa_fmt {
        alsa::pcm::Format::S32LE => ("S32LE", 4),
        alsa::pcm::Format::S24LE => ("S24_32LE", 4),
        alsa::pcm::Format::S243LE => ("S24LE", 3),
        alsa::pcm::Format::S16LE => ("S16LE", 2),
        alsa::pcm::Format::FloatLE => ("F32LE", 4),
        _ => ("S32LE", 4),
    }
}

/// Converts perceptual linear volume (0.0 to 1.0 from the UI)
/// into an audio amplitude curve (cubic taper, ~50 dB range).
#[inline]
fn slider_to_amplitude(slider_val: f64) -> f64 {
    slider_val.clamp(0.0, 1.0).powi(3)
}

/// Applies a normalization gain across all volume sinks: the GStreamer
/// `norm_vol` element (if present), the local `current_norm_gain` mirror, the
/// combined-volume atom (read by the ALSA writer), and the signal-path tracker.
/// Shared by `SetNormalizationGain` and the gapless `HandleGaplessAdvance` path.
fn apply_normalization_gain(
    gain: f64,
    current_norm_gain: &mut f64,
    norm_volume_el: Option<&gst::Element>,
    combined_vol: &Arc<AtomicU32>,
    current_volume: f64,
    signal_path: &SignalPathTracker,
) {
    *current_norm_gain = gain;
    if let Some(el) = norm_volume_el {
        el.set_property("volume", gain);
    }
    let amp = slider_to_amplitude(current_volume);
    combined_vol.store(((amp * gain) as f32).to_bits(), Ordering::Relaxed);
    signal_path.set_norm_gain_factor(gain as f32);
}

/// Probe which GStreamer format strings an ALSA device supports.
/// Returns a list like `["S32LE", "S24_32LE", "S16LE"]`.
#[cfg(target_os = "linux")]
fn probe_supported_gst_formats(pcm: &alsa::PCM) -> Vec<&'static str> {
    use alsa::pcm::{Format, HwParams};

    let Ok(hwp) = HwParams::any(pcm) else {
        return vec!["S32LE"]; // safe fallback
    };
    let probe: &[(Format, &str)] = &[
        (Format::S32LE, "S32LE"),
        (Format::S24LE, "S24_32LE"),  // ALSA S24LE = GStreamer S24_32LE
        (Format::S243LE, "S24LE"),    // ALSA S243LE = GStreamer S24LE
        (Format::FloatLE, "F32LE"),
        (Format::S16LE, "S16LE"),
    ];
    let supported: Vec<&str> = probe
        .iter()
        .filter(|(f, _)| hwp.test_format(*f).is_ok())
        .map(|(_, name)| *name)
        .collect();
    if supported.is_empty() {
        vec!["S32LE"] // safe fallback
    } else {
        supported
    }
}

/// Pick the bit-perfect capsfilter format for a given source.
/// Priority:
///   1. Pass-through if the DAC supports the source format directly (zero conversion work).
///   2. Narrowest lossless promotion the DAC supports (container widening or, for S24_32LE,
///      shrinking to S24LE which holds the same 24 audio bits in 3 bytes).
///   3. Lossy fallback: DAC's first probed format (widest per probe order).
/// In case 3, the writer's `resolve_pending` still emits a truthful from→to toast.
#[cfg(target_os = "linux")]
fn pick_capsfilter_format(source: &str, dac_supported: &[String]) -> String {
    // 1. Pass-through.
    if dac_supported.iter().any(|f| f == source) {
        return source.to_string();
    }
    // 2. Narrowest lossless promotion. audioconvert with dithering=none does pure
    //    integer bit-shift conversions between these formats — no quantization.
    //    S24_32LE → S24LE is safe because audioconvert writes a zero pad byte
    //    upstream; stripping it preserves the 24 audio bits exactly.
    let promotions: &[&str] = match source {
        "S16LE"    => &["S24LE", "S24_32LE", "S32LE"],
        "S24LE"    => &["S24_32LE", "S32LE"],
        "S24_32LE" => &["S24LE", "S32LE"], // S24LE = same 24 bits, narrower container
        _          => &[], // S32LE, F32LE, unknowns: no lossless integer alternative
    };
    if let Some(p) = promotions.iter().find(|p| dac_supported.iter().any(|f| f == *p)) {
        return (*p).to_string();
    }
    // 3. Lossy fallback — DAC's preferred (widest) format. PendingPromotion still
    //    fires from pad_added so the writer surfaces a truthful toast.
    dac_supported
        .first()
        .cloned()
        .unwrap_or_else(|| "S32LE".to_string())
}

/// Probe which standard sample rates an ALSA device supports.
/// Tests common audiophile rates and returns those that pass.
#[cfg(target_os = "linux")]
fn probe_supported_rates(pcm: &alsa::PCM) -> Vec<u32> {
    use alsa::pcm::HwParams;

    let Ok(hwp) = HwParams::any(pcm) else {
        return vec![44100, 48000]; // safe fallback
    };
    let candidates: &[u32] = &[
        44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000,
    ];
    let supported: Vec<u32> = candidates
        .iter()
        .copied()
        .filter(|&r| hwp.test_rate(r).is_ok())
        .collect();
    if supported.is_empty() {
        vec![44100, 48000] // safe fallback
    } else {
        supported
    }
}

// ── ALSA writer thread ─────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn configure_alsa_hwparams(
    pcm: &alsa::PCM,
    fmt: &PcmFormat,
    bit_perfect: bool,
) -> Result<PcmFormat, String> {
    use alsa::pcm::{Access, Format, HwParams};
    use alsa::ValueOr;

    let hwp = HwParams::any(pcm).map_err(|e| format!("HwParams::any failed: {e}"))?;
    hwp.set_access(Access::RWInterleaved)
        .map_err(|e| format!("set_access: {e}"))?;

    // Probe and log all supported formats
    let probe_formats: &[(Format, &str)] = &[
        (Format::S32LE, "S32LE (32-bit)"),
        (Format::S24LE, "S24LE (24-in-32)"),
        (Format::S243LE, "S24_3LE (24-bit packed)"),
        (Format::FloatLE, "F32LE (float)"),
        (Format::S16LE, "S16LE (16-bit)"),
    ];
    let supported: Vec<&str> = probe_formats
        .iter()
        .filter(|(f, _)| hwp.test_format(*f).is_ok())
        .map(|(_, name)| *name)
        .collect();
    log::debug!("[audio] DAC supported formats: [{}]", supported.join(", "));

    let requested = gst_format_to_alsa(&fmt.gst_format);

    let alsa_fmt = if bit_perfect {
        hwp.set_format(requested)
            .map_err(|e| format!("set_format({}): {e}", fmt.gst_format))?;
        requested
    } else {
        // Ranked fallback: requested first, then descending quality
        let fallbacks: &[Format] = &[
            Format::S32LE,
            Format::S24LE,   // 24-in-32 container
            Format::S243LE,  // 24-bit packed
            Format::FloatLE,
            Format::S16LE,
        ];
        let mut candidates: Vec<Format> = Vec::with_capacity(6);
        candidates.push(requested);
        for &f in fallbacks {
            if f != requested {
                candidates.push(f);
            }
        }
        let mut chosen = None;
        for &candidate in &candidates {
            if hwp.test_format(candidate).is_ok() {
                hwp.set_format(candidate)
                    .map_err(|e| format!("set_format after test: {e}"))?;
                chosen = Some(candidate);
                break;
            }
        }
        chosen.ok_or_else(|| {
            "Audio device does not support any compatible sample format".to_string()
        })?
    };

    if bit_perfect {
        hwp.set_rate_resample(false)
            .map_err(|e| format!("set_rate_resample: {e}"))?;
    }
    hwp.set_rate(fmt.sample_rate, ValueOr::Nearest)
        .map_err(|e| {
            if bit_perfect {
                log::warn!("[audio] bit-perfect set_rate({}) failed: {e}", fmt.sample_rate);
                format!(
                    "DAC doesn't support {}kHz — turn off bit-perfect mode for compatibility",
                    fmt.sample_rate / 1000
                )
            } else {
                format!("set_rate({}): {e}", fmt.sample_rate)
            }
        })?;
    if bit_perfect {
        let actual_rate = hwp.get_rate().map_err(|e| format!("get_rate: {e}"))?;
        if actual_rate != fmt.sample_rate {
            log::warn!(
                "[audio] bit-perfect rate mismatch: DAC negotiated {}Hz, track requires {}Hz",
                actual_rate, fmt.sample_rate
            );
            return Err(format!(
                "DAC doesn't support {}kHz — turn off bit-perfect mode for compatibility",
                fmt.sample_rate / 1000
            ));
        }
    }
    hwp.set_channels(fmt.channels)
        .map_err(|e| format!("set_channels({}): {e}", fmt.channels))?;
    hwp.set_buffer_time_near(500_000, ValueOr::Nearest)
        .map_err(|e| format!("set_buffer_time: {e}"))?;
    hwp.set_period_time_near(50_000, ValueOr::Nearest)
        .map_err(|e| format!("set_period_time: {e}"))?;
    pcm.hw_params(&hwp).map_err(|e| format!("hw_params: {e}"))?;

    // Configure sw_params: pre-fill buffer before DMA starts.
    // snd_pcm_hw_params() resets start_threshold to 1 (immediate start on first
    // writei), which causes underruns when the writer can't keep up from frame one.
    // Match GStreamer alsasink: start_threshold = buffer_size (full pre-fill).
    {
        let swp = pcm.sw_params_current()
            .map_err(|e| format!("sw_params_current: {e}"))?;
        let hwp_active = pcm.hw_params_current()
            .map_err(|e| format!("hw_params_current for sw: {e}"))?;
        let buffer_frames = hwp_active.get_buffer_size()
            .map_err(|e| format!("get_buffer_size: {e}"))?;
        let period_frames = hwp_active.get_period_size()
            .map_err(|e| format!("get_period_size: {e}"))?;
        // start_threshold: largest period-aligned value ≤ buffer_size.
        // With our time-near requests this equals buffer_size, but the
        // rounding guards against odd driver negotiations.
        let start = (buffer_frames / period_frames) * period_frames;
        swp.set_start_threshold(start as alsa::pcm::Frames)
            .map_err(|e| format!("set_start_threshold: {e}"))?;
        swp.set_avail_min(period_frames as alsa::pcm::Frames)
            .map_err(|e| format!("set_avail_min: {e}"))?;
        pcm.sw_params(&swp)
            .map_err(|e| format!("sw_params: {e}"))?;
        log::debug!(
            "[audio] sw_params committed: start_threshold={}, avail_min={}",
            start, period_frames
        );
    }

    // Log final negotiated hw_params
    if let Ok(active) = pcm.hw_params_current() {
        let rate = active.get_rate().unwrap_or(0);
        let channels = active.get_channels().unwrap_or(0);
        let buffer_frames = active.get_buffer_size().unwrap_or(0);
        let period_frames = active.get_period_size().unwrap_or(0);
        log::debug!(
            "[audio] hw_params committed: rate={}Hz, channels={}, buffer={} frames, period={} frames",
            rate, channels, buffer_frames, period_frames
        );
    }

    let (gst_fmt_str, bps) = alsa_format_to_gst(alsa_fmt);
    if alsa_fmt != requested {
        log::info!(
            "[audio] format fallback: {} -> {} (DAC doesn't support {})",
            fmt.gst_format, gst_fmt_str, fmt.gst_format
        );
    }
    let actual_rate = pcm.hw_params_current()
        .and_then(|p| p.get_rate())
        .unwrap_or(fmt.sample_rate);
    Ok(PcmFormat {
        sample_rate: actual_rate,
        channels: fmt.channels,
        gst_format: gst_fmt_str.to_string(),
        bytes_per_sample: bps,
    })
}

#[cfg(target_os = "linux")]
#[allow(clippy::too_many_arguments)]
fn spawn_alsa_writer(
    device: &str,
    initial_format: &PcmFormat,
    app_handle: tauri::AppHandle,
    tearing_down: Arc<AtomicBool>,
    frames_written: Arc<AtomicU64>,
    current_sample_rate: Arc<AtomicU32>,
    writer_gen: Arc<AtomicU64>,
    paused: Arc<AtomicBool>,
    bit_perfect: bool,
    combined_vol: Arc<AtomicU32>,
    signal_path: Arc<SignalPathTracker>,
    decoded_cell: Arc<Mutex<Option<crate::pipeline_probe::PadCaps>>>,
    output_cell: Arc<Mutex<Option<crate::pipeline_probe::PadCaps>>>,
) -> Result<(crossbeam_channel::Sender<WriterCommand>, JoinHandle<()>, PcmFormat, Vec<&'static str>, Vec<u32>), String> {
    let device = device.to_string();
    let initial_format = initial_format.clone();
    let (tx, rx) = crossbeam_channel::bounded::<WriterCommand>(256);

    // Open device eagerly to detect EBUSY immediately
    let pcm = alsa::PCM::new(&device, alsa::Direction::Playback, false).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("busy") || msg.contains("EBUSY") {
            "device_busy".to_string()
        } else {
            format!("Failed to open ALSA device: {e}")
        }
    })?;

    let supported_gst_formats = probe_supported_gst_formats(&pcm);
    log::debug!("[alsa-writer] DAC supported GStreamer formats: {:?}", supported_gst_formats);

    let supported_rates = probe_supported_rates(&pcm);
    log::debug!("[alsa-writer] DAC supported rates: {:?}", supported_rates);

    // Adjust initial format to something the DAC actually supports.
    // This is a placeholder — the real format arrives via FormatHint/pad_added
    // once GStreamer decodes the stream. We just need the DAC to accept it.
    let initial_format = {
        let mut fmt = initial_format;
        if !supported_gst_formats.contains(&fmt.gst_format.as_str()) {
            let best = supported_gst_formats[0]; // probe orders by quality (S32>S24>S16)
            let (_, bps) = alsa_format_to_gst(gst_format_to_alsa(best));
            log::info!(
                "[alsa-writer] DAC doesn't support {}, using {} for initial config",
                fmt.gst_format, best
            );
            fmt.gst_format = best.to_string();
            fmt.bytes_per_sample = bps;
        }
        if !supported_rates.is_empty() && !supported_rates.contains(&fmt.sample_rate) {
            let fallback = supported_rates[0]; // first probed rate (44100 typically)
            log::info!(
                "[alsa-writer] DAC doesn't support {}Hz, using {}Hz for initial config",
                fmt.sample_rate, fallback
            );
            fmt.sample_rate = fallback;
        }
        fmt
    };

    let requested_for_fallback = initial_format.clone();
    let initial_format = configure_alsa_hwparams(&pcm, &initial_format, bit_perfect)?;
    pcm.prepare().map_err(|e| format!("pcm.prepare: {e}"))?;
    current_sample_rate.store(initial_format.sample_rate, Ordering::Relaxed);
    let negotiated_fmt = initial_format.clone();

    signal_path.set_output(
        &initial_format.gst_format,
        initial_format.sample_rate,
        initial_format.channels,
    );
    if !bit_perfect && requested_for_fallback.gst_format != initial_format.gst_format {
        signal_path.record_format_fallback(
            &requested_for_fallback.gst_format,
            &initial_format.gst_format,
        );
    }

    let signal_path_thread = Arc::clone(&signal_path);
    let handle = std::thread::Builder::new()
        .name("alsa-writer".into())
        .spawn(move || {
            let sp = signal_path_thread;
            let mut pcm = pcm; // rebind as mutable for format-change reopen
            let mut current_fmt = initial_format;
            let period_duration = std::time::Duration::from_millis(50);

            let silence_frames = (current_fmt.sample_rate as usize * 50) / 1000;
            let mut silence_buf = vec![0u8; silence_frames * current_fmt.channels as usize * current_fmt.bytes_per_sample as usize];

            // Bit-perfect promotion announcement: pad_added sends only the source format,
            // writer emits the toast once the actually-negotiated `current_fmt` is known.
            let mut pending_promotion_from: Option<String> = None;
            let resolve_pending = |pending: &mut Option<String>, current: &PcmFormat| {
                if let Some(from) = pending.take() {
                    if from != current.gst_format {
                        log::info!("[alsa-writer] bit-depth promotion: {from} -> {}", current.gst_format);
                        sp.record_bit_depth_promotion(&from, &current.gst_format);
                        app_handle.emit(
                            "audio-bit-depth-changed",
                            serde_json::json!({ "from": from, "to": current.gst_format }),
                        ).ok();
                    } else {
                        log::debug!("[alsa-writer] bit-perfect: no promotion needed ({from})");
                    }
                }
            };

            // Recover from ALSA errors (XRUN, suspend, etc.)
            fn alsa_recover(pcm: &alsa::PCM, errno: i32) -> bool {
                if errno == libc::EPIPE {
                    log::warn!("[alsa-writer] XRUN, recovering");
                    pcm.prepare().ok();
                    true
                } else if errno == libc::ESTRPIPE {
                    let mut recovered = false;
                    loop {
                        match pcm.resume() {
                            Ok(_) => { recovered = true; break; }
                            Err(e) if e.errno() == libc::EAGAIN => {
                                std::thread::sleep(std::time::Duration::from_millis(10));
                            }
                            Err(_) => {
                                if pcm.prepare().is_ok() { recovered = true; }
                                break;
                            }
                        }
                    }
                    recovered
                } else {
                    false
                }
            }

            fn write_bytes(pcm: &alsa::PCM, data: &[u8], fmt: &PcmFormat, fw: &AtomicU64, silence_buf: &[u8]) -> Result<(), &'static str> {
                let frame_size = fmt.channels as usize * fmt.bytes_per_sample as usize;
                if frame_size == 0 { return Ok(()); }
                let mut offset = 0;
                while offset < data.len() {
                    let result = {
                        let io = pcm.io_bytes();
                        io.writei(&data[offset..])
                    }; // io dropped here — flag cleared before any recovery
                    match result {
                        Ok(0) => break, // sub-frame remnant
                        Ok(frames) => {
                            offset += frames * frame_size;
                            fw.fetch_add(frames as u64, Ordering::Relaxed);
                        }
                        Err(e) => {
                            let errno = e.errno();
                            if alsa_recover(pcm, errno) {
                                let kick_frames = (fmt.sample_rate as usize * 50) / 1000;
                                let kick_bytes = kick_frames * frame_size;
                                let io = pcm.io_bytes();
                                let _ = io.writei(&silence_buf[..kick_bytes.min(silence_buf.len())]);
                            } else if errno == libc::ENODEV {
                                return Err("device_disconnected");
                            } else {
                                log::error!("[alsa-writer] write error: {e}");
                                return Err("write_error");
                            }
                        }
                    }
                }
                Ok(())
            }

            fn write_silence(pcm: &alsa::PCM, buf: &[u8]) -> bool {
                let result = {
                    let io = pcm.io_bytes();
                    io.writei(buf)
                }; // io dropped here
                match result {
                    Ok(_) => {}
                    Err(e) if alsa_recover(pcm, e.errno()) => {
                        let io = pcm.io_bytes();
                        let _ = io.writei(buf);
                    }
                    Err(e) => {
                        log::error!("[alsa-writer] silence write error: {e}");
                        return false;
                    }
                }
                true
            }

            /// Scale raw PCM samples in-place by a volume multiplier.
            fn apply_volume(data: &mut [u8], fmt: &PcmFormat, vol: f32) {
                if (vol - 1.0).abs() < f32::EPSILON {
                    return; // unity gain — no-op
                }
                match fmt.gst_format.as_str() {
                    "S16LE" => {
                        for chunk in data.chunks_exact_mut(2) {
                            let s = i16::from_le_bytes([chunk[0], chunk[1]]);
                            let v = (s as f32 * vol).round() as i32;
                            let clamped = v.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
                            chunk.copy_from_slice(&clamped.to_le_bytes());
                        }
                    }
                    "S32LE" => {
                        for chunk in data.chunks_exact_mut(4) {
                            let s = i32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                            let v = (s as f64 * vol as f64).round() as i64;
                            let clamped = v.clamp(i32::MIN as i64, i32::MAX as i64) as i32;
                            chunk.copy_from_slice(&clamped.to_le_bytes());
                        }
                    }
                    "S24_32LE" => {
                        for chunk in data.chunks_exact_mut(4) {
                            let s = i32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                            let v = (s as f64 * vol as f64).round() as i64;
                            let clamped = v.clamp(-8_388_608, 8_388_607) as i32;
                            chunk.copy_from_slice(&clamped.to_le_bytes());
                        }
                    }
                    "S24LE" => {
                        for chunk in data.chunks_exact_mut(3) {
                            let raw = chunk[0] as i32 | (chunk[1] as i32) << 8 | (chunk[2] as i8 as i32) << 16;
                            let v = (raw as f64 * vol as f64).round() as i64;
                            let clamped = v.clamp(-8_388_608, 8_388_607) as i32;
                            chunk[0] = clamped as u8;
                            chunk[1] = (clamped >> 8) as u8;
                            chunk[2] = (clamped >> 16) as u8;
                        }
                    }
                    "F32LE" => {
                        for chunk in data.chunks_exact_mut(4) {
                            let s = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                            chunk.copy_from_slice(&(s * vol).clamp(-1.0, 1.0).to_le_bytes());
                        }
                    }
                    _ => {}
                }
            }

            /// Close and reopen ALSA device with new format.
            /// Some hardware (e.g. XMOS USB controllers) can't reconfigure
            /// HW params in-place after snd_pcm_drop() — need full close+reopen.
            fn reopen_alsa(
                device: &str,
                fmt: &PcmFormat,
                sr: &AtomicU32,
                sbuf: &mut Vec<u8>,
                bit_perfect: bool,
            ) -> Result<(alsa::PCM, PcmFormat), String> {
                let pcm = alsa::PCM::new(device, alsa::Direction::Playback, false)
                    .map_err(|e| format!("Failed to reopen ALSA device: {e}"))?;
                let negotiated = configure_alsa_hwparams(&pcm, fmt, bit_perfect)?;
                pcm.prepare().map_err(|e| format!("pcm.prepare: {e}"))?;
                sr.store(negotiated.sample_rate, Ordering::Relaxed);
                let silence_frames = (negotiated.sample_rate as usize * 50) / 1000;
                *sbuf = vec![0u8; silence_frames * negotiated.channels as usize * negotiated.bytes_per_sample as usize];
                Ok((pcm, negotiated))
            }

            fn drain_writer_rx(rx: &crossbeam_channel::Receiver<WriterCommand>) -> bool {
                while let Ok(cmd) = rx.try_recv() {
                    if let WriterCommand::Shutdown = cmd { return true; }
                }
                false
            }

            log::info!(
                "[alsa-writer] started, device={device}, format={}, rate={}Hz, channels={}, bps={}, combined_vol={}",
                current_fmt.gst_format, current_fmt.sample_rate, current_fmt.channels, current_fmt.bytes_per_sample,
                f32::from_bits(combined_vol.load(Ordering::Relaxed))
            );

            'main: loop {
                match rx.recv_timeout(period_duration) {
                    Ok(WriterCommand::Data(mut chunk)) => {
                        if chunk.generation < writer_gen.load(Ordering::Acquire) {
                            continue; // discard stale data from old pipeline
                        }

                        // Pause: freeze output immediately, spin until resumed
                        if paused.load(Ordering::Acquire) {
                            let can_hw = pcm.state() == alsa::pcm::State::Running
                                && pcm.hw_params_current().map(|p| p.can_pause()).unwrap_or(false);
                            if can_hw { pcm.pause(true).ok(); }

                            while paused.load(Ordering::Acquire) {
                                if can_hw {
                                    // HW pause: DAC frozen, nothing to feed — just sleep
                                    std::thread::sleep(std::time::Duration::from_millis(50));
                                } else {
                                    // SW pause: blocking writei paces the thread (~50ms per period)
                                    if !write_silence(&pcm, &silence_buf) {
                                        *decoded_cell.lock().unwrap() = None;
                                        *output_cell.lock().unwrap() = None;
                                        app_handle.emit("audio-error",
                                            serde_json::json!({ "kind": "device_disconnected" })).ok();
                                        tearing_down.store(true, Ordering::SeqCst);
                                        break 'main;
                                    }
                                }
                            }

                            if can_hw {
                                pcm.pause(false).ok();
                            } else {
                                // Clear silence from ring buffer after software pause
                                pcm.drop().ok();
                                pcm.prepare().ok();
                            }

                            // Re-check generation — may have changed during pause (track change)
                            if chunk.generation < writer_gen.load(Ordering::Acquire) {
                                continue;
                            }
                        }

                        if chunk.format != current_fmt {
                            log::info!("[alsa-writer] format change: {current_fmt:?} -> {:?}", chunk.format);
                            sp.set_decoded(&chunk.format.gst_format, chunk.format.sample_rate, chunk.format.channels);
                            drop(pcm);
                            match reopen_alsa(&device, &chunk.format, &current_sample_rate, &mut silence_buf, bit_perfect) {
                                Ok((new_pcm, negotiated)) => {
                                    pcm = new_pcm;
                                    if negotiated.gst_format != chunk.format.gst_format {
                                        log::error!(
                                            "[alsa-writer] format mismatch after reopen: chunk={}, ALSA={}",
                                            chunk.format.gst_format, negotiated.gst_format
                                        );
                                        app_handle.emit("audio-error",
                                            serde_json::json!({ "kind": "device_changed" })).ok();
                                        tearing_down.store(true, Ordering::SeqCst);
                                        return;
                                    }
                                    sp.set_output(&negotiated.gst_format, negotiated.sample_rate, negotiated.channels);
                                    if !bit_perfect && chunk.format.gst_format != negotiated.gst_format {
                                        sp.record_format_fallback(&chunk.format.gst_format, &negotiated.gst_format);
                                    } else {
                                        sp.clear_format_fallback();
                                    }
                                    current_fmt = negotiated;
                                }
                                Err(e) => {
                                    log::error!("[alsa-writer] reopen failed: {e}");
                                    app_handle.emit("audio-error", serde_json::json!({ "kind": "format_change_failed", "message": e })).ok();
                                    tearing_down.store(true, Ordering::SeqCst);
                                    return; // pcm already dropped, just exit thread
                                }
                            }
                        }
                        resolve_pending(&mut pending_promotion_from, &current_fmt);
                        let vol = f32::from_bits(combined_vol.load(Ordering::Relaxed));
                        apply_volume(&mut chunk.data, &current_fmt, vol);
                        if let Err(kind) = write_bytes(&pcm, &chunk.data, &current_fmt, &frames_written, &silence_buf) {
                            app_handle.emit("audio-error", serde_json::json!({ "kind": kind })).ok();
                            tearing_down.store(true, Ordering::SeqCst);
                            break;
                        }
                    }

                    Ok(WriterCommand::FormatHint(new_fmt)) => {
                        sp.set_decoded(&new_fmt.gst_format, new_fmt.sample_rate, new_fmt.channels);
                        if new_fmt != current_fmt {
                            log::info!("[alsa-writer] format hint: {current_fmt:?} -> {new_fmt:?}");
                            let requested = new_fmt.clone();
                            drop(pcm);
                            match reopen_alsa(&device, &new_fmt, &current_sample_rate, &mut silence_buf, bit_perfect) {
                                Ok((new_pcm, negotiated)) => {
                                    pcm = new_pcm;
                                    sp.set_output(&negotiated.gst_format, negotiated.sample_rate, negotiated.channels);
                                    if !bit_perfect && requested.gst_format != negotiated.gst_format {
                                        sp.record_format_fallback(&requested.gst_format, &negotiated.gst_format);
                                    } else {
                                        sp.clear_format_fallback();
                                    }
                                    current_fmt = negotiated;
                                }
                                Err(e) => {
                                    log::error!("[alsa-writer] reopen for format hint failed: {e}");
                                    app_handle.emit("audio-error", serde_json::json!({ "kind": "format_change_failed", "message": e })).ok();
                                    tearing_down.store(true, Ordering::SeqCst);
                                    return;
                                }
                            }
                        }
                        resolve_pending(&mut pending_promotion_from, &current_fmt);
                    }

                    Ok(WriterCommand::Resampling { from, to }) => {
                        log::info!("[alsa-writer] resampling: {}kHz -> {}kHz", from / 1000, to / 1000);
                        sp.record_resample(from, to);
                        app_handle.emit("audio-resampled",
                            serde_json::json!({ "from": from, "to": to })).ok();
                    }

                    Ok(WriterCommand::PendingPromotion { from, generation }) => {
                        if generation < writer_gen.load(Ordering::Acquire) {
                            continue; // stale promotion from old pipeline
                        }
                        // Last-write-wins: overwrites any prior unresolved pending.
                        // resolve_pending will fire sp.record_bit_depth_promotion()
                        // once the actually-negotiated format is known.
                        pending_promotion_from = Some(from);
                    }

                    Ok(WriterCommand::EndOfTrack { emit_finished, generation }) => {
                        if generation < writer_gen.load(Ordering::Acquire) {
                            continue; // stale EOS from old pipeline
                        }
                        let got_shutdown = drain_writer_rx(&rx);
                        if !write_silence(&pcm, &silence_buf) {
                            *decoded_cell.lock().unwrap() = None;
                            *output_cell.lock().unwrap() = None;
                            app_handle.emit("audio-error",
                                serde_json::json!({ "kind": "device_disconnected" })).ok();
                            tearing_down.store(true, Ordering::SeqCst);
                            break 'main;
                        }

                        if emit_finished && !tearing_down.load(Ordering::SeqCst) {
                            log::debug!("[alsa-writer] emitting track-finished");
                            app_handle.emit("track-finished", ()).ok();
                        }

                        if got_shutdown { break; }

                        // Idle silence loop — keep DAC clock alive between tracks
                        log::debug!("[alsa-writer] entering idle silence loop");
                        loop {
                            if !write_silence(&pcm, &silence_buf) {
                                *decoded_cell.lock().unwrap() = None;
                                *output_cell.lock().unwrap() = None;
                                app_handle.emit("audio-error",
                                    serde_json::json!({ "kind": "device_disconnected" })).ok();
                                tearing_down.store(true, Ordering::SeqCst);
                                break 'main;
                            }
                            match rx.try_recv() {
                                Ok(WriterCommand::Data(mut chunk)) => {
                                    if chunk.generation < writer_gen.load(Ordering::Acquire) {
                                        continue; // discard stale data, stay in idle
                                    }
                                    if chunk.format != current_fmt {
                                        sp.set_decoded(&chunk.format.gst_format, chunk.format.sample_rate, chunk.format.channels);
                                        // reopen_alsa drops old PCM — buffer cleared implicitly
                                        drop(pcm);
                                        match reopen_alsa(&device, &chunk.format, &current_sample_rate, &mut silence_buf, bit_perfect) {
                                            Ok((new_pcm, negotiated)) => {
                                                pcm = new_pcm;
                                                if negotiated.gst_format != chunk.format.gst_format {
                                                    log::error!(
                                                        "[alsa-writer] format mismatch after reopen (idle): chunk={}, ALSA={}",
                                                        chunk.format.gst_format, negotiated.gst_format
                                                    );
                                                    app_handle.emit("audio-error",
                                                        serde_json::json!({ "kind": "device_changed" })).ok();
                                                    tearing_down.store(true, Ordering::SeqCst);
                                                    return;
                                                }
                                                sp.set_output(&negotiated.gst_format, negotiated.sample_rate, negotiated.channels);
                                                if !bit_perfect && chunk.format.gst_format != negotiated.gst_format {
                                                    sp.record_format_fallback(&chunk.format.gst_format, &negotiated.gst_format);
                                                } else {
                                                    sp.clear_format_fallback();
                                                }
                                                current_fmt = negotiated;
                                            }
                                            Err(e) => {
                                                log::error!("[alsa-writer] reopen failed in idle: {e}");
                                                app_handle.emit("audio-error", serde_json::json!({ "kind": "format_change_failed", "message": e })).ok();
                                                return;
                                            }
                                        }
                                    } else {
                                        // Same format — flush stale silence from ring buffer
                                        pcm.drop().ok();
                                        pcm.prepare().ok();
                                    }
                                    resolve_pending(&mut pending_promotion_from, &current_fmt);
                                    let vol = f32::from_bits(combined_vol.load(Ordering::Relaxed));
                                    apply_volume(&mut chunk.data, &current_fmt, vol);
                                    if let Err(kind) = write_bytes(&pcm, &chunk.data, &current_fmt, &frames_written, &silence_buf) {
                                        app_handle.emit("audio-error", serde_json::json!({ "kind": kind })).ok();
                                        break 'main;
                                    }
                                    break; // back to main loop
                                }
                                Ok(WriterCommand::Shutdown) => break 'main,
                                Ok(WriterCommand::Flush) => { drain_writer_rx(&rx); pcm.drop().ok(); pcm.prepare().ok(); pending_promotion_from = None; break; }
                                Ok(WriterCommand::FormatHint(new_fmt)) => {
                                    sp.set_decoded(&new_fmt.gst_format, new_fmt.sample_rate, new_fmt.channels);
                                    if new_fmt != current_fmt {
                                        log::info!("[alsa-writer] format hint (idle): {current_fmt:?} -> {new_fmt:?}");
                                        let requested = new_fmt.clone();
                                        drop(pcm);
                                        match reopen_alsa(&device, &new_fmt, &current_sample_rate, &mut silence_buf, bit_perfect) {
                                            Ok((new_pcm, negotiated)) => {
                                                pcm = new_pcm;
                                                sp.set_output(&negotiated.gst_format, negotiated.sample_rate, negotiated.channels);
                                                if !bit_perfect && requested.gst_format != negotiated.gst_format {
                                                    sp.record_format_fallback(&requested.gst_format, &negotiated.gst_format);
                                                } else {
                                                    sp.clear_format_fallback();
                                                }
                                                current_fmt = negotiated;
                                            }
                                            Err(e) => {
                                                log::error!("[alsa-writer] reopen for format hint failed (idle): {e}");
                                                app_handle.emit("audio-error", serde_json::json!({ "kind": "format_change_failed", "message": e })).ok();
                                                return;
                                            }
                                        }
                                    }
                                    resolve_pending(&mut pending_promotion_from, &current_fmt);
                                }
                                Ok(WriterCommand::Resampling { from, to }) => {
                                    sp.record_resample(from, to);
                                }
                                Ok(WriterCommand::PendingPromotion { from, generation }) => {
                                    if generation < writer_gen.load(Ordering::Acquire) {
                                        continue;
                                    }
                                    pending_promotion_from = Some(from);
                                }
                                Ok(_) => {}
                                Err(crossbeam_channel::TryRecvError::Empty) => {}
                                Err(crossbeam_channel::TryRecvError::Disconnected) => break 'main,
                            }
                        }
                    }

                    Ok(WriterCommand::Flush) => {
                        drain_writer_rx(&rx);
                        pcm.drop().ok();
                        pcm.prepare().ok();
                        pending_promotion_from = None;
                    }

                    Ok(WriterCommand::Shutdown) => {
                        log::debug!("[alsa-writer] shutdown");
                        pcm.drop().ok();
                        break;
                    }

                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                        if !write_silence(&pcm, &silence_buf) {
                            *decoded_cell.lock().unwrap() = None;
                            *output_cell.lock().unwrap() = None;
                            app_handle.emit("audio-error",
                                serde_json::json!({ "kind": "device_disconnected" })).ok();
                            tearing_down.store(true, Ordering::SeqCst);
                            break 'main;
                        }
                    }

                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                        log::debug!("[alsa-writer] channel disconnected");
                        pcm.drop().ok();
                        break;
                    }
                }
            }

            log::info!("[alsa-writer] thread exiting");
        })
        .map_err(|e| format!("Failed to spawn ALSA writer thread: {e}"))?;

    Ok((tx, handle, negotiated_fmt, supported_gst_formats, supported_rates))
}

// ── Audio command protocol ─────────────────────────────────────────────

enum AudioCommand {
    PlayUrl {
        uri: String,
        reply: Reply<Result<(), String>>,
    },
    Pause {
        reply: Reply<Result<(), String>>,
    },
    Resume {
        reply: Reply<Result<(), String>>,
    },
    Stop {
        reply: Reply<Result<(), String>>,
    },
    SetVolume {
        level: f32,
        reply: Reply<Result<(), String>>,
    },
    SetNormalizationGain {
        gain: f64,
        reply: Reply<Result<(), String>>,
    },
    Seek {
        position_secs: f32,
        reply: Reply<Result<(), String>>,
    },
    GetPosition {
        reply: Reply<Result<f32, String>>,
    },
    IsFinished {
        reply: Reply<Result<bool, String>>,
    },
    SetExclusiveMode {
        enabled: bool,
        device: Option<String>,
        reply: Reply<Result<(), String>>,
    },
    SetBitPerfect {
        enabled: bool,
        reply: Reply<Result<(), String>>,
    },
    SetGapless {
        enabled: bool,
        reply: Reply<Result<(), String>>,
    },
    SetNextTrack {
        uri: String,
        norm_gain: f64,
        track_id: u64,
        qid: String,
        replay_gain: f64,
        peak_amplitude: f64,
        is_dash: bool,
        reply: Reply<Result<(), String>>,
    },
    ClearNextTrack {
        reply: Reply<Result<(), String>>,
    },
    /// Sent by the bus thread on a confirmed gapless STREAM_START boundary.
    HandleGaplessAdvance {
        track_id: u64,
        qid: String,
        norm_gain: f64,
        replay_gain: f64,
        peak_amplitude: f64,
    },
    ListDevices {
        reply: Reply<Result<Vec<AudioDevice>, String>>,
    },
}

// ── AudioPlayer (public API unchanged) ─────────────────────────────────

#[derive(Clone)]
pub struct AudioPlayer {
    cmd_tx: mpsc::Sender<AudioCommand>,
    /// Latest exclusive ALSA device set via `SetExclusiveMode`. Mirrored from
    /// the audio thread so the pipeline probe can read it without messaging.
    exclusive_device: Arc<Mutex<Option<String>>>,
    decoded_caps_cell: Arc<Mutex<Option<crate::pipeline_probe::PadCaps>>>,
    output_caps_cell: Arc<Mutex<Option<crate::pipeline_probe::PadCaps>>>,
}

impl AudioPlayer {
    pub fn new(app_handle: tauri::AppHandle, signal_path: Arc<SignalPathTracker>) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel::<AudioCommand>();
        // Clone a self-sender into the worker so the Normal bus thread can send
        // HandleGaplessAdvance back to this loop (Task 3). `cmd_tx` itself is
        // owned by AudioPlayer, not the worker closure.
        let cmd_tx_worker = cmd_tx.clone();
        let exclusive_device: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let exclusive_device_thread = exclusive_device.clone();
        let decoded_caps_cell: Arc<Mutex<Option<crate::pipeline_probe::PadCaps>>> =
            Arc::new(Mutex::new(None));
        let output_caps_cell: Arc<Mutex<Option<crate::pipeline_probe::PadCaps>>> =
            Arc::new(Mutex::new(None));
        let decoded_cell_thread = Arc::clone(&decoded_caps_cell);
        let output_cell_thread = Arc::clone(&output_caps_cell);

        std::thread::spawn(move || {
            // GStreamer plugin path setup
            if std::env::var("GST_PLUGIN_PATH_1_0").is_ok() || std::env::var("APPDIR").is_ok() {
                if let Ok(path) = std::env::var("GST_PLUGIN_PATH_1_0") {
                    std::env::set_var("GST_PLUGIN_PATH", &path);
                }
            } else if std::env::var("GST_PLUGIN_PATH").is_err() {
                for dir in [
                    "/usr/lib/x86_64-linux-gnu/gstreamer-1.0",
                    "/usr/lib64/gstreamer-1.0",
                    "/usr/lib/gstreamer-1.0",
                ] {
                    if std::path::Path::new(dir).is_dir() {
                        std::env::set_var("GST_PLUGIN_PATH", dir);
                        break;
                    }
                }
            }

            gst::init().expect("Failed to initialize GStreamer");

            let mut backend: Option<PlaybackBackend> = None;
            // ALSA writer state — lives outside PlaybackBackend so it persists across track changes
            let mut writer_tx: Option<crossbeam_channel::Sender<WriterCommand>> = None;
            let mut writer_thread: Option<JoinHandle<()>> = None;
            let mut writer_fmt: Option<PcmFormat> = None;
            let mut writer_supported_fmts: Option<Vec<&'static str>> = None;
            let mut writer_supported_rates: Option<Vec<u32>> = None;
            let mut writer_device: Option<String> = None;
            let frames_written = Arc::new(AtomicU64::new(0));
            let current_sample_rate = Arc::new(AtomicU32::new(48000));
            let writer_gen = Arc::new(AtomicU64::new(0));
            let paused = Arc::new(AtomicBool::new(false));
            let combined_vol = Arc::new(AtomicU32::new(1.0_f32.to_bits()));

            let eos = Arc::new(AtomicBool::new(false));
            let tearing_down = Arc::new(AtomicBool::new(false));
            let has_uri = AtomicBool::new(false);

            let mut exclusive = false;
            let mut bit_perfect = false;
            let mut device: Option<String> = None;

            let mut current_volume: f64 = 1.0;
            let mut current_norm_gain: f64 = 1.0;
            let mut track_generation: u64 = 0;

            // Gapless state. `gapless_setting` defaults to true and is pushed
            // from saved settings at startup via `set_gapless` (the worker has
            // no access to AppState). `cmd_tx_worker` is the self-sender the
            // Normal bus thread clones to deliver HandleGaplessAdvance (Task 3).
            let mut gapless_setting: bool = true;
            let gapless_capable: bool = gapless_supported();
            let next_track: Arc<Mutex<Option<NextTrack>>> = Arc::new(Mutex::new(None));
            let pending_advance: Arc<Mutex<Option<PendingAdvance>>> = Arc::new(Mutex::new(None));
            let cmd_tx_worker = cmd_tx_worker;

            for cmd in cmd_rx {
                match cmd {
                    AudioCommand::PlayUrl { uri, reply } => {
                        let result = (|| -> Result<(), String> {
                            // Every PlayUrl is a non-advance boundary: clear any
                            // armed gapless slots so a stale next/pending can't fire.
                            *next_track.lock().unwrap() = None;
                            *pending_advance.lock().unwrap() = None;
                            // ── Teardown old backend (GStreamer pipeline only) ──
                            if let Some(old_backend) = backend.take() {
                                tearing_down.store(true, Ordering::SeqCst);

                                match old_backend {
                                    PlaybackBackend::Normal {
                                        pipeline,
                                        user_volume_el,
                                        ..
                                    } => {
                                        if let Some(bus) = pipeline.bus() {
                                            bus.set_flushing(true);
                                        }
                                        let old_pipe = pipeline;
                                        std::thread::spawn(move || {
                                            // Fade out
                                            if let Some(ref vol) = user_volume_el {
                                                for i in (0..=10).rev() {
                                                    vol.set_property("volume", slider_to_amplitude(current_volume) * (i as f64 / 10.0));
                                                    std::thread::sleep(std::time::Duration::from_millis(10));
                                                }
                                            }
                                            old_pipe.set_state(gst::State::Null).ok();
                                        });
                                    }
                                    PlaybackBackend::DirectAlsa { pipeline, .. } => {
                                        // Unblock writer if paused, then bump generation —
                                        // writer instantly discards stale Data, channel
                                        // drains fast, pipeline can reach Null without blocking.
                                        paused.store(false, Ordering::Release);
                                        track_generation += 1;
                                        writer_gen.store(track_generation, Ordering::Release);
                                        if let Some(ref tx) = writer_tx {
                                            let _ = tx.send_timeout(
                                                WriterCommand::Flush,
                                                std::time::Duration::from_millis(200),
                                            );
                                        }
                                        if let Some(bus) = pipeline.bus() {
                                            bus.set_flushing(true);
                                        }
                                        pipeline.set_state(gst::State::Null).ok();
                                        let _ = pipeline.state(gst::ClockTime::from_mseconds(500));
                                        drop(pipeline);
                                    }
                                }

                                log::debug!("[audio] teardown: complete");
                            }
                            tearing_down.store(false, Ordering::SeqCst);
                            eos.store(false, Ordering::SeqCst);
                            has_uri.store(true, Ordering::SeqCst);
                            frames_written.store(0, Ordering::Relaxed);

                            *decoded_cell_thread.lock().unwrap() = None;
                            *output_cell_thread.lock().unwrap() = None;
                            signal_path.reset_for_track();
                            if exclusive || bit_perfect {
                                signal_path.set_backend("DirectAlsa", device.clone());
                            } else {
                                signal_path.set_backend("Normal", None);
                            }
                            signal_path.set_audio_modes(exclusive, bit_perfect);

                            if exclusive || bit_perfect {
                                // ── DirectAlsa path ──
                                #[cfg(not(target_os = "linux"))]
                                return Err("Exclusive/bit-perfect mode requires Linux".into());

                                #[cfg(target_os = "linux")]
                                {
                                    let dev = device.as_deref().ok_or_else(|| {
                                        "No audio device selected for exclusive mode".to_string()
                                    })?;

                                    let default_fmt = PcmFormat {
                                        sample_rate: 48000,
                                        channels: 2,
                                        gst_format: "S32LE".to_string(),
                                        bytes_per_sample: 4,
                                    };

                                    // Bump generation again: the old appsink may have
                                    // pushed chunks (stamped gen N+1) from its internal
                                    // queue between the Flush and set_state(Null).
                                    // Gen N+2 causes the writer to discard them instantly
                                    // instead of writing each to ALSA at audio rate (~85ms).
                                    track_generation += 1;
                                    writer_gen.store(track_generation, Ordering::Release);

                                    // Reuse writer if alive, otherwise spawn new one
                                    let writer_alive = writer_thread
                                        .as_ref()
                                        .map(|h| !h.is_finished())
                                        .unwrap_or(false);

                                    let device_changed = writer_device.as_deref() != Some(dev);

                                    if !writer_alive || writer_tx.is_none() || device_changed {
                                        // Shut down old writer cleanly
                                        if let Some(tx) = writer_tx.take() {
                                            tx.try_send(WriterCommand::Shutdown).ok();
                                        }
                                        if let Some(h) = writer_thread.take() {
                                            h.join().ok();
                                        }
                                        let (tx, handle, negotiated_fmt, supported_gst_fmts, supported_rates) = spawn_alsa_writer(
                                            dev,
                                            &default_fmt,
                                            app_handle.clone(),
                                            Arc::clone(&tearing_down),
                                            Arc::clone(&frames_written),
                                            Arc::clone(&current_sample_rate),
                                            Arc::clone(&writer_gen),
                                            Arc::clone(&paused),
                                            bit_perfect,
                                            Arc::clone(&combined_vol),
                                            Arc::clone(&signal_path),
                                            Arc::clone(&decoded_cell_thread),
                                            Arc::clone(&output_cell_thread),
                                        )?;
                                        writer_tx = Some(tx);
                                        writer_thread = Some(handle);
                                        writer_fmt = Some(negotiated_fmt);
                                        writer_supported_fmts = Some(supported_gst_fmts);
                                        writer_supported_rates = Some(supported_rates);
                                        writer_device = Some(dev.to_string());
                                    }

                                    let wtx = writer_tx.as_ref().unwrap().clone();

                                    // Build appsink pipeline
                                    let fmt_for_pipeline = writer_fmt.as_ref().unwrap_or(&default_fmt);
                                    let supported_fmts_for_pipeline = writer_supported_fmts.as_deref().unwrap_or(&["S32LE"]);
                                    let supported_rates_for_pipeline = writer_supported_rates.as_deref().unwrap_or(&[44100, 48000]);
                                    let (pipe, u_vol, n_vol) = build_appsink_pipeline(
                                        &uri,
                                        exclusive,
                                        bit_perfect,
                                        wtx.clone(),
                                        Arc::clone(&writer_gen),
                                        fmt_for_pipeline,
                                        supported_fmts_for_pipeline,
                                        supported_rates_for_pipeline,
                                        Arc::clone(&decoded_cell_thread),
                                        Arc::clone(&output_cell_thread),
                                    )?;

                                    // Start pipeline directly — errors come via bus watcher
                                    pipe.set_state(gst::State::Playing)
                                        .map_err(|e| format!("Failed to start playback: {e}"))?;

                                    // Bus watcher: decode errors + EOS → forward to writer
                                    let eos_flag = Arc::clone(&eos);
                                    let app_handle_clone = app_handle.clone();
                                    let writer_tx_bus = wtx;
                                    let bus_gen = Arc::clone(&writer_gen);
                                    let tearing_down_bus = Arc::clone(&tearing_down);
                                    if let Some(bus) = pipe.bus() {
                                        std::thread::spawn(move || {
                                            for msg in bus.iter_timed(gst::ClockTime::NONE) {
                                                match msg.view() {
                                                    gst::MessageView::Eos(..) => {
                                                        eos_flag.store(true, Ordering::SeqCst);
                                                        writer_tx_bus
                                                            .send(WriterCommand::EndOfTrack {
                                                                emit_finished: true,
                                                                generation: bus_gen
                                                                    .load(Ordering::Acquire),
                                                            })
                                                            .ok();
                                                        break;
                                                    }
                                                    gst::MessageView::Error(err) => {
                                                        let err_msg = err.error().to_string();
                                                        let debug_str = err
                                                            .debug()
                                                            .map(|s| s.to_string())
                                                            .unwrap_or_default();
                                                        log::error!(
                                                            "GStreamer error: {} (debug: {})",
                                                            err_msg,
                                                            debug_str
                                                        );
                                                        eos_flag.store(true, Ordering::SeqCst);
                                                        if !tearing_down_bus.load(Ordering::SeqCst)
                                                        {
                                                            app_handle_clone
                                                                .emit(
                                                                    "audio-error",
                                                                    serde_json::json!({
                                                                        "kind": "playback_error",
                                                                        "message": err_msg
                                                                    }),
                                                                )
                                                                .ok();
                                                        }
                                                        writer_tx_bus
                                                            .send(WriterCommand::EndOfTrack {
                                                                emit_finished: false,
                                                                generation: bus_gen
                                                                    .load(Ordering::Acquire),
                                                            })
                                                            .ok();
                                                        break;
                                                    }
                                                    gst::MessageView::Buffering(b) => {
                                                        log::debug!(
                                                            "[audio] direct-alsa: buffering {}%",
                                                            b.percent()
                                                        );
                                                    }
                                                    _ => {}
                                                }
                                            }
                                        });
                                    }

                                    backend = Some(PlaybackBackend::DirectAlsa {
                                        pipeline: pipe,
                                        user_volume_el: u_vol,
                                        norm_volume_el: n_vol,
                                    });
                                }
                            } else {
                                // ── Normal path (unchanged) ──
                                // Shut down any lingering ALSA writer from a mode switch
                                if let Some(tx) = writer_tx.take() {
                                    tx.try_send(WriterCommand::Shutdown).ok();
                                }
                                if let Some(h) = writer_thread.take() {
                                    h.join().ok();
                                }

                                let pipe = gst::Pipeline::new();
                                let is_dash = uri.starts_with("data:application/dash");
                                let decoder_name = if gapless_setting && gapless_capable {
                                    "uridecodebin3"
                                } else {
                                    "uridecodebin"
                                };
                                log::debug!("[audio] normal decoder: {decoder_name}");
                                let mut udb =
                                    gst::ElementFactory::make(decoder_name).property("uri", &uri);
                                if is_dash {
                                    udb = udb
                                        .property("buffer-duration", 15_000_000_000i64)
                                        .property("use-buffering", true);
                                } else {
                                    udb = udb
                                        .property("buffer-duration", 5_000_000_000i64)
                                        .property("use-buffering", true);
                                }
                                let uridecodebin = udb
                                    .build()
                                    .map_err(|e| format!("Failed to create {decoder_name}: {e}"))?;
                                let audioconvert = gst::ElementFactory::make("audioconvert")
                                    .build()
                                    .map_err(|e| format!("Failed to create audioconvert: {e}"))?;
                                let audioresample = gst::ElementFactory::make("audioresample")
                                    .build()
                                    .map_err(|e| format!("Failed to create audioresample: {e}"))?;
                                let norm_vol = gst::ElementFactory::make("volume")
                                    .property("volume", current_norm_gain)
                                    .build()
                                    .map_err(|e| format!("Failed to create norm volume: {e}"))?;
                                let user_vol = gst::ElementFactory::make("volume")
                                    .property("volume", slider_to_amplitude(current_volume))
                                    .build()
                                    .map_err(|e| format!("Failed to create user volume: {e}"))?;
                                let sink = gst::ElementFactory::make("autoaudiosink")
                                    .build()
                                    .map_err(|e| format!("Failed to create autoaudiosink: {e}"))?;

                                pipe.add_many([
                                    &uridecodebin,
                                    &audioconvert,
                                    &audioresample,
                                    &norm_vol,
                                    &user_vol,
                                    &sink,
                                ])
                                .map_err(|e| format!("Failed to add elements: {e}"))?;
                                gst::Element::link_many([
                                    &audioconvert,
                                    &audioresample,
                                    &norm_vol,
                                    &user_vol,
                                    &sink,
                                ])
                                .map_err(|e| format!("Failed to link chain: {e}"))?;

                                // Pad probe on audioconvert.sink — captures the codec's raw output
                                // (pre-conversion). audioconvert.src would show the post-promotion
                                // format when the downstream capsfilter is locked, which is misleading.
                                if let Some(sink_pad) = audioconvert.static_pad("sink") {
                                    let cell = Arc::clone(&decoded_cell_thread);
                                    sink_pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_pad, info| {
                                        if let Some(gst::PadProbeData::Event(ref event)) = info.data {
                                            if let gst::EventView::Caps(caps_event) = event.view() {
                                                let caps = caps_event.caps();
                                                if let Some(fmt) = parse_pcm_format(caps) {
                                                    if let Ok(mut guard) = cell.lock() {
                                                        *guard = Some(crate::pipeline_probe::PadCaps {
                                                            format: fmt.gst_format.clone(),
                                                            rate: fmt.sample_rate,
                                                            channels: fmt.channels,
                                                        });
                                                    }
                                                }
                                            }
                                        }
                                        gst::PadProbeReturn::Ok
                                    });
                                }

                                // autoaudiosink is a bin — its real child sink
                                // (pulsesink/pipewiresink/alsasink) is added asynchronously.
                                // Hook child-added to attach a CAPS probe on the real sink's pad.
                                // Race trade-off: if the child is added BEFORE this signal handler
                                // is connected, the initial CAPS event is missed and output_cell
                                // stays None until the next caps event (e.g., format renegotiation)
                                // or until the 2s heartbeat triggers a refresh; the diagram
                                // gracefully shows "—" until then. In practice the connect happens
                                // before the pipeline transitions to PAUSED, so the race is rare.
                                if let Ok(sink_bin) = sink.clone().dynamic_cast::<gst::Bin>() {
                                    let output_cell = Arc::clone(&output_cell_thread);
                                    sink_bin.connect_element_added(move |_bin, element| {
                                        let cell = Arc::clone(&output_cell);
                                        if let Some(sink_pad) = element.static_pad("sink") {
                                            sink_pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_pad, info| {
                                                if let Some(gst::PadProbeData::Event(ref event)) = info.data {
                                                    if let gst::EventView::Caps(caps_event) = event.view() {
                                                        let caps = caps_event.caps();
                                                        if let Some(fmt) = parse_pcm_format(caps) {
                                                            if let Ok(mut guard) = cell.lock() {
                                                                *guard = Some(crate::pipeline_probe::PadCaps {
                                                                    format: fmt.gst_format.clone(),
                                                                    rate: fmt.sample_rate,
                                                                    channels: fmt.channels,
                                                                });
                                                            }
                                                        }
                                                    }
                                                }
                                                gst::PadProbeReturn::Ok
                                            });
                                        }
                                    });
                                }

                                let convert_weak = audioconvert.downgrade();
                                uridecodebin.connect_pad_added(move |_src, src_pad| {
                                    let Some(convert) = convert_weak.upgrade() else {
                                        return;
                                    };
                                    let Some(sink_pad) = convert.static_pad("sink") else {
                                        return;
                                    };
                                    if sink_pad.is_linked() {
                                        return;
                                    }
                                    if let Some(caps) = src_pad.current_caps() {
                                        if let Some(s) = caps.structure(0) {
                                            if !s.name().as_str().starts_with("audio/") {
                                                return;
                                            }
                                        }
                                    }
                                    if let Err(e) = src_pad.link(&sink_pad) {
                                        log::error!("Failed to link uridecodebin pad: {e:?}");
                                    }
                                });

                                // Gapless: arm the next track on `about-to-finish`
                                // (uridecodebin3 only). Fires on a streaming thread;
                                // the `uri` must be set synchronously in the handler.
                                if decoder_name == "uridecodebin3" {
                                    let next_cb = Arc::clone(&next_track);
                                    let pending_cb = Arc::clone(&pending_advance);
                                    uridecodebin.connect("about-to-finish", false, move |vals| {
                                        let dbin = vals[0].get::<gst::Element>().ok()?;
                                        let nt = next_cb.lock().ok()?.take()?;
                                        // Adjust buffer-duration for the next source first.
                                        dbin.set_property(
                                            "buffer-duration",
                                            if nt.is_dash {
                                                15_000_000_000i64
                                            } else {
                                                5_000_000_000i64
                                            },
                                        );
                                        dbin.set_property("uri", &nt.uri);
                                        if let Ok(mut p) = pending_cb.lock() {
                                            *p = Some(PendingAdvance {
                                                track_id: nt.track_id,
                                                qid: nt.qid.clone(),
                                                norm_gain: nt.norm_gain,
                                                replay_gain: nt.replay_gain,
                                                peak_amplitude: nt.peak_amplitude,
                                            });
                                        }
                                        log::debug!(
                                            "[audio] gapless: queued next track {}",
                                            nt.track_id
                                        );
                                        None
                                    });
                                }

                                pipe.set_state(gst::State::Playing)
                                    .map_err(|e| format!("Failed to start playback: {e}"))?;

                                // Bus watcher (normal mode — unchanged)
                                let eos_flag = Arc::clone(&eos);
                                let tearing_down_flag = Arc::clone(&tearing_down);
                                let app_handle_clone = app_handle.clone();
                                let cmd_tx_bus = cmd_tx_worker.clone();
                                let pending_bus = Arc::clone(&pending_advance);
                                let mut stream_start_count: u32 = 0;
                                if let Some(bus) = pipe.bus() {
                                    std::thread::spawn(move || {
                                        for msg in bus.iter_timed(gst::ClockTime::NONE) {
                                            match msg.view() {
                                                gst::MessageView::StreamStart(..) => {
                                                    stream_start_count += 1;
                                                    // First STREAM_START is the initial track.
                                                    if stream_start_count <= 1 {
                                                        continue;
                                                    }
                                                    if tearing_down_flag.load(Ordering::SeqCst) {
                                                        continue;
                                                    }
                                                    // One-shot: about-to-finish arms exactly once
                                                    // per boundary, so consume whenever an arm
                                                    // exists. An adaptive intra-track STREAM_START
                                                    // with no arm present simply no-ops.
                                                    if let Some(pa) = pending_bus
                                                        .lock()
                                                        .ok()
                                                        .and_then(|mut g| g.take())
                                                    {
                                                        let _ = cmd_tx_bus.send(
                                                            AudioCommand::HandleGaplessAdvance {
                                                                track_id: pa.track_id,
                                                                qid: pa.qid,
                                                                norm_gain: pa.norm_gain,
                                                                replay_gain: pa.replay_gain,
                                                                peak_amplitude: pa.peak_amplitude,
                                                            },
                                                        );
                                                    }
                                                    continue;
                                                }
                                                gst::MessageView::Eos(..) => {
                                                    eos_flag.store(true, Ordering::SeqCst);
                                                    if !tearing_down_flag.load(Ordering::SeqCst) {
                                                        app_handle_clone
                                                            .emit("track-finished", ())
                                                            .ok();
                                                    }
                                                    break;
                                                }
                                                gst::MessageView::Error(err) => {
                                                    // If a gapless advance is armed, the
                                                    // gapless-queued next track failed to decode
                                                    // (e.g. expired URL). Recover: drop the arm and
                                                    // signal a terminal boundary so the frontend's
                                                    // playNext re-resolves and continues, instead
                                                    // of dying with a dangling audio-error.
                                                    let advance_armed = pending_bus
                                                        .lock()
                                                        .ok()
                                                        .map(|g| g.is_some())
                                                        .unwrap_or(false);
                                                    if advance_armed
                                                        && !tearing_down_flag.load(Ordering::SeqCst)
                                                    {
                                                        if let Ok(mut g) = pending_bus.lock() {
                                                            *g = None;
                                                        }
                                                        log::warn!(
                                                            "[audio] gapless next failed to decode; routing to track-finished"
                                                        );
                                                        eos_flag.store(true, Ordering::SeqCst);
                                                        app_handle_clone
                                                            .emit("track-finished", ())
                                                            .ok();
                                                        break;
                                                    }
                                                    let err_msg = err.error().to_string();
                                                    let debug_str = err
                                                        .debug()
                                                        .map(|s| s.to_string())
                                                        .unwrap_or_default();
                                                    log::error!(
                                                        "GStreamer error: {} (debug: {})",
                                                        err_msg,
                                                        debug_str
                                                    );
                                                    eos_flag.store(true, Ordering::SeqCst);
                                                    if !tearing_down_flag.load(Ordering::SeqCst) {
                                                        let is_busy = err_msg.contains("busy")
                                                            || debug_str.contains("busy")
                                                            || err_msg.contains("EBUSY")
                                                            || debug_str.contains("EBUSY");
                                                        let kind = if is_busy {
                                                            "device_busy"
                                                        } else {
                                                            "playback_error"
                                                        };
                                                        app_handle_clone.emit("audio-error",
                                                            serde_json::json!({ "kind": kind, "message": err_msg })
                                                        ).ok();
                                                    }
                                                    break;
                                                }
                                                gst::MessageView::Buffering(b) => {
                                                    log::debug!(
                                                        "[audio] normal: buffering {}%",
                                                        b.percent()
                                                    );
                                                }
                                                _ => {}
                                            }
                                        }
                                    });
                                }

                                backend = Some(PlaybackBackend::Normal {
                                    pipeline: pipe,
                                    user_volume_el: Some(user_vol),
                                    norm_volume_el: Some(norm_vol),
                                });
                            }
                            Ok(())
                        })();
                        reply.send(result).ok();
                    }

                    AudioCommand::Pause { reply } => {
                        let result = match backend.as_ref() {
                            Some(PlaybackBackend::Normal { pipeline, .. }) => pipeline
                                .set_state(gst::State::Paused)
                                .map(|_| ())
                                .map_err(|e| format!("Failed to pause: {e}")),
                            Some(PlaybackBackend::DirectAlsa { pipeline, .. }) => {
                                paused.store(true, Ordering::Release);
                                pipeline
                                    .set_state(gst::State::Paused)
                                    .map(|_| ())
                                    .map_err(|e| format!("Failed to pause decode: {e}"))
                            }
                            None => Err("No active pipeline".into()),
                        };
                        reply.send(result).ok();
                    }

                    AudioCommand::Resume { reply } => {
                        let result = match backend.as_ref() {
                            Some(PlaybackBackend::Normal { pipeline, .. }) => pipeline
                                .set_state(gst::State::Playing)
                                .map(|_| ())
                                .map_err(|e| format!("Failed to resume: {e}")),
                            Some(PlaybackBackend::DirectAlsa { pipeline, .. }) => {
                                paused.store(false, Ordering::Release);
                                pipeline
                                    .set_state(gst::State::Playing)
                                    .map(|_| ())
                                    .map_err(|e| format!("Failed to resume decode: {e}"))
                            }
                            None => Err("No active pipeline".into()),
                        };
                        reply.send(result).ok();
                    }

                    AudioCommand::Stop { reply } => {
                        // Non-advance boundary: clear armed gapless slots.
                        *next_track.lock().unwrap() = None;
                        *pending_advance.lock().unwrap() = None;
                        let result = match backend.take() {
                            Some(PlaybackBackend::Normal { pipeline, .. }) => {
                                if let Some(bus) = pipeline.bus() {
                                    bus.set_flushing(true);
                                }
                                eos.store(false, Ordering::SeqCst);
                                has_uri.store(false, Ordering::SeqCst);
                                std::thread::spawn(move || {
                                    pipeline.set_state(gst::State::Null).ok();
                                });
                                *decoded_cell_thread.lock().unwrap() = None;
                                *output_cell_thread.lock().unwrap() = None;
                                Ok(())
                            }
                            Some(PlaybackBackend::DirectAlsa { pipeline, .. }) => {
                                // Bump generation so writer discards stale data,
                                // then unblock and shut down
                                paused.store(false, Ordering::Release);
                                track_generation += 1;
                                writer_gen.store(track_generation, Ordering::Release);
                                if let Some(bus) = pipeline.bus() {
                                    bus.set_flushing(true);
                                }
                                if let Some(tx) = writer_tx.take() {
                                    let _ = tx.send_timeout(
                                        WriterCommand::Shutdown,
                                        std::time::Duration::from_millis(200),
                                    );
                                }
                                pipeline.set_state(gst::State::Null).ok();
                                let _ = pipeline.state(gst::ClockTime::from_mseconds(500));
                                drop(pipeline);
                                if let Some(h) = writer_thread.take() {
                                    h.join().ok();
                                }
                                eos.store(false, Ordering::SeqCst);
                                has_uri.store(false, Ordering::SeqCst);
                                *decoded_cell_thread.lock().unwrap() = None;
                                *output_cell_thread.lock().unwrap() = None;
                                Ok(())
                            }
                            None => {
                                // Clean up orphaned writer (e.g. pipeline build failed after spawn)
                                if let Some(tx) = writer_tx.take() {
                                    let _ = tx.send(WriterCommand::Shutdown);
                                }
                                if let Some(h) = writer_thread.take() {
                                    h.join().ok();
                                }
                                Ok(())
                            }
                        };
                        reply.send(result).ok();
                    }

                    AudioCommand::SetVolume { level, reply } => {
                        current_volume = level as f64;
                        let amplitude = slider_to_amplitude(current_volume);
                        if let Some(vol) = backend.as_ref().and_then(|b| b.user_volume_el()) {
                            vol.set_property("volume", amplitude);
                        }
                        combined_vol.store(
                            ((amplitude * current_norm_gain) as f32).to_bits(),
                            Ordering::Relaxed,
                        );
                        signal_path.set_user_volume(amplitude as f32);
                        reply.send(Ok(())).ok();
                    }

                    AudioCommand::SetNormalizationGain { gain, reply } => {
                        apply_normalization_gain(
                            gain,
                            &mut current_norm_gain,
                            backend.as_ref().and_then(|b| b.norm_volume_el()),
                            &combined_vol,
                            current_volume,
                            &signal_path,
                        );
                        reply.send(Ok(())).ok();
                    }

                    AudioCommand::Seek {
                        position_secs,
                        reply,
                    } => {
                        // Do NOT clear next_track/pending_advance here. Empirically (GStreamer
                        // 1.24.2), a FLUSH seek does NOT retract a next URI already committed by
                        // about-to-finish — the queued stream still plays at the current track's
                        // end. Clearing pending_advance would make that gapless switch fire NEITHER
                        // track-advanced NOR track-finished (UI desync). Keeping the arm lets the
                        // committed next's STREAM_START still emit track-advanced; and an
                        // un-committed next_track stays valid so gapless resumes after the seek.
                        let result = match backend.as_ref() {
                            Some(PlaybackBackend::Normal { pipeline, .. }) => {
                                let pos = gst::ClockTime::from_nseconds(
                                    (position_secs as f64 * 1_000_000_000.0) as u64,
                                );
                                pipeline
                                    .seek_simple(
                                        gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                                        pos,
                                    )
                                    .map_err(|e| format!("Seek failed: {e}"))
                            }
                            Some(PlaybackBackend::DirectAlsa { pipeline, .. }) => {
                                let was_paused = paused.load(Ordering::Acquire);
                                paused.store(false, Ordering::Release);
                                track_generation += 1;
                                writer_gen.store(track_generation, Ordering::Release);
                                if let Some(ref tx) = writer_tx {
                                    let _ = tx.send(WriterCommand::Flush);
                                }
                                let pos = gst::ClockTime::from_nseconds(
                                    (position_secs as f64 * 1_000_000_000.0) as u64,
                                );
                                let seek_frames = (position_secs as f64
                                    * current_sample_rate.load(Ordering::Relaxed) as f64)
                                    as u64;
                                frames_written.store(seek_frames, Ordering::Relaxed);
                                let result = pipeline
                                    .seek_simple(
                                        gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                                        pos,
                                    )
                                    .map_err(|e| format!("Seek failed: {e}"));
                                if was_paused {
                                    paused.store(true, Ordering::Release);
                                }
                                result
                            }
                            None => Err("No active pipeline".into()),
                        };
                        reply.send(result).ok();
                    }

                    AudioCommand::GetPosition { reply } => {
                        let pos = match backend.as_ref() {
                            Some(PlaybackBackend::Normal { pipeline, .. }) => pipeline
                                .query_position::<gst::ClockTime>()
                                .map(|pos| pos.nseconds() as f32 / 1_000_000_000.0)
                                .unwrap_or(0.0),
                            Some(PlaybackBackend::DirectAlsa { .. }) => {
                                let frames = frames_written.load(Ordering::Relaxed);
                                let rate = current_sample_rate.load(Ordering::Relaxed);
                                if rate > 0 {
                                    frames as f32 / rate as f32
                                } else {
                                    0.0
                                }
                            }
                            None => 0.0,
                        };
                        reply.send(Ok(pos)).ok();
                    }

                    AudioCommand::IsFinished { reply } => {
                        let finished =
                            eos.load(Ordering::SeqCst) || !has_uri.load(Ordering::SeqCst);
                        reply.send(Ok(finished)).ok();
                    }

                    AudioCommand::SetExclusiveMode {
                        enabled,
                        device: dev,
                        reply,
                    } => {
                        exclusive = enabled;
                        if let Some(d) = dev {
                            device = Some(d);
                        }
                        if !enabled {
                            bit_perfect = false;
                        }
                        // Mirror the device into the shared cell so the
                        // pipeline probe can read it without messaging.
                        if let Ok(mut cell) = exclusive_device_thread.lock() {
                            *cell = if enabled { device.clone() } else { None };
                        }
                        // Defense-in-depth: leaving Normal mode invalidates any
                        // armed gapless slots.
                        *next_track.lock().unwrap() = None;
                        *pending_advance.lock().unwrap() = None;
                        reply.send(Ok(())).ok();
                    }

                    AudioCommand::SetBitPerfect { enabled, reply } => {
                        bit_perfect = enabled;
                        if enabled {
                            exclusive = true;
                        }
                        // Defense-in-depth: leaving Normal mode invalidates any
                        // armed gapless slots.
                        *next_track.lock().unwrap() = None;
                        *pending_advance.lock().unwrap() = None;
                        reply.send(Ok(())).ok();
                    }

                    AudioCommand::SetGapless { enabled, reply } => {
                        gapless_setting = enabled;
                        if !enabled {
                            *next_track.lock().unwrap() = None;
                            *pending_advance.lock().unwrap() = None;
                        }
                        let _ = reply.send(Ok(()));
                    }

                    AudioCommand::SetNextTrack {
                        uri,
                        norm_gain,
                        track_id,
                        qid,
                        replay_gain,
                        peak_amplitude,
                        is_dash,
                        reply,
                    } => {
                        if gapless_setting && gapless_capable && !exclusive && !bit_perfect {
                            *next_track.lock().unwrap() = Some(NextTrack {
                                uri,
                                norm_gain,
                                track_id,
                                qid,
                                replay_gain,
                                peak_amplitude,
                                is_dash,
                            });
                        } else {
                            *next_track.lock().unwrap() = None;
                        }
                        let _ = reply.send(Ok(()));
                    }

                    AudioCommand::ClearNextTrack { reply } => {
                        *next_track.lock().unwrap() = None;
                        *pending_advance.lock().unwrap() = None;
                        let _ = reply.send(Ok(()));
                    }

                    AudioCommand::HandleGaplessAdvance {
                        track_id,
                        qid,
                        norm_gain,
                        replay_gain,
                        peak_amplitude,
                    } => {
                        signal_path.reset_for_track();
                        apply_normalization_gain(
                            norm_gain,
                            &mut current_norm_gain,
                            backend.as_ref().and_then(|b| b.norm_volume_el()),
                            &combined_vol,
                            current_volume,
                            &signal_path,
                        );
                        eos.store(false, Ordering::SeqCst);
                        has_uri.store(true, Ordering::SeqCst);
                        log::debug!("[audio] gapless: advanced to track {track_id}");
                        // rg/peak are carried in the payload; the lib.rs track-advanced
                        // listener (Task 5), which has AppState, stores them into
                        // last_replay_gain/last_peak_amplitude so a live volume-
                        // normalization toggle uses THIS track's values. The worker
                        // has no AppState access.
                        app_handle
                            .emit(
                                "track-advanced",
                                serde_json::json!({
                                    "trackId": track_id,
                                    "qid": qid,
                                    "replayGain": replay_gain,
                                    "peakAmplitude": peak_amplitude,
                                }),
                            )
                            .ok();
                    }

                    AudioCommand::ListDevices { reply } => {
                        let result = list_alsa_devices_inner();
                        reply.send(result).ok();
                    }
                }
            }
        });

        Self {
            cmd_tx,
            exclusive_device,
            decoded_caps_cell,
            output_caps_cell,
        }
    }

    fn send_cmd<T>(&self, build: impl FnOnce(Reply<T>) -> AudioCommand) -> T {
        let (tx, rx) = mpsc::channel();
        let cmd = build(tx);
        self.cmd_tx.send(cmd).expect("Audio thread dead");
        rx.recv().expect("Audio thread dead")
    }

    pub fn play_url(&self, uri: &str) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::PlayUrl {
            uri: uri.to_string(),
            reply,
        })
    }
    pub fn pause(&self) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::Pause { reply })
    }
    pub fn resume(&self) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::Resume { reply })
    }
    pub fn stop(&self) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::Stop { reply })
    }
    pub fn set_volume(&self, level: f32) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::SetVolume { level, reply })
    }
    pub fn set_normalization_gain(&self, gain: f64) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::SetNormalizationGain { gain, reply })
    }
    pub fn seek(&self, position_secs: f32) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::Seek {
            position_secs,
            reply,
        })
    }
    pub fn get_position(&self) -> Result<f32, String> {
        self.send_cmd(|reply| AudioCommand::GetPosition { reply })
    }
    pub fn is_finished(&self) -> Result<bool, String> {
        self.send_cmd(|reply| AudioCommand::IsFinished { reply })
    }
    pub fn set_exclusive_mode(&self, enabled: bool, device: Option<String>) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::SetExclusiveMode {
            enabled,
            device,
            reply,
        })
    }
    pub fn set_bit_perfect(&self, enabled: bool) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::SetBitPerfect { enabled, reply })
    }
    pub fn set_gapless(&self, enabled: bool) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::SetGapless { enabled, reply })
    }
    #[allow(clippy::too_many_arguments)]
    pub fn set_next_track(
        &self,
        uri: String,
        norm_gain: f64,
        track_id: u64,
        qid: String,
        replay_gain: f64,
        peak_amplitude: f64,
        is_dash: bool,
    ) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::SetNextTrack {
            uri,
            norm_gain,
            track_id,
            qid,
            replay_gain,
            peak_amplitude,
            is_dash,
            reply,
        })
    }
    pub fn clear_next_track(&self) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::ClearNextTrack { reply })
    }
    pub fn list_devices(&self) -> Result<Vec<AudioDevice>, String> {
        self.send_cmd(|reply| AudioCommand::ListDevices { reply })
    }

    pub fn snapshot_decoded_caps(&self) -> Option<crate::pipeline_probe::PadCaps> {
        self.decoded_caps_cell.lock().ok()?.clone()
    }

    pub fn snapshot_output_caps(&self) -> Option<crate::pipeline_probe::PadCaps> {
        self.output_caps_cell.lock().ok()?.clone()
    }

    /// Returns the ALSA device string for DirectAlsa, or None for Normal mode.
    pub fn exclusive_device(&self) -> Option<String> {
        self.exclusive_device.lock().ok()?.clone()
    }
}

// ── Appsink pipeline builder ───────────────────────────────────────────

#[cfg(target_os = "linux")]
fn build_appsink_pipeline(
    uri: &str,
    exclusive: bool,
    bit_perfect: bool,
    writer_tx: crossbeam_channel::Sender<WriterCommand>,
    writer_gen: Arc<AtomicU64>,
    // Retained in signature for caller compatibility; no longer used in the
    // builder body since the non-bit-perfect capsfilter is constructed empty
    // and the writer learns the format via FormatHint (from pad_added + the
    // appsink CAPS probe).
    _negotiated_fmt: &PcmFormat,
    supported_gst_formats: &[&str],
    supported_rates: &[u32],
    decoded_cell: Arc<Mutex<Option<crate::pipeline_probe::PadCaps>>>,
    output_cell: Arc<Mutex<Option<crate::pipeline_probe::PadCaps>>>,
) -> Result<(gst::Pipeline, Option<gst::Element>, Option<gst::Element>), String> {
    use gst_app::prelude::*;

    let pipe = gst::Pipeline::new();
    let is_dash = uri.starts_with("data:application/dash");
    let mut udb = gst::ElementFactory::make("uridecodebin").property("uri", uri);
    if is_dash {
        udb = udb
            .property("buffer-duration", 15_000_000_000i64)
            .property("use-buffering", true);
    } else {
        udb = udb
            .property("buffer-duration", 5_000_000_000i64)
            .property("use-buffering", true);
    }
    let uridecodebin = udb
        .build()
        .map_err(|e| format!("Failed to create uridecodebin: {e}"))?;
    let audioconvert = gst::ElementFactory::make("audioconvert")
        .build()
        .map_err(|e| format!("Failed to create audioconvert: {e}"))?;

    let appsink = gst_app::AppSink::builder()
        .max_buffers(20)
        .sync(false)
        .build();

    // DASH: constrain appsink to DAC-supported formats and rates for BOTH
    // bit-perfect and non-bit-perfect. The pad_added capsfilter relock is
    // gated by `if !is_dash` (DASH renegotiates caps mid-stream and would
    // fight the lock), so without this constraint a non-bit-perfect DASH
    // chain has no protection and source-format chunks (e.g. S24_32LE on a
    // DAC that only supports S32LE) reach the writer, triggering the
    // strict format-mismatch teardown in the Data handler.
    if is_dash {
        let rate_list: Vec<i32> = supported_rates.iter().map(|&r| r as i32).collect();
        let mut caps_builder = gst::Caps::builder("audio/x-raw")
            .field("format", gst::List::new(supported_gst_formats.iter().copied()));
        if !rate_list.is_empty() {
            caps_builder = caps_builder.field("rate", gst::List::new(rate_list));
        }
        appsink.set_caps(Some(&caps_builder.build()));
        log::debug!(
            "[audio] DASH appsink caps = formats:{:?} rates:{:?} (bit_perfect={bit_perfect})",
            supported_gst_formats, supported_rates
        );
    }

    log::debug!(
        "[audio] building appsink pipeline: exclusive={exclusive} bit_perfect={bit_perfect}"
    );

    let (u_vol, n_vol, capsfilter_weak_from_build): (Option<gst::Element>, Option<gst::Element>, Option<gst::glib::WeakRef<gst::Element>>) = if bit_perfect {
        audioconvert.set_property_from_str("dithering", "none");
        audioconvert.set_property_from_str("noise-shaping", "none");

        if is_dash {
            // DASH: no capsfilter — appsink caps constrain format,
            // audioconvert passes through rate changes
            pipe.add_many([&uridecodebin, &audioconvert, appsink.upcast_ref()])
                .map_err(|e| format!("Failed to add elements: {e}"))?;
            gst::Element::link_many([&audioconvert, appsink.upcast_ref()])
                .map_err(|e| format!("Failed to link bit-perfect DASH chain: {e}"))?;
            (None, None, None)
        } else {
            // BTS: capsfilter for dynamic locking (preserves exact decoded format)
            let capsfilter = gst::ElementFactory::make("capsfilter")
                .build()
                .map_err(|e| format!("Failed to create capsfilter: {e}"))?;
            let cf_weak = capsfilter.downgrade();
            pipe.add_many([
                &uridecodebin,
                &audioconvert,
                &capsfilter,
                appsink.upcast_ref(),
            ])
            .map_err(|e| format!("Failed to add elements: {e}"))?;
            gst::Element::link_many([&audioconvert, &capsfilter, appsink.upcast_ref()])
                .map_err(|e| format!("Failed to link bit-perfect chain: {e}"))?;
            (None, None, Some(cf_weak))
        }
    } else {
        // Exclusive (non-bit-perfect): volume applied in ALSA writer thread.
        // Rate constrained to DAC-supported rates — audioresample converts unsupported rates.
        let audioresample = gst::ElementFactory::make("audioresample")
            .build()
            .map_err(|e| format!("Failed to create audioresample: {e}"))?;
        // Construct capsfilter EMPTY so it imposes no constraint until pad_added
        // relocks it with the chosen format. Seeding caps here (e.g. with the
        // default S32LE from `_negotiated_fmt`) makes src_pad.link() trigger
        // downstream negotiation against the seed BEFORE the relock runs —
        // audioconvert then commits to converting (e.g. S16LE→S32LE) and the
        // writer reopens ALSA at the wrong format. Matches the bit-perfect
        // BTS pattern at line ~1903 where the capsfilter is also built empty.
        let capsfilter = gst::ElementFactory::make("capsfilter")
            .build()
            .map_err(|e| format!("Failed to create capsfilter: {e}"))?;
        let cf_weak = capsfilter.downgrade();

        pipe.add_many([
            &uridecodebin,
            &audioconvert,
            &audioresample,
            &capsfilter,
            appsink.upcast_ref(),
        ])
        .map_err(|e| format!("Failed to add elements: {e}"))?;
        gst::Element::link_many([
            &audioconvert,
            &audioresample,
            &capsfilter,
            appsink.upcast_ref(),
        ])
        .map_err(|e| format!("Failed to link exclusive chain: {e}"))?;

        (None, None, Some(cf_weak))
    };

    // Capsfilter weak ref captured at element creation (line ~1903/1925).
    // DON'T use audioconvert.src.peer.parent_element — the chain length differs
    // between bit-perfect (audioconvert→capsfilter) and non-bit-perfect
    // (audioconvert→audioresample→capsfilter), so peer-walk would target the
    // wrong element in non-bit-perfect mode.
    let capsfilter_weak = capsfilter_weak_from_build;

    // Pad probe on audioconvert.sink — captures the codec's raw output
    // (pre-conversion). audioconvert.src would show the post-promotion
    // format when the downstream capsfilter is locked, which is misleading.
    if let Some(sink_pad) = audioconvert.static_pad("sink") {
        let cell = Arc::clone(&decoded_cell);
        sink_pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_pad, info| {
            if let Some(gst::PadProbeData::Event(ref event)) = info.data {
                if let gst::EventView::Caps(caps_event) = event.view() {
                    let caps = caps_event.caps();
                    if let Some(fmt) = parse_pcm_format(caps) {
                        if let Ok(mut guard) = cell.lock() {
                            *guard = Some(crate::pipeline_probe::PadCaps {
                                format: fmt.gst_format.clone(),
                                rate: fmt.sample_rate,
                                channels: fmt.channels,
                            });
                        }
                    }
                }
            }
            gst::PadProbeReturn::Ok
        });
    }

    // Connect uridecodebin's dynamic pad to audioconvert
    let convert_weak = audioconvert.downgrade();
    let supported_fmts_for_closure: Vec<String> = supported_gst_formats.iter().map(|s| s.to_string()).collect();
    let supported_rates_for_closure: Vec<u32> = supported_rates.to_vec();
    let resample_tx = writer_tx.clone();
    let is_bit_perfect = bit_perfect;
    // pad_added runs on the GStreamer streaming thread; clone writer_gen up front
    // since `writer_gen` itself is moved into the appsink callback later.
    let pad_gen = Arc::clone(&writer_gen);
    uridecodebin.connect_pad_added(move |_src, src_pad| {
        let Some(convert) = convert_weak.upgrade() else {
            return;
        };
        let Some(sink_pad) = convert.static_pad("sink") else {
            return;
        };
        if sink_pad.is_linked() {
            return;
        }

        if let Some(caps) = src_pad.current_caps() {
            if let Some(s) = caps.structure(0) {
                if !s.name().as_str().starts_with("audio/") {
                    return;
                }
            }
        }

        if let Err(e) = src_pad.link(&sink_pad) {
            log::error!("Failed to link uridecodebin pad: {e:?}");
        }

        // Detect if resampling will occur (non-bit-perfect exclusive only)
        if !is_bit_perfect {
            if let Some(caps) = src_pad.current_caps() {
                if let Some(s) = caps.structure(0) {
                    if let Ok(native_rate) = s.get::<i32>("rate") {
                        let native = native_rate as u32;
                        if !supported_rates_for_closure.contains(&native) {
                            let closest = supported_rates_for_closure
                                .iter()
                                .copied()
                                .min_by_key(|&r| (r as i64 - native as i64).unsigned_abs())
                                .unwrap_or(48000);
                            let _ = resample_tx.try_send(
                                WriterCommand::Resampling { from: native, to: closest },
                            );
                        }
                    }
                }
            }
        }

        // Format selection: both bit-perfect AND non-bit-perfect prefer the
        // narrowest lossless option from pick_capsfilter_format. Difference:
        // bit-perfect also emits PendingPromotion so the writer can fire a
        // truthful from→to toast; non-bit-perfect just relies on FormatHint.
        if !is_dash {
            let caps = src_pad.current_caps().or_else(|| {
                let query = src_pad.query_caps(None);
                if query.is_fixed() {
                    Some(query)
                } else {
                    None
                }
            });
            if let Some(caps) = caps {
                if let Some(s) = caps.structure(0) {
                    if let (Ok(rate), Ok(channels), Ok(format)) = (
                        s.get::<i32>("rate"),
                        s.get::<i32>("channels"),
                        s.get::<&str>("format"),
                    ) {
                        // Bit-perfect: announce source format so the writer
                        // can emit a truthful promotion toast once negotiation lands.
                        if is_bit_perfect {
                            let _ = resample_tx.try_send(WriterCommand::PendingPromotion {
                                from: format.to_string(),
                                generation: pad_gen.load(Ordering::Acquire),
                            });
                        }

                        let chosen = pick_capsfilter_format(format, &supported_fmts_for_closure);

                        if let Some(ref cf_weak) = capsfilter_weak {
                            if let Some(cf) = cf_weak.upgrade() {
                                let locked = if is_bit_perfect {
                                    // Bit-perfect: single rate (no audioresample work).
                                    gst::Caps::builder("audio/x-raw")
                                        .field("format", chosen.as_str())
                                        .field("rate", rate)
                                        .field("channels", channels)
                                        .build()
                                } else {
                                    // Non-bit-perfect: rate stays a list so audioresample
                                    // can pick a DAC-supported rate when source rate isn't.
                                    let rate_list: Vec<i32> = supported_rates_for_closure
                                        .iter()
                                        .map(|&r| r as i32)
                                        .collect();
                                    gst::Caps::builder("audio/x-raw")
                                        .field("format", chosen.as_str())
                                        .field("channels", channels)
                                        .field("rate", gst::List::new(rate_list))
                                        .build()
                                };
                                log::info!("[audio] capsfilter locked to {locked}");
                                cf.set_property("caps", &locked);

                                // Belt-and-braces: notify the writer explicitly so it
                                // reopens ALSA at the chosen format. The appsink CAPS
                                // probe will also fire FormatHint when the new caps
                                // event reaches it; both arrive at the writer's mpsc
                                // and the writer dedups via the current_fmt comparison.
                                if !is_bit_perfect {
                                    let bps: u32 = match chosen.as_str() {
                                        "S16LE" => 2,
                                        "S24LE" => 3,
                                        "S24_32LE" | "S32LE" | "F32LE" => 4,
                                        _ => 4,
                                    };
                                    let hint_fmt = PcmFormat {
                                        gst_format: chosen.clone(),
                                        sample_rate: rate as u32,
                                        channels: channels as u32,
                                        bytes_per_sample: bps,
                                    };
                                    let _ = resample_tx.try_send(WriterCommand::FormatHint(hint_fmt));
                                }
                            }
                        }
                    }
                }
            }
        }
    });

    // Pad probe: intercept CAPS events for preemptive ALSA format changes (DASH renegotiation)
    let probe_tx = writer_tx.clone();
    if let Some(sink_pad) = appsink.static_pad("sink") {
        let output_cell_for_probe = Arc::clone(&output_cell);
        sink_pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_pad, info| {
            if let Some(gst::PadProbeData::Event(ref event)) = info.data {
                if let gst::EventView::Caps(caps_event) = event.view() {
                    let caps = caps_event.caps();
                    if let Some(fmt) = parse_pcm_format(caps) {
                        log::debug!("[audio] CAPS event on appsink: {fmt:?}");
                        if let Ok(mut guard) = output_cell_for_probe.lock() {
                            *guard = Some(crate::pipeline_probe::PadCaps {
                                format: fmt.gst_format.clone(),
                                rate: fmt.sample_rate,
                                channels: fmt.channels,
                            });
                        }
                        let _ = probe_tx.try_send(WriterCommand::FormatHint(fmt));
                    }
                }
            }
            gst::PadProbeReturn::Ok
        });
    }

    // Appsink callback: extract PCM and forward to ALSA writer
    let chunk_gen = Arc::clone(&writer_gen);
    appsink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                let caps = sample.caps().ok_or(gst::FlowError::Error)?;
                let format = parse_pcm_format(caps).ok_or(gst::FlowError::Error)?;

                let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
                let data = map.as_slice().to_vec();
                let generation = chunk_gen.load(Ordering::Acquire);

                writer_tx
                    .send(WriterCommand::Data(AudioChunk {
                        data,
                        format,
                        generation,
                    }))
                    .map_err(|_| gst::FlowError::Error)?;

                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    Ok((pipe, u_vol, n_vol))
}

// ── Device enumeration ─────────────────────────────────────────────────

/// Enumerate ALSA hardware devices. Does NOT use the audio pipeline,
/// so it is safe to call from any thread.
pub fn list_alsa_devices() -> Result<Vec<AudioDevice>, String> {
    list_alsa_devices_inner()
}

fn list_alsa_devices_inner() -> Result<Vec<AudioDevice>, String> {
    gst::init().map_err(|e| format!("GStreamer init failed: {e}"))?;
    let monitor = gst::DeviceMonitor::new();
    let caps = gst::Caps::new_empty_simple("audio/x-raw");
    monitor.add_filter(Some("Audio/Sink"), Some(&caps));
    monitor
        .start()
        .map_err(|e| format!("Failed to start device monitor: {e}"))?;

    // GStreamer 1.28+ starts providers async, so devices() may initially be empty.
    // On older versions start() blocks and devices are available immediately.
    let devices = {
        let mut devs = monitor.devices();
        let mut waited = 0u32;
        while devs.is_empty() && waited < 2000 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            devs = monitor.devices();
            waited += 100;
        }
        devs
    };

    monitor.stop();

    log::debug!(
        "[list_alsa_devices] DeviceMonitor found {} devices",
        devices.len()
    );

    let mut result = Vec::new();
    for dev in &devices {
        let Some(props) = dev.properties() else {
            continue;
        };

        let api = props.get::<String>("device.api").unwrap_or_default();
        if api != "alsa" {
            continue;
        }

        let path = props.get::<String>("api.alsa.path").ok().or_else(|| {
            let card = props.get::<String>("alsa.card").ok()?;
            let dev_num = props.get::<String>("alsa.device").ok()?;
            Some(format!("hw:{card},{dev_num}"))
        });

        if let Some(path) = path {
            let name = dev.display_name().to_string();
            log::debug!("[list_alsa_devices] found: '{}' -> {}", name, path);
            result.push(AudioDevice { id: path, name });
        }
    }

    log::debug!("[list_alsa_devices] returning {} devices", result.len());
    Ok(result)
}

/// Gapless requires GStreamer >= 1.24 (data: DASH manifest support) and uridecodebin3.
pub fn gapless_supported() -> bool {
    let (major, minor, _, _) = gst::version();
    if (major, minor) < (1, 24) {
        return false;
    }
    gst::ElementFactory::find("uridecodebin3").is_some()
}
