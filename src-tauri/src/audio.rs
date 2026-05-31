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

// NOTE (2b): the old `NextTrack` / `PendingAdvance` slot structs (used by the
// 2a `about-to-finish` machinery) were removed in 2b-A1.

/// 2b-A2: the prerolled next-track branch. Built on the attach executor thread
/// and stored in the shared `Arc<Mutex<Option<NextBinState>>>` that the worker
/// (dedup/replace/gating), the executor (attach/detach), and the notify
/// handler (2b-A3 advance) all read.
struct NextBinState {
    /// The legacy `uridecodebin` for the next track. Linked through
    /// `branch_queue` → `concat sink_1`. Owned here so detach can null + remove it.
    bin: gst::Element,
    /// The per-branch upstream queue (C1) decoupling this decoder from concat's
    /// gate so it pre-buffers while the current track plays.
    branch_queue: gst::Element,
    track_id: u64,
    qid: String,
    // 2b-A3 reads these to apply gain + emit `track-advanced` on the switch.
    #[allow(dead_code)]
    norm_gain: f64,
    #[allow(dead_code)]
    replay_gain: f64,
    #[allow(dead_code)]
    peak_amplitude: f64,
    #[allow(dead_code)]
    is_dash: bool,
    /// Per-boundary token (C4). 2b-A3 carries it to `HandleGaplessAdvance` and
    /// ignores advances whose token ≠ current, making double-advance impossible.
    #[allow(dead_code)]
    boundary_id: u64,
}

