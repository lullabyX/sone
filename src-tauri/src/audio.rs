use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
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

/// Commands to the ALSA writer thread
enum WriterCommand {
    Data(AudioChunk),
    EndOfTrack {
        emit_finished: bool,
        generation: u64,
    },
    FormatHint(PcmFormat),
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
        .map_err(|e| format!("set_rate({}): {e}", fmt.sample_rate))?;
    if bit_perfect {
        let actual_rate = hwp.get_rate().map_err(|e| format!("get_rate: {e}"))?;
        if actual_rate != fmt.sample_rate {
            return Err(format!(
                "Bit-perfect: DAC negotiated {}Hz but track requires {}Hz",
                actual_rate, fmt.sample_rate
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
) -> Result<(crossbeam_channel::Sender<WriterCommand>, JoinHandle<()>, PcmFormat, Vec<&'static str>), String> {
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

    let initial_format = configure_alsa_hwparams(&pcm, &initial_format, bit_perfect)?;
    pcm.prepare().map_err(|e| format!("pcm.prepare: {e}"))?;
    current_sample_rate.store(initial_format.sample_rate, Ordering::Relaxed);
    let negotiated_fmt = initial_format.clone();

    let handle = std::thread::Builder::new()
        .name("alsa-writer".into())
        .spawn(move || {
            let mut pcm = pcm; // rebind as mutable for format-change reopen
            let mut current_fmt = initial_format;
            let period_duration = std::time::Duration::from_millis(50);

            let silence_frames = (current_fmt.sample_rate as usize * 50) / 1000;
            let mut silence_buf = vec![0u8; silence_frames * current_fmt.channels as usize * current_fmt.bytes_per_sample as usize];

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
                "[alsa-writer] started, device={device}, format={}, rate={}Hz, channels={}, bps={}",
                current_fmt.gst_format, current_fmt.sample_rate, current_fmt.channels, current_fmt.bytes_per_sample
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
                        let vol = f32::from_bits(combined_vol.load(Ordering::Relaxed));
                        apply_volume(&mut chunk.data, &current_fmt, vol);
                        if let Err(kind) = write_bytes(&pcm, &chunk.data, &current_fmt, &frames_written, &silence_buf) {
                            app_handle.emit("audio-error", serde_json::json!({ "kind": kind })).ok();
                            tearing_down.store(true, Ordering::SeqCst);
                            break;
                        }
                    }

                    Ok(WriterCommand::FormatHint(new_fmt)) => {
                        if new_fmt != current_fmt {
                            log::info!("[alsa-writer] format hint: {current_fmt:?} -> {new_fmt:?}");
                            drop(pcm);
                            match reopen_alsa(&device, &new_fmt, &current_sample_rate, &mut silence_buf, bit_perfect) {
                                Ok((new_pcm, negotiated)) => {
                                    pcm = new_pcm;
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
                    }

                    Ok(WriterCommand::EndOfTrack { emit_finished, generation }) => {
                        if generation < writer_gen.load(Ordering::Acquire) {
                            continue; // stale EOS from old pipeline
                        }
                        let got_shutdown = drain_writer_rx(&rx);
                        if !write_silence(&pcm, &silence_buf) {
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
                                    let vol = f32::from_bits(combined_vol.load(Ordering::Relaxed));
                                    apply_volume(&mut chunk.data, &current_fmt, vol);
                                    if let Err(kind) = write_bytes(&pcm, &chunk.data, &current_fmt, &frames_written, &silence_buf) {
                                        app_handle.emit("audio-error", serde_json::json!({ "kind": kind })).ok();
                                        break 'main;
                                    }
                                    break; // back to main loop
                                }
                                Ok(WriterCommand::Shutdown) => break 'main,
                                Ok(WriterCommand::Flush) => { drain_writer_rx(&rx); pcm.drop().ok(); pcm.prepare().ok(); break; }
                                Ok(WriterCommand::FormatHint(new_fmt)) => {
                                    if new_fmt != current_fmt {
                                        log::info!("[alsa-writer] format hint (idle): {current_fmt:?} -> {new_fmt:?}");
                                        drop(pcm);
                                        match reopen_alsa(&device, &new_fmt, &current_sample_rate, &mut silence_buf, bit_perfect) {
                                            Ok((new_pcm, negotiated)) => {
                                                pcm = new_pcm;
                                                current_fmt = negotiated;
                                            }
                                            Err(e) => {
                                                log::error!("[alsa-writer] reopen for format hint failed (idle): {e}");
                                                app_handle.emit("audio-error", serde_json::json!({ "kind": "format_change_failed", "message": e })).ok();
                                                return;
                                            }
                                        }
                                    }
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
                    }

                    Ok(WriterCommand::Shutdown) => {
                        log::debug!("[alsa-writer] shutdown");
                        pcm.drop().ok();
                        break;
                    }

                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                        if !write_silence(&pcm, &silence_buf) {
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

    Ok((tx, handle, negotiated_fmt, supported_gst_formats))
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
    ListDevices {
        reply: Reply<Result<Vec<AudioDevice>, String>>,
    },
}

// ── AudioPlayer (public API unchanged) ─────────────────────────────────

#[derive(Clone)]
pub struct AudioPlayer {
    cmd_tx: mpsc::Sender<AudioCommand>,
}

impl AudioPlayer {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel::<AudioCommand>();

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
                                                    vol.set_property("volume", current_volume * (i as f64 / 10.0));
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

                                    if !writer_alive || writer_tx.is_none() {
                                        // Shut down old writer cleanly
                                        if let Some(tx) = writer_tx.take() {
                                            tx.try_send(WriterCommand::Shutdown).ok();
                                        }
                                        if let Some(h) = writer_thread.take() {
                                            h.join().ok();
                                        }
                                        let (tx, handle, negotiated_fmt, supported_gst_fmts) = spawn_alsa_writer(
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
                                        )?;
                                        writer_tx = Some(tx);
                                        writer_thread = Some(handle);
                                        writer_fmt = Some(negotiated_fmt);
                                        writer_supported_fmts = Some(supported_gst_fmts);
                                    }

                                    let wtx = writer_tx.as_ref().unwrap().clone();

                                    // Build appsink pipeline
                                    let fmt_for_pipeline = writer_fmt.as_ref().unwrap_or(&default_fmt);
                                    let supported_fmts_for_pipeline = writer_supported_fmts.as_deref().unwrap_or(&["S32LE"]);
                                    let (pipe, u_vol, n_vol) = build_appsink_pipeline(
                                        &uri,
                                        exclusive,
                                        bit_perfect,
                                        wtx.clone(),
                                        Arc::clone(&writer_gen),
                                        fmt_for_pipeline,
                                        supported_fmts_for_pipeline,
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
                                let mut udb =
                                    gst::ElementFactory::make("uridecodebin").property("uri", &uri);
                                if is_dash {
                                    udb = udb
                                        .property("buffer-duration", 15_000_000_000i64)
                                        .property("use-buffering", true);
                                }
                                let uridecodebin = udb
                                    .build()
                                    .map_err(|e| format!("Failed to create uridecodebin: {e}"))?;
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
                                    .property("volume", current_volume)
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

                                pipe.set_state(gst::State::Playing)
                                    .map_err(|e| format!("Failed to start playback: {e}"))?;

                                // Bus watcher (normal mode — unchanged)
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
                                pipeline
                                    .set_state(gst::State::Null)
                                    .map(|_| {
                                        eos.store(false, Ordering::SeqCst);
                                        has_uri.store(false, Ordering::SeqCst);
                                    })
                                    .map_err(|e| format!("Failed to stop: {e}"))
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
                        if let Some(vol) = backend.as_ref().and_then(|b| b.user_volume_el()) {
                            vol.set_property("volume", current_volume);
                        }
                        combined_vol.store(
                            ((current_volume * current_norm_gain) as f32).to_bits(),
                            Ordering::Relaxed,
                        );
                        reply.send(Ok(())).ok();
                    }

                    AudioCommand::SetNormalizationGain { gain, reply } => {
                        current_norm_gain = gain;
                        if let Some(vol) = backend.as_ref().and_then(|b| b.norm_volume_el()) {
                            vol.set_property("volume", gain);
                        }
                        combined_vol.store(
                            ((current_volume * current_norm_gain) as f32).to_bits(),
                            Ordering::Relaxed,
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
                        reply.send(Ok(())).ok();
                    }

                    AudioCommand::SetBitPerfect { enabled, reply } => {
                        bit_perfect = enabled;
                        if enabled {
                            exclusive = true;
                        }
                        reply.send(Ok(())).ok();
                    }

                    AudioCommand::ListDevices { reply } => {
                        let result = list_alsa_devices_inner();
                        reply.send(result).ok();
                    }
                }
            }
        });

        Self { cmd_tx }
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
    pub fn list_devices(&self) -> Result<Vec<AudioDevice>, String> {
        self.send_cmd(|reply| AudioCommand::ListDevices { reply })
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
    negotiated_fmt: &PcmFormat,
    supported_gst_formats: &[&str],
) -> Result<(gst::Pipeline, Option<gst::Element>, Option<gst::Element>), String> {
    use gst_app::prelude::*;

    let pipe = gst::Pipeline::new();
    let is_dash = uri.starts_with("data:application/dash");
    let mut udb = gst::ElementFactory::make("uridecodebin").property("uri", uri);
    if is_dash {
        udb = udb
            .property("buffer-duration", 15_000_000_000i64)
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

    // DASH + bit-perfect: constrain appsink to ALSA-safe formats.
    // No rate/channel constraint — allows mid-stream renegotiation.
    // Capsfilter is omitted for DASH; appsink caps negotiate without blocking renegotiation.
    if is_dash && bit_perfect {
        appsink.set_caps(Some(
            &gst::Caps::builder("audio/x-raw")
                .field("format", gst::List::new(supported_gst_formats.iter().copied()))
                .build(),
        ));
        log::debug!("[audio] bit-perfect DASH: appsink caps = {:?}", supported_gst_formats);
    }

    log::debug!(
        "[audio] building appsink pipeline: exclusive={exclusive} bit_perfect={bit_perfect}"
    );

    let (u_vol, n_vol) = if bit_perfect {
        audioconvert.set_property_from_str("dithering", "none");
        audioconvert.set_property_from_str("noise-shaping", "none");

        if is_dash {
            // DASH: no capsfilter — appsink caps constrain format,
            // audioconvert passes through rate changes
            pipe.add_many([&uridecodebin, &audioconvert, appsink.upcast_ref()])
                .map_err(|e| format!("Failed to add elements: {e}"))?;
            gst::Element::link_many([&audioconvert, appsink.upcast_ref()])
                .map_err(|e| format!("Failed to link bit-perfect DASH chain: {e}"))?;
        } else {
            // BTS: capsfilter for dynamic locking (preserves exact decoded format)
            let capsfilter = gst::ElementFactory::make("capsfilter")
                .build()
                .map_err(|e| format!("Failed to create capsfilter: {e}"))?;
            pipe.add_many([
                &uridecodebin,
                &audioconvert,
                &capsfilter,
                appsink.upcast_ref(),
            ])
            .map_err(|e| format!("Failed to add elements: {e}"))?;
            gst::Element::link_many([&audioconvert, &capsfilter, appsink.upcast_ref()])
                .map_err(|e| format!("Failed to link bit-perfect chain: {e}"))?;
        }

        (None, None)
    } else {
        // Exclusive (non-bit-perfect): volume applied in ALSA writer thread.
        // Rate is unconstrained — source's native sample rate passes through.
        let audioresample = gst::ElementFactory::make("audioresample")
            .build()
            .map_err(|e| format!("Failed to create audioresample: {e}"))?;
        let capsfilter = gst::ElementFactory::make("capsfilter")
            .property(
                "caps",
                gst::Caps::builder("audio/x-raw")
                    .field("format", negotiated_fmt.gst_format.as_str())
                    .field("channels", negotiated_fmt.channels as i32)
                    .build(),
            )
            .build()
            .map_err(|e| format!("Failed to create capsfilter: {e}"))?;

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

        (None, None)
    };

    // Grab capsfilter weak ref for bit-perfect cap locking.
    // Skip for DASH URIs — adaptive demux renegotiates caps mid-stream,
    // which the locked capsfilter rejects (GST_FLOW_ERROR). DASH caps are
    // already constrained to safe formats above.
    let capsfilter_weak: Option<gst::glib::WeakRef<gst::Element>> = if bit_perfect && !is_dash {
        audioconvert
            .static_pad("src")
            .and_then(|p| p.peer())
            .and_then(|p| p.parent_element())
            .map(|el| el.downgrade())
    } else {
        None
    };

    // Connect uridecodebin's dynamic pad to audioconvert
    let convert_weak = audioconvert.downgrade();
    let supported_fmts_for_closure: Vec<String> = supported_gst_formats.iter().map(|s| s.to_string()).collect();
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

        // Bit-perfect: lock capsfilter to decoded format
        if let Some(ref cf_weak) = capsfilter_weak {
            if let Some(cf) = cf_weak.upgrade() {
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
                            let locked = if format.starts_with("S24") {
                                // Filter to S24/S32 formats the DAC actually supports
                                let s24_candidates: Vec<&str> = supported_fmts_for_closure
                                    .iter()
                                    .map(|s| s.as_str())
                                    .filter(|f| *f == "S24LE" || *f == "S24_32LE" || *f == "S32LE")
                                    .collect();
                                let fmts = if s24_candidates.is_empty() {
                                    vec!["S32LE"] // safe fallback
                                } else {
                                    s24_candidates
                                };
                                gst::Caps::builder("audio/x-raw")
                                    .field("format", gst::List::new(fmts.iter().copied()))
                                    .field("rate", rate)
                                    .field("channels", channels)
                                    .build()
                            } else {
                                gst::Caps::builder("audio/x-raw")
                                    .field("format", format)
                                    .field("rate", rate)
                                    .field("channels", channels)
                                    .build()
                            };
                            log::info!("[audio] bit-perfect: locking capsfilter to {locked}");
                            cf.set_property("caps", &locked);
                        }
                    }
                }
            }
        }
    });

    // Pad probe: intercept CAPS events for preemptive ALSA format changes (DASH renegotiation)
    let probe_tx = writer_tx.clone();
    if let Some(sink_pad) = appsink.static_pad("sink") {
        sink_pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_pad, info| {
            if let Some(gst::PadProbeData::Event(ref event)) = info.data {
                if let gst::EventView::Caps(caps_event) = event.view() {
                    let caps = caps_event.caps();
                    if let Some(fmt) = parse_pcm_format(caps) {
                        log::debug!("[audio] CAPS event on appsink: {fmt:?}");
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