/// Jobs for the serialized attach/detach executor thread (C3). Pad-slot
/// operations on `concat` must never race, so they are all funneled through
/// this single thread's mpsc. The worker dispatches and returns immediately;
/// the executor does the blocking `pipeline.add` / `sync_state_with_parent` /
/// `set_state(Null)` work off the worker thread.
enum AttachJob {
    /// Build a second `uridecodebin → branch_queue → concat sink_1`, preroll it,
    /// and store the resulting `NextBinState` into the shared slot.
    Attach {
        pipeline: gst::Pipeline,
        concat: gst::Element,
        uri: String,
        is_dash: bool,
        track_id: u64,
        qid: String,
        norm_gain: f64,
        replay_gain: f64,
        peak_amplitude: f64,
        boundary_id: u64,
    },
    /// Tear down a specific bin (+ its branch queue): set Null, release the
    /// concat request pad whose peer is the queue, and remove from the pipeline.
    /// Captured `pipeline`/`concat` clones are Normal-only (per C5 — the worker
    /// never dispatches this on DirectAlsa).
    Detach {
        pipeline: gst::Pipeline,
        concat: gst::Element,
        bin: gst::Element,
        branch_queue: gst::Element,
    },
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
    /// Normal: full GStreamer pipeline with autoaudiosink.
    /// `concat` sits at the head (per-branch `queue` → concat → chain → sink)
    /// so the next track's decoder can preroll ahead for gapless (2b).
    Normal {
        pipeline: gst::Pipeline,
        concat: gst::Element,
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

    /// The backend's GStreamer pipeline. Both variants own a `gst::Pipeline`.
    #[allow(dead_code)]
    fn pipeline(&self) -> &gst::Pipeline {
        match self {
            PlaybackBackend::Normal { pipeline, .. }
            | PlaybackBackend::DirectAlsa { pipeline, .. } => pipeline,
        }
    }

    /// The head `concat` element. Normal-only — gapless never runs on
    /// DirectAlsa (the mode gate prevents this path), so calling it on
    /// DirectAlsa is a programming error.
    #[allow(dead_code)]
    fn concat(&self) -> &gst::Element {
        match self {
            PlaybackBackend::Normal { concat, .. } => concat,
            PlaybackBackend::DirectAlsa { .. } => {
                panic!("PlaybackBackend::concat() called on DirectAlsa — gapless is normal-only")
            }
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

/// 2b-A2: build + preroll the next-track branch on the executor thread.
///
/// Mirrors the first branch's wiring (sink_0): legacy `uridecodebin` →
/// per-branch `queue` → `concat sink_1`. The branch queue (C1) decouples this
/// decoder from concat's back-pressure on the inactive sink pad so it
/// pre-buffers ahead while the current track plays. A smaller `buffer-duration`
/// (~3s, per C3) prerolls the source without fully pre-downloading it.
///
/// Returns the constructed elements so the caller can stash them in
/// `NextBinState`. On any error the partially-added elements are removed so the
/// pipeline isn't left with a dangling half-attached bin.
fn attach_next_bin(
    pipeline: &gst::Pipeline,
    concat: &gst::Element,
    uri: &str,
    is_dash: bool,
) -> Result<(gst::Element, gst::Element), String> {
    let udb = gst::ElementFactory::make("uridecodebin")
        .property("uri", uri)
        // Smaller next-bin buffer (C3): ~3s. `use-buffering=true` is fine —
        // the per-branch queue + lead time handle the gapless hand-off.
        .property("buffer-duration", 3_000_000_000i64)
        .property("use-buffering", true)
        .build()
        .map_err(|e| format!("Failed to create next uridecodebin: {e}"))?;
    // Same props as the first branch's queue.
    let branch_queue = gst::ElementFactory::make("queue")
        .property("max-size-time", 5_000_000_000u64)
        .property("max-size-buffers", 0u32)
        .property("max-size-bytes", 0u32)
        .build()
        .map_err(|e| format!("Failed to create next branch queue: {e}"))?;

    if let Err(e) = pipeline.add_many([&udb, &branch_queue]) {
        return Err(format!("Failed to add next bin elements: {e}"));
    }

    // Link branch_queue.src → concat sink_1 (sink_0 is taken by the first
    // branch, so this request deterministically gets sink_1).
    let concat_sink = match concat.request_pad_simple("sink_%u") {
        Some(p) => p,
        None => {
            let _ = pipeline.remove_many([&udb, &branch_queue]);
            return Err("concat refused next sink pad".to_string());
        }
    };
    let queue_src = match branch_queue.static_pad("src") {
        Some(p) => p,
        None => {
            concat.release_request_pad(&concat_sink);
            let _ = pipeline.remove_many([&udb, &branch_queue]);
            return Err("next branch queue has no src pad".to_string());
        }
    };
    if let Err(e) = queue_src.link(&concat_sink) {
        concat.release_request_pad(&concat_sink);
        let _ = pipeline.remove_many([&udb, &branch_queue]);
        return Err(format!("Failed to link next queue→concat: {e}"));
    }

    // uridecodebin(B) → branch_queue (dynamic). Mirror sink_0's pad_added guard:
    // skip already-linked + non-audio pads.
    let branch_queue_weak = branch_queue.downgrade();
    udb.connect_pad_added(move |_src, src_pad| {
        let Some(branch_queue) = branch_queue_weak.upgrade() else {
            return;
        };
        let Some(sink_pad) = branch_queue.static_pad("sink") else {
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
            log::error!("Failed to link next uridecodebin pad: {e:?}");
        }
    });

    // Start prerolling: bring both elements up to the pipeline's state.
    if let Err(e) = branch_queue.sync_state_with_parent() {
        log::error!("next branch queue sync_state failed: {e}");
    }
    if let Err(e) = udb.sync_state_with_parent() {
        log::error!("next uridecodebin sync_state failed: {e}");
    }
    log::debug!("[audio] gapless: attached next bin (is_dash={is_dash})");

    Ok((udb, branch_queue))
}

/// 2b-A2: tear down a next-track branch on the executor thread.
///
/// Sets the bin + its branch queue to Null, finds the `concat` sink pad whose
/// peer's parent is this bin's queue, unlinks + releases that request pad, then
/// removes both elements from the pipeline. Only ever called with Normal-mode
/// `pipeline`/`concat` clones (the worker gates dispatch — never DirectAlsa, C5).
fn detach_bin(
    pipeline: &gst::Pipeline,
    concat: &gst::Element,
    bin: &gst::Element,
    branch_queue: &gst::Element,
) {
    let _ = bin.set_state(gst::State::Null);
    let _ = branch_queue.set_state(gst::State::Null);

    // Release the concat request pad linked to this branch's queue src.
    let sink_pads: Vec<gst::Pad> = concat
        .sink_pads()
        .into_iter()
        .filter(|pad| {
            pad.peer()
                .and_then(|peer| peer.parent_element())
                .is_some_and(|parent| &parent == branch_queue)
        })
        .collect();
    for pad in sink_pads {
        if let Some(peer) = pad.peer() {
            let _ = peer.unlink(&pad);
        }
        concat.release_request_pad(&pad);
    }

    let _ = pipeline.remove_many([bin, branch_queue]);
    log::debug!("[audio] gapless: detached next bin");
}

/// 2b-A2: the serialized attach/detach executor loop (C3). One dedicated thread
/// owns this so pad-slot operations on `concat` are strictly ordered and never
/// block the worker command thread. `next_bin` is the shared slot the worker /
/// executor / notify handler (2b-A3) all read.
fn run_attach_executor(
    job_rx: mpsc::Receiver<AttachJob>,
    next_bin: Arc<Mutex<Option<NextBinState>>>,
) {
    for job in job_rx {
        match job {
            AttachJob::Attach {
                pipeline,
                concat,
                uri,
                is_dash,
                track_id,
                qid,
                norm_gain,
                replay_gain,
                peak_amplitude,
                boundary_id,
            } => {
                match attach_next_bin(&pipeline, &concat, &uri, is_dash) {
                    Ok((bin, branch_queue)) => {
                        if let Ok(mut guard) = next_bin.lock() {
                            *guard = Some(NextBinState {
                                bin,
                                branch_queue,
                                track_id,
                                qid,
                                norm_gain,
                                replay_gain,
                                peak_amplitude,
                                is_dash,
                                boundary_id,
                            });
                        }
                    }
                    Err(e) => {
                        // Preload failure is non-fatal: leave the slot empty so
                        // the natural track boundary falls back to playNext.
                        log::warn!("[audio] gapless: attach_next_bin failed: {e}");
                        if let Ok(mut guard) = next_bin.lock() {
                            *guard = None;
                        }
                    }
                }
            }
            AttachJob::Detach {
                pipeline,
                concat,
                bin,
                branch_queue,
            } => {
                detach_bin(&pipeline, &concat, &bin, &branch_queue);
            }
        }
    }
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
    // 2b-A2: fields drive the preroll attach (uri, gating metadata, qid).
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
    /// 2b: emitted by concat's notify::active-pad advance handler (wired in 2b-A3).
    #[allow(dead_code)]
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
            // 2b: under `concat` (adjust-base=true), `query_position(TIME)` re-bases
            // to ~0 at each track boundary — it is per-track, NOT cumulative. So the
            // 2a `position_offset_ns` capture/subtract mechanism is gone (C2).

            // Gapless state. `gapless_setting` defaults to true and is pushed
            // from saved settings at startup via `set_gapless` (the worker has
            // no access to AppState). `cmd_tx_worker` is the self-sender the
            // Normal bus thread clones for gapless advance handling (2b-A3).
            let mut gapless_setting: bool = true;
            let gapless_capable: bool = gapless_supported();
            let cmd_tx_worker = cmd_tx_worker;

            // 2b-A2: the prerolled next bin. Shared between this worker (dedup /
            // replace / gating), the attach executor (which fills it), and the
            // notify::active-pad handler (2b-A3 advance). Locking is brief and
            // never held across a blocking GStreamer call: the worker locks only
            // to read `track_id`/`qid` for dedup or to overwrite the slot on
            // dispatch; the executor locks only to store/clear after the
            // (off-thread) attach completes. No lock is held across `pipeline.add`
            // / `sync_state_with_parent` / `set_state(Null)` → no deadlock path.
            let next_bin: Arc<Mutex<Option<NextBinState>>> = Arc::new(Mutex::new(None));
            // Set true by 2b-A3's notify handler while concat is switching to the
            // next bin; gates detach/replace (C5) so we never tear down a bin
            // mid-advance. Read by 2b-A3.
            let next_active = Arc::new(AtomicBool::new(false));
            // Monotonic per-boundary token (C4). Stamped on each attach; 2b-A3
            // matches it on advance to reject stale/double switches.
            let mut boundary_counter: u64 = 0;

            // Serialized attach/detach executor thread (C3). The worker dispatches
            // jobs here and returns immediately — it never blocks on pad-slot ops.
            let (attach_tx, attach_rx) = mpsc::channel::<AttachJob>();
            {
                let next_bin_exec = Arc::clone(&next_bin);
                std::thread::spawn(move || run_attach_executor(attach_rx, next_bin_exec));
            }

            // `next_active` + `boundary_counter` are read/written by SetNextTrack
            // (2b-A2); `gapless_capable` + `cmd_tx_worker` are consumed in 2b-A3
            // (notify::active-pad advance + HandleGaplessAdvance dispatch).
            #[allow(clippy::no_effect_underscore_binding)]
            {
                let _ = (gapless_capable, &cmd_tx_worker);
            }

            for cmd in cmd_rx {
                match cmd {
                    AudioCommand::PlayUrl { uri, reply } => {
                        let result = (|| -> Result<(), String> {
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
                                // 2b: legacy `uridecodebin` per branch. `concat` does the
                                // gapless switching, so we no longer need uridecodebin3 /
                                // about-to-finish. Legacy uridecodebin handles Tidal
                                // `data:application/dash+xml` URIs and works on GStreamer
                                // < 1.24.
                                let mut udb =
                                    gst::ElementFactory::make("uridecodebin").property("uri", &uri);
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
                                // Per-branch upstream queue (C1): decouples the decoder from
                                // concat's gate so the next branch can pre-buffer ahead while
                                // the current track plays. With one branch it's a passthrough.
                                let branch_queue = gst::ElementFactory::make("queue")
                                    .property("max-size-time", 5_000_000_000u64)
                                    .property("max-size-buffers", 0u32)
                                    .property("max-size-bytes", 0u32)
                                    .build()
                                    .map_err(|e| format!("Failed to create branch queue: {e}"))?;
                                // `concat` at the head of the chain. With a single sink pad it
                                // is a passthrough (identical signal path to the old direct
                                // chain); the gapless second branch attaches in 2b-A2.
                                let concat = gst::ElementFactory::make("concat")
                                    .name("gapless-concat")
                                    .build()
                                    .map_err(|e| format!("Failed to create concat: {e}"))?;
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
                                    &branch_queue,
                                    &concat,
                                    &audioconvert,
                                    &audioresample,
                                    &norm_vol,
                                    &user_vol,
                                    &sink,
                                ])
                                .map_err(|e| format!("Failed to add elements: {e}"))?;
                                // Static chain: concat → audioconvert → … → sink.
                                // (uridecodebin → branch_queue is dynamic via pad_added;
                                // branch_queue.src → concat sink_0 is linked below.)
                                gst::Element::link_many([
                                    &concat,
                                    &audioconvert,
                                    &audioresample,
                                    &norm_vol,
                                    &user_vol,
                                    &sink,
                                ])
                                .map_err(|e| format!("Failed to link chain: {e}"))?;

                                // N2: connect notify::active-pad BEFORE requesting sink_0.
                                // gstconcat fires `notify` synchronously inside
                                // request_pad_simple when current_sinkpad is NULL; the
                                // first-fire-suppressing stub absorbs that. Real advance
                                // logic lands in 2b-A3.
                                let notify_count = Arc::new(AtomicU32::new(0));
                                concat.connect_notify(Some("active-pad"), move |_concat, _pspec| {
                                    let prev = notify_count.fetch_add(1, Ordering::AcqRel);
                                    if prev != 0 {
                                        // 2b-A3: gate on active-pad identity and dispatch
                                        // HandleGaplessAdvance via cmd_tx_worker here.
                                        // (prev == 0 is the initial sink_0 activation from
                                        // request_pad_simple — suppressed.)
                                    }
                                });

                                // Request concat sink_0 and link the branch queue into it.
                                let concat_sink_0 = concat
                                    .request_pad_simple("sink_%u")
                                    .ok_or_else(|| "concat refused initial sink pad".to_string())?;
                                let queue_src = branch_queue
                                    .static_pad("src")
                                    .ok_or_else(|| "branch queue has no src pad".to_string())?;
                                queue_src
                                    .link(&concat_sink_0)
                                    .map_err(|e| format!("Failed to link queue→concat: {e}"))?;

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

                                // uridecodebin(A) → branch_queue (dynamic). The branch
                                // queue's src is already linked to concat sink_0.
                                let branch_queue_weak = branch_queue.downgrade();
                                uridecodebin.connect_pad_added(move |_src, src_pad| {
                                    let Some(branch_queue) = branch_queue_weak.upgrade() else {
                                        return;
                                    };
                                    let Some(sink_pad) = branch_queue.static_pad("sink") else {
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

                                pipe.set_state(gst::State::Playing)
                                    .map_err(|e| format!("Failed to start playback: {e}"))?;

                                // Bus watcher (normal mode). 2b: the StreamStart arm
                                // (2a gapless trigger) is gone; advance is driven by
                                // concat's notify::active-pad (2b-A3). The bus keeps
                                // Eos / Error / Buffering.
                                let eos_flag = Arc::clone(&eos);
                                let tearing_down_flag = Arc::clone(&tearing_down);
                                let app_handle_clone = app_handle.clone();
                                if let Some(bus) = pipe.bus() {
                                    std::thread::spawn(move || {
                                        for msg in bus.iter_timed(gst::ClockTime::NONE) {
                                            match msg.view() {
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
                                    concat,
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
                                // 2b (C2): under concat (adjust-base=true) query_position
                                // re-bases per track, so it is already B-relative — no
                                // offset subtraction needed.
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
                        // 2b: next-bin detach on mode switch lands in 2b-A3.
                        reply.send(Ok(())).ok();
                    }

                    AudioCommand::SetBitPerfect { enabled, reply } => {
                        bit_perfect = enabled;
                        if enabled {
                            exclusive = true;
                        }
                        // 2b: next-bin detach on mode switch lands in 2b-A3.
                        reply.send(Ok(())).ok();
                    }

                    AudioCommand::SetGapless { enabled, reply } => {
                        // 2b-A2: drives SetNextTrack's effective-gapless gate. The
                        // detach-on-disable pass lands in 2b-A3's detach matrix.
                        gapless_setting = enabled;
                        let _ = reply.send(Ok(()));
                    }

                    // 2b-A2: preroll the next track via a second uridecodebin
                    // attached to concat sink_1, OFF the worker thread (C3). The
                    // worker only validates gating + dedup + records intent, then
                    // dispatches to the attach executor and replies immediately.
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
                        // Effective gapless = setting on AND normal mode (C5: never
                        // attach a concat branch under exclusive/bit-perfect — the
                        // DirectAlsa path has no concat).
                        let effective_gapless = gapless_setting && !exclusive && !bit_perfect;

                        // Normal-mode pipeline/concat clones for the executor. If the
                        // backend isn't Normal (or absent), we can't (and mustn't,
                        // C5) touch concat — treat as "no preroll".
                        let normal_clones = match backend.as_ref() {
                            Some(PlaybackBackend::Normal {
                                pipeline, concat, ..
                            }) => Some((pipeline.clone(), concat.clone())),
                            _ => None,
                        };

                        if !effective_gapless || normal_clones.is_none() {
                            // Gapless off / wrong mode: detach any existing next_bin
                            // (gated on !next_active per C5) and do nothing else.
                            if !next_active.load(Ordering::Acquire) {
                                if let Some(stale) = next_bin.lock().ok().and_then(|mut g| g.take()) {
                                    if let Some(PlaybackBackend::Normal {
                                        pipeline, concat, ..
                                    }) = backend.as_ref()
                                    {
                                        let _ = attach_tx.send(AttachJob::Detach {
                                            pipeline: pipeline.clone(),
                                            concat: concat.clone(),
                                            bin: stale.bin,
                                            branch_queue: stale.branch_queue,
                                        });
                                    }
                                    // If not Normal we can't detach via concat; the
                                    // bin was attached under Normal so backend is
                                    // Normal here in practice. Drop silently otherwise.
                                }
                            }
                            let _ = reply.send(Ok(()));
                            continue;
                        }

                        let (pipeline, concat) = normal_clones.unwrap();

                        // Dedup (C5): if an existing next_bin targets the same track,
                        // just refresh its stored qid (so the eventual track-advanced
                        // payload matches the frontend queue) — no re-attach.
                        {
                            let mut guard = next_bin.lock().unwrap();
                            if let Some(existing) = guard.as_mut() {
                                if existing.track_id == track_id {
                                    existing.qid = qid.clone();
                                    drop(guard);
                                    let _ = reply.send(Ok(()));
                                    continue;
                                }
                            }
                        }

                        // A different next track is requested. Only replace if concat
                        // isn't already switching (C5) — otherwise let 2b-A3's advance
                        // complete and skip.
                        if next_active.load(Ordering::Acquire) {
                            let _ = reply.send(Ok(()));
                            continue;
                        }

                        // Detach the stale (different) bin, then attach the new one.
                        // Both jobs are serialized on the executor, so detach-then-
                        // attach is ordered correctly.
                        if let Some(stale) = next_bin.lock().ok().and_then(|mut g| g.take()) {
                            let _ = attach_tx.send(AttachJob::Detach {
                                pipeline: pipeline.clone(),
                                concat: concat.clone(),
                                bin: stale.bin,
                                branch_queue: stale.branch_queue,
                            });
                        }

                        boundary_counter += 1;
                        let _ = attach_tx.send(AttachJob::Attach {
                            pipeline,
                            concat,
                            uri,
                            is_dash,
                            track_id,
                            qid,
                            norm_gain,
                            replay_gain,
                            peak_amplitude,
                            boundary_id: boundary_counter,
                        });
                        let _ = reply.send(Ok(()));
                    }

                    // 2b-A2: detach the prerolled next bin (gated on !next_active per
                    // C5 — if concat is already switching, leave it for 2b-A3).
                    AudioCommand::ClearNextTrack { reply } => {
                        if !next_active.load(Ordering::Acquire) {
                            if let Some(stale) = next_bin.lock().ok().and_then(|mut g| g.take()) {
                                if let Some(PlaybackBackend::Normal {
                                    pipeline, concat, ..
                                }) = backend.as_ref()
                                {
                                    let _ = attach_tx.send(AttachJob::Detach {
                                        pipeline: pipeline.clone(),
                                        concat: concat.clone(),
                                        bin: stale.bin,
                                        branch_queue: stale.branch_queue,
                                    });
                                }
                            }
                        }
                        let _ = reply.send(Ok(()));
                    }

                    // 2b: real advance logic (promote next_bin, emit track-advanced)
                    // lands in 2b-A3, driven by concat's notify::active-pad.
                    AudioCommand::HandleGaplessAdvance { .. } => {}

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
