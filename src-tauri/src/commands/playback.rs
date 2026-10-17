use serde::Deserialize;
use std::sync::atomic::Ordering;
use tauri::State;

use crate::tidal_api::{StreamInfo, TidalVideo, VideoStreamInfo};
use crate::AppState;
use crate::SoneError;

/// Tidal-correct normalization: 0.8 * min(10^((rg + 4) / 20), 1 / peak)
pub fn compute_norm_gain(replay_gain: Option<f64>, peak_amplitude: Option<f64>) -> f64 {
    match replay_gain {
        Some(rg) => {
            let pre_amp = 4.0;
            let linear = 10.0_f64.powf((rg + pre_amp) / 20.0);
            let peak = peak_amplitude.filter(|&p| p > 0.0).unwrap_or(1.0);
            let sf = linear.min(1.0 / peak);
            0.8 * sf
        }
        None => 1.0,
    }
}

/// Resolved stream slot: everything a caller needs to arm/play a track.
/// `replay_gain`/`peak_amplitude` are `f64::NAN` when absent.
pub type ResolvedStream = (StreamInfo, String, f64, f64, f64, bool);

/// Tidal quality tiers to attempt, highest→lowest, given the user's quality
/// `ceiling` and whether confidential credentials (`client_secret`) are present.
/// Tiers above the ceiling are dropped; the two Hi-Res tiers require a secret
/// and are dropped without one. An unknown ceiling is treated as "max". The
/// result always includes "HIGH", so it is never empty.
fn quality_tiers(ceiling: &str, has_secret: bool) -> Vec<&'static str> {
    const ORDER: [&str; 4] = ["HI_RES_LOSSLESS", "HI_RES", "LOSSLESS", "HIGH"];
    let ceiling_idx = ORDER.iter().position(|&t| t == ceiling).unwrap_or(0);
    ORDER
        .iter()
        .enumerate()
        .filter(|(i, _)| *i >= ceiling_idx)
        .filter(|(_, &t)| has_secret || (t != "HI_RES_LOSSLESS" && t != "HI_RES"))
        .map(|(_, &t)| t)
        .collect()
}

/// Shared resolver: runs the quality cascade, builds the DASH/BTS URI, selects
/// replay-gain/peak per playback context, and computes the normalization gain.
/// Returns `(stream_info, uri, norm_gain, replay_gain, peak_amplitude, is_dash)`.
/// Does NOT touch `last_replay_gain`/`last_track_id` or start playback.
pub async fn resolve_play_uri(
    state: &AppState,
    track_id: u64,
    use_track_gain: bool,
) -> Result<ResolvedStream, SoneError> {
    // Try quality tiers from highest to lowest.
    // Without client_secret, skip Hi-Res (those credentials typically return
    // encrypted DASH streams that require Widevine). With a secret, the
    // confidential PKCE credentials may return unencrypted Hi-Res BTS streams.
    let stream_info = {
        let mut client = state.tidal_client.lock().await;
        let has_secret = !client.client_secret.is_empty();
        let ceiling = state.max_quality.lock().unwrap().clone();
        let tiers = quality_tiers(&ceiling, has_secret);

        let mut result: Option<StreamInfo> = None;
        let mut last_err: Option<SoneError> = None;
        for &tier in &tiers {
            match client.get_stream_url(track_id, tier).await {
                Ok(info) => {
                    result = Some(info);
                    break;
                }
                Err(e) if e.is_network() => return Err(e),
                // A rate-limit or a terminal-unplayable answer will not change
                // at a lower tier — over-requesting quality returns 200 with a
                // downgraded audioQuality, never an error. Walking the rest of
                // the cascade only multiplies the request count by 4.
                Err(e) if e.is_rate_limited() || e.is_terminal_unplayable() => return Err(e),
                Err(e) => last_err = Some(e),
            }
        }
        match result {
            Some(info) => info,
            // `quality_tiers` always yields at least "HIGH", so the loop runs
            // at least once and `last_err` is set on total failure.
            None => return Err(last_err.expect("quality_tiers always yields HIGH")),
        }
    };

    log::debug!(
        "[resolve_play_uri]: track_id={} — quality={:?}, bitDepth={:?}, sampleRate={:?}, codec={:?}, dash={}",
        track_id, stream_info.audio_quality, stream_info.bit_depth, stream_info.sample_rate,
        stream_info.codec, stream_info.manifest.is_some()
    );

    // Capture the actual served attributes for TIDAL play-reporting.
    state
        .tidal_reporter
        .note_stream_resolved(
            track_id,
            crate::tidal_report::StreamMeta {
                actual_product_id: stream_info.track_id,
                quality: stream_info
                    .audio_quality
                    .clone()
                    .unwrap_or_else(|| "LOSSLESS".into()),
                audio_mode: stream_info
                    .audio_mode
                    .clone()
                    .unwrap_or_else(|| "STEREO".into()),
                presentation: stream_info
                    .asset_presentation
                    .clone()
                    .unwrap_or_else(|| "FULL".into()),
                at_ms: (crate::now_secs() as i64) * 1000,
            },
        )
        .await;

    let is_dash = stream_info.manifest.is_some();
    let uri = if let Some(ref mpd) = stream_info.manifest {
        // DASH: pass MPD manifest as a data URI for GStreamer's dashdemux.
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(mpd.as_bytes());
        format!("data:application/dash+xml;base64,{}", b64)
    } else {
        // BTS: direct URL.
        stream_info.url.clone()
    };

    // Select replay gain + peak based on playback context (album vs mixed queue)
    let (selected_rg, selected_peak) = if use_track_gain {
        (
            stream_info
                .track_replay_gain
                .or(stream_info.album_replay_gain),
            stream_info
                .track_peak_amplitude
                .or(stream_info.album_peak_amplitude),
        )
    } else {
        (
            stream_info
                .album_replay_gain
                .or(stream_info.track_replay_gain),
            stream_info
                .album_peak_amplitude
                .or(stream_info.track_peak_amplitude),
        )
    };

    let norm_gain = if state.volume_normalization.load(Ordering::Relaxed) {
        compute_norm_gain(selected_rg, selected_peak)
    } else {
        1.0
    };
    log::debug!(
        "[resolve_play_uri]: normalization gain={:.3} (use_track_gain={}, rg={:?}, peak={:?})",
        norm_gain,
        use_track_gain,
        selected_rg,
        selected_peak
    );

    Ok((
        stream_info,
        uri,
        norm_gain,
        selected_rg.unwrap_or(f64::NAN),
        selected_peak.unwrap_or(f64::NAN),
        is_dash,
    ))
}

/// Report why a tier will be refused, so the user sees the proxy named rather
/// than a bare playback failure.
///
/// Advisory only. The audio thread refuses independently at every pipeline
/// build; this runs earlier purely so the message is a good one.
fn explain_block(
    settings: &crate::ProxySettings,
    caps: &crate::proxy::HostCaps,
    is_dash: bool,
) -> Result<(), SoneError> {
    let capability = if is_dash {
        crate::proxy::Capability::Dash
    } else {
        crate::proxy::Capability::Lossy
    };
    let plan = crate::proxy::plan(settings, caps).map_err(|e| SoneError::ProxyBlocked {
        reason: e.to_string(),
    })?;
    plan.route(capability, caps)
        .map_err(|e| SoneError::ProxyBlocked { reason: e.cause })?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn play_tidal_track(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    track_id: u64,
    use_track_gain: bool,
) -> Result<StreamInfo, SoneError> {
    let (stream_info, uri, norm_gain, rg, peak, is_dash) =
        resolve_play_uri(state.inner(), track_id, use_track_gain).await?;

    // Advisory only, and deliberately fail-open: `load_settings()` returns
    // `None` on a read, decrypt, UTF-8 or JSON failure, and the default has
    // `enabled: false`, so a corrupt settings file passes this check silently.
    // That is fine ONLY because the containment boundary is elsewhere — the
    // audio thread reads the settings the worker actually holds and refuses at
    // every pipeline build regardless of what happens here. Never treat this
    // as authoritative, and never drop the audio thread's refusals because
    // this exists.
    let proxy_settings = state.load_settings().unwrap_or_default().proxy;
    explain_block(&proxy_settings, &state.host_caps(), is_dash)?;

    // Store selected values for live toggle
    state.last_replay_gain.store(rg.to_bits(), Ordering::Relaxed);
    state
        .last_peak_amplitude
        .store(peak.to_bits(), Ordering::Relaxed);

    // Check if remote TIDAL Connect speaker is active
    let active_device_opt = state.tidal_connect.active_device.read().await.clone();
    let is_remote = if let Some(ref dev) = active_device_opt {
        if !state.tidal_connect.client.is_connected().await {
            log::info!("[play_tidal_track] Reconnecting to TIDAL Connect device {} ({}:{})", dev.name, dev.host, dev.port);
            let target_host = dev
                .addresses
                .iter()
                .find(|a| !a.contains(':'))
                .unwrap_or(&dev.host);
            state.tidal_connect.client.connect(&dev.id, target_host, dev.port, None).await.is_ok()
        } else {
            true
        }
    } else {
        false
    };
    if is_remote {
        // LinkPlay push-URL cast. The receiver's loadLocalQueue route crashes
        // its process on any payload (findings/tidal_connect_protocol_spec.md
        // section 6), so never build that envelope again. Instead, resolve a
        // concrete URL and hand it to the receiver's LinkPlay player:
        // - DASH: the resolved manifest is XML with ABSOLUTE segment URLs on
        //   the TIDAL CDN; serve it locally so the receiver can fetch it.
        // - BTS: the resolved URL is a plain stream URL; push it directly.
        let dev = active_device_opt
            .as_ref()
            .expect("is_remote implies active device");
        let target_host = dev
            .addresses
            .iter()
            .find(|a| !a.contains(':'))
            .unwrap_or(&dev.host)
            .clone();

        let push_url = if is_dash {
            let mpd_xml = stream_info
                .manifest
                .clone()
                .ok_or_else(|| SoneError::Audio("TIDAL Connect DASH manifest missing".into()))?;
            let base = state
                .tidal_connect
                .manifest_server
                .ensure_started(&target_host)
                .await
                .map_err(SoneError::Audio)?;
            state
                .tidal_connect
                .manifest_server
                .set(&mpd_xml)
                .await
                .map_err(SoneError::Audio)?;
            // The receiver names the push after the URL it was handed, so put
            // the track in the path: the WiiM Home app shows the decoded URL
            // as the now-playing title. This firmware ignores every metadata
            // write channel (setPlayerCmd:setMetaInfo?*, stream tags, ICY
            // headers - verified 2026-10-17), so the named path is the only
            // user-visible track identification for push-URL casts.
            let display_name = {
                let mut client = state.tidal_client.lock().await;
                match client.get_track(track_id).await {
                    Ok(track_val) => {
                        let title = track_val
                            .get("title")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Title unknown");
                        let artist = track_val
                            .get("artist")
                            .or_else(|| track_val.get("artists").and_then(|v| v.get(0)))
                            .and_then(|a| a.get("name"))
                            .and_then(|n| n.as_str())
                            .unwrap_or("Artist unknown");
                        format!("{} - {}", artist, title)
                    }
                    Err(_) => format!("track-{}", track_id),
                }
            };
            format!("{}/{}.mpd", base, encode_display_name(&display_name))
        } else {
            if stream_info.url.is_empty() {
                return Err(SoneError::Audio(
                    "TIDAL Connect: no stream URL for non-DASH track".into(),
                ));
            }
            stream_info.url.clone()
        };

        // Stop local GStreamer audio so user's headphones don't play simultaneously
        let _ = state.audio_player.stop();

        state
            .tidal_connect
            .linkplay
            .push_url(&target_host, &push_url, &state.tidal_connect.cast_status)
            .await
            .map_err(|e| SoneError::Audio(format!("LinkPlay push-URL cast failed: {}", e)))?;

        *state.tidal_connect.cast_host.write().await = Some(target_host.clone());
        state.tidal_connect.client.set_cast_active(true);
        crate::tidal_connect::ensure_cast_poller(app.clone(), &state.tidal_connect).await;
        log::info!(
            "[play_tidal_track] Cast track {} to {} via LinkPlay push-URL",
            track_id,
            target_host
        );
    } else {
        // Apply normalization gain BEFORE play_url so the pipeline builds with
        // the correct current_norm_gain — prevents volume spike on track start.
        let player = state.audio_player.clone();
        tokio::task::spawn_blocking(move || {
            player.set_normalization_gain(norm_gain)?;
            player.play_url(&uri, None)
        })
            .await
            .map_err(|e| SoneError::Audio(e.to_string()))?
            .map_err(SoneError::Audio)?;
    }

    // Save last played track
    if let Some(mut settings) = state.load_settings() {
        settings.last_track_id = Some(track_id);
        state.save_settings(&settings).ok();
    }

    Ok(stream_info)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_next_track(
    state: State<'_, AppState>,
    track_id: u64,
    qid: String,
    use_track_gain: bool,
) -> Result<StreamInfo, SoneError> {
    let (info, uri, gain, rg, peak, is_dash) =
        resolve_play_uri(state.inner(), track_id, use_track_gain).await?;

    if state.tidal_connect.active_device.read().await.is_some() {
        return Ok(info);
    }

    // Advisory only, same fail-open caveat as `play_tidal_track`: a corrupt
    // settings file makes this pass silently. The audio thread is the
    // boundary; it refuses at pipeline build with the settings it holds.
    let proxy_settings = state.load_settings().unwrap_or_default().proxy;
    explain_block(&proxy_settings, &state.host_caps(), is_dash)?;

    state
        .audio_player
        .set_next_track(uri, gain, track_id, qid, rg, peak, is_dash)
        .map_err(SoneError::Audio)?;
    Ok(info)
}

#[tauri::command]
pub fn clear_next_track(state: State<'_, AppState>) -> Result<(), SoneError> {
    if state.tidal_connect.active_device.blocking_read().is_some() {
        return Ok(());
    }
    state.audio_player.clear_next_track().map_err(SoneError::Audio)
}

/// Pure resolver: returns `StreamInfo` WITHOUT arming the gapless slot or
/// starting playback. Used by the frontend's rare track-advanced stash-miss
/// recovery to adopt an already-playing track. Must NOT call
/// `audio_player.set_next_track` / `play_url`.
#[tauri::command(rename_all = "camelCase")]
pub async fn get_stream_info(
    state: State<'_, AppState>,
    track_id: u64,
    use_track_gain: bool,
) -> Result<StreamInfo, SoneError> {
    let (info, _uri, _gain, _rg, _peak, _is_dash) =
        resolve_play_uri(state.inner(), track_id, use_track_gain).await?;
    Ok(info)
}

/// Resolve a music video's HLS master playlist URL. Pure resolver — video
/// plays in the WebView, so this never touches the audio pipeline.
#[tauri::command(rename_all = "camelCase")]
pub async fn get_video_stream_info(
    state: State<'_, AppState>,
    video_id: u64,
    video_quality: Option<String>,
) -> Result<VideoStreamInfo, SoneError> {
    let quality = video_quality.unwrap_or_else(|| "HIGH".to_string());
    let mut client = state.tidal_client.lock().await;
    client.get_video_stream_url(video_id, &quality).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_video_metadata(
    state: State<'_, AppState>,
    video_id: u64,
) -> Result<TidalVideo, SoneError> {
    let mut client = state.tidal_client.lock().await;
    client.get_video(video_id).await
}

#[tauri::command]
pub async fn pause_track(state: State<'_, AppState>) -> Result<(), SoneError> {
    log::debug!("[pause_track]");
    if state.tidal_connect.active_device.read().await.is_some() {
        if let Some(host) = state.tidal_connect.cast_host.read().await.clone() {
            let _ = state.tidal_connect.linkplay.pause(&host).await;
        } else {
            let _ = state.tidal_connect.client.pause().await;
        }
        state.tidal_reporter.on_pause().await;
        state.scrobble_manager.on_pause().await;
        return Ok(());
    }
    let result = state.audio_player.pause().map_err(SoneError::Audio);
    state.tidal_reporter.on_pause().await;
    state.scrobble_manager.on_pause().await;
    result
}

#[tauri::command]
pub async fn resume_track(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), SoneError> {
    log::debug!("[resume_track]");
    if state.tidal_connect.active_device.read().await.is_some() {
        if let Some(host) = state.tidal_connect.cast_host.read().await.clone() {
            let _ = state.tidal_connect.linkplay.resume(&host).await;
        } else if let Some(track_id) = state.load_settings().and_then(|s| s.last_track_id) {
            let _ = play_tidal_track(app, state.clone(), track_id, true).await;
        }
        state.tidal_reporter.on_resume().await;
        state.scrobble_manager.on_resume().await;
        return Ok(());
    }
    let result = state.audio_player.resume().map_err(SoneError::Audio);
    state.tidal_reporter.on_resume().await;
    state.scrobble_manager.on_resume().await;
    result
}

/// Tear down playback: stop the audio pipeline, clear the MPRIS/Discord
/// now-playing surfaces, and notify the scrobble manager. Shared by the
/// `stop_track` command and `logout`.
pub(crate) async fn stop_playback(state: &AppState) -> Result<(), SoneError> {
    if state.tidal_connect.active_device.read().await.is_some() {
        if let Some(host) = state.tidal_connect.cast_host.read().await.clone() {
            let _ = state
                .tidal_connect
                .linkplay
                .stop(&host, &state.tidal_connect.cast_status)
                .await;
            // The push-URL stream is gone once the receiver's player is
            // stopped; dropping the cast context routes a later resume
            // through the last-track re-push (play_tidal_track) rather than
            // a receiver-side `resume` that has nothing to resume.
            *state.tidal_connect.cast_host.write().await = None;
            *state.tidal_connect.cast_status.write().await = None;
        } else {
            let _ = state.tidal_connect.client.stop().await;
        }
        #[cfg(target_os = "linux")]
        state.mpris.send(crate::mpris::MprisCommand::Stop);
        state.discord.send(crate::discord::DiscordCommand::Stop);
        state.tidal_reporter.on_track_stopped().await;
        state.scrobble_manager.on_track_stopped().await;
        let _ = state.audio_player.stop();
        return Ok(());
    }
    let result = state.audio_player.stop().map_err(SoneError::Audio);
    #[cfg(target_os = "linux")]
    state.mpris.send(crate::mpris::MprisCommand::Stop);
    state.discord.send(crate::discord::DiscordCommand::Stop);
    state.tidal_reporter.on_track_stopped().await;
    state.scrobble_manager.on_track_stopped().await;
    result
}

#[tauri::command]
pub async fn stop_track(state: State<'_, AppState>) -> Result<(), SoneError> {
    log::debug!("[stop_track]");
    stop_playback(state.inner()).await
}

#[tauri::command]
pub async fn set_volume(state: State<'_, AppState>, level: f32) -> Result<(), SoneError> {
    let active_opt = state.tidal_connect.active_device.read().await.clone();
    if let Some(dev) = active_opt {
        if let Some(host) = state.tidal_connect.cast_host.read().await.clone() {
            // Push-URL cast: volume rides LinkPlay's 0-100 scale (the failing
            // loadLocalQueue envelope must never be built; see the session
            // notes in findings/tidal_connect_protocol_spec.md).
            let _ = state
                .tidal_connect
                .linkplay
                .set_volume(&host, level as f64 * 100.0)
                .await;
        } else {
            if !state.tidal_connect.client.is_connected().await {
                let target_host = dev
                    .addresses
                    .iter()
                    .find(|a| !a.contains(':'))
                    .unwrap_or(&dev.host);
                let _ = state.tidal_connect.client.connect(&dev.id, target_host, dev.port, None).await;
            }
            let _ = state
                .tidal_connect
                .client
                .set_volume(level as f64)
                .await;
        }
    }

    state
        .audio_player
        .set_volume(level)
        .map_err(SoneError::Audio)?;

    #[cfg(target_os = "linux")]
    state.mpris.send(crate::mpris::MprisCommand::SetVolume {
        volume: level as f64,
    });

    // Save volume to settings
    if let Some(mut settings) = state.load_settings() {
        settings.volume = level;
        state.save_settings(&settings).ok();
    }

    Ok(())
}

// Off the main thread: a sync command runs there, and a wait on a stalled
// audio thread froze the whole window.
#[tauri::command]
pub async fn get_playback_position(state: State<'_, AppState>) -> Result<f32, SoneError> {
    if state.tidal_connect.active_device.read().await.is_some() {
        if state.tidal_connect.cast_host.read().await.is_some() {
            return Ok(state
                .tidal_connect
                .cast_status
                .read()
                .await
                .as_ref()
                .map(|s| (s.pos_ms / 1000.0) as f32)
                .unwrap_or(0.0));
        }
        return Ok(state.tidal_connect.client.get_position().await);
    }
    let player = state.audio_player.clone();
    tokio::task::spawn_blocking(move || player.get_position())
        .await
        .map_err(|e| SoneError::Audio(e.to_string()))?
        .map_err(SoneError::Audio)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn seek_track(state: State<'_, AppState>, position_secs: f32) -> Result<(), SoneError> {
    log::debug!("[seek_track]: position_secs={:.1}", position_secs);
    if state.tidal_connect.active_device.read().await.is_some() {
        if let Some(host) = state.tidal_connect.cast_host.read().await.clone() {
            let _ = state
                .tidal_connect
                .linkplay
                .seek(&host, position_secs as f64 * 1000.0, &state.tidal_connect.cast_status)
                .await;
        } else {
            let _ = state.tidal_connect.client.seek(position_secs as f64).await;
        }
        #[cfg(target_os = "linux")]
        state.mpris.send(crate::mpris::MprisCommand::Seeked {
            position_secs: position_secs as f64,
        });
        state.discord.send(crate::discord::DiscordCommand::Seeked {
            position_secs: position_secs as f64,
        });
        state.tidal_reporter.on_seek().await;
        state.scrobble_manager.on_seek().await;
        return Ok(());
    }
    let result = state
        .audio_player
        .seek(position_secs)
        .map_err(SoneError::Audio);
    #[cfg(target_os = "linux")]
    state.mpris.send(crate::mpris::MprisCommand::Seeked {
        position_secs: position_secs as f64,
    });
    state.discord.send(crate::discord::DiscordCommand::Seeked {
        position_secs: position_secs as f64,
    });
    state.tidal_reporter.on_seek().await;
    state.scrobble_manager.on_seek().await;
    result
}

#[tauri::command]
pub async fn is_track_finished(state: State<'_, AppState>) -> Result<bool, SoneError> {
    if state.tidal_connect.active_device.read().await.is_some() {
        if state.tidal_connect.cast_host.read().await.is_some() {
            // Push-URL cast: "stop" after the receiver played the track to
            // its reported end is a finished track (not a user stop).
            let slot = state.tidal_connect.cast_status.read().await;
            if let Some(s) = slot.as_ref() {
                return Ok(s.status == "stop" && s.totlen_ms > 0 && s.pos_ms >= s.totlen_ms as f64 - 1500.0);
            }
            return Ok(false);
        }
        return Ok(state.tidal_connect.client.is_finished().await);
    }
    let player = state.audio_player.clone();
    tokio::task::spawn_blocking(move || player.is_finished())
        .await
        .map_err(|e| SoneError::Audio(e.to_string()))?
        .map_err(SoneError::Audio)
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_playback_queue(
    state: State<'_, AppState>,
    snapshot_json: String,
) -> Result<(), SoneError> {
    state.write_state_file("queue.json", &snapshot_json)?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn load_playback_queue(state: State<'_, AppState>) -> Result<Option<String>, SoneError> {
    Ok(state.read_state_file("queue.json"))
}

// ---- MPRIS metadata/status commands ----

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MprisMetadata {
    pub track_id: u64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub art_url: String,
    pub duration_secs: f64,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub quality_text: String,
    #[serde(default)]
    pub album_artist: Option<String>,
    #[serde(default)]
    pub track_number: Option<u32>,
    #[serde(default)]
    pub disc_number: Option<u32>,
    #[serde(default)]
    pub content_created: Option<String>,
    #[serde(default)]
    pub user_rating: Option<f64>,
}

#[tauri::command(rename_all = "camelCase")]
#[allow(unused_variables)]
pub fn update_mpris_metadata(
    state: State<'_, AppState>,
    metadata: MprisMetadata,
) -> Result<(), SoneError> {
    #[cfg(target_os = "linux")]
    state.mpris.send(crate::mpris::MprisCommand::SetMetadata {
        track_id: metadata.track_id,
        title: metadata.title.clone(),
        artist: metadata.artist.clone(),
        album: metadata.album.clone(),
        art_url: metadata.art_url.clone(),
        duration_secs: metadata.duration_secs,
        url: if metadata.url.is_empty() {
            None
        } else {
            Some(metadata.url.clone())
        },
        album_artist: metadata.album_artist.clone(),
        track_number: metadata.track_number,
        disc_number: metadata.disc_number,
        content_created: metadata.content_created.clone(),
        user_rating: metadata.user_rating,
    });
    state
        .discord
        .send(crate::discord::DiscordCommand::SetMetadata {
            title: metadata.title,
            artist: metadata.artist,
            album: metadata.album,
            art_url: metadata.art_url,
            duration_secs: metadata.duration_secs,
            url: metadata.url,
            quality_text: metadata.quality_text,
        });
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
#[allow(unused_variables)]
pub fn update_mpris_playback_status(
    state: State<'_, AppState>,
    is_playing: bool,
    position_secs: Option<f64>,
) -> Result<(), SoneError> {
    #[cfg(target_os = "linux")]
    state
        .mpris
        .send(crate::mpris::MprisCommand::SetPlaybackStatus { is_playing });
    state
        .discord
        .send(crate::discord::DiscordCommand::SetPlaying {
            is_playing,
            position_secs: position_secs.unwrap_or(0.0),
        });
    Ok(())
}

#[tauri::command]
#[allow(unused_variables)]
pub fn update_mpris_shuffle(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), SoneError> {
    #[cfg(target_os = "linux")]
    state
        .mpris
        .send(crate::mpris::MprisCommand::SetShuffle { enabled });
    Ok(())
}

#[tauri::command]
#[allow(unused_variables)]
pub fn update_mpris_fullscreen(
    state: State<'_, AppState>,
    fullscreen: bool,
) -> Result<(), SoneError> {
    #[cfg(target_os = "linux")]
    state
        .mpris
        .send(crate::mpris::MprisCommand::SetFullscreen { fullscreen });
    Ok(())
}

#[tauri::command]
#[allow(unused_variables)]
pub fn update_mpris_loop_status(
    state: State<'_, AppState>,
    mode: u8,
) -> Result<(), SoneError> {
    #[cfg(target_os = "linux")]
    state
        .mpris
        .send(crate::mpris::MprisCommand::SetLoopStatus { mode });
    Ok(())
}

/// Percent-encode a track title for use as a URL path segment. The receiver
/// displays the hex-decoded push URL as its now-playing title, so keep it
/// human-readable: alphanumerics and `-_.()` untouched, everything else
/// percent-encoded.
fn encode_display_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '(' | ')' => out.push(c),
            ' ' => out.push_str("%20"),
            _ => {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).as_bytes() {
                    out.push_str(&format!("%{:02X}", b));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::encode_display_name;
    use super::quality_tiers;
    use crate::SoneError;

    #[test]
    fn ceiling_max_with_secret_is_full_cascade() {
        assert_eq!(
            quality_tiers("HI_RES_LOSSLESS", true),
            vec!["HI_RES_LOSSLESS", "HI_RES", "LOSSLESS", "HIGH"]
        );
    }

    #[test]
    fn ceiling_max_without_secret_drops_hires() {
        // Reproduces the legacy no-secret branch exactly.
        assert_eq!(quality_tiers("HI_RES_LOSSLESS", false), vec!["LOSSLESS", "HIGH"]);
    }

    #[test]
    fn ceiling_lossless_caps_below_hires() {
        assert_eq!(quality_tiers("LOSSLESS", true), vec!["LOSSLESS", "HIGH"]);
        assert_eq!(quality_tiers("LOSSLESS", false), vec!["LOSSLESS", "HIGH"]);
    }

    #[test]
    fn ceiling_high_is_only_high() {
        assert_eq!(quality_tiers("HIGH", true), vec!["HIGH"]);
        assert_eq!(quality_tiers("HIGH", false), vec!["HIGH"]);
    }

    #[test]
    fn unknown_ceiling_falls_back_to_max() {
        assert_eq!(
            quality_tiers("GARBAGE", true),
            vec!["HI_RES_LOSSLESS", "HI_RES", "LOSSLESS", "HIGH"]
        );
    }

    #[test]
    fn always_includes_high_so_never_empty() {
        for ceiling in ["HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "GARBAGE"] {
            for has_secret in [true, false] {
                let tiers = quality_tiers(ceiling, has_secret);
                assert!(tiers.contains(&"HIGH"), "ceiling={ceiling} secret={has_secret}");
            }
        }
    }

    #[test]
    fn terminal_and_rate_limited_errors_are_classified() {
        let rl = SoneError::Api {
            status: 429,
            body: String::new(),
        };
        assert!(rl.is_rate_limited());
        assert!(!rl.is_terminal_unplayable());

        let missing = SoneError::Api {
            status: 404,
            body: String::new(),
        };
        assert!(missing.is_terminal_unplayable());
        assert!(!missing.is_rate_limited());

        let gone = SoneError::Api {
            status: 410,
            body: String::new(),
        };
        assert!(gone.is_terminal_unplayable());
        assert!(!gone.is_rate_limited());

        let blocked = SoneError::Api {
            status: 451,
            body: String::new(),
        };
        assert!(blocked.is_terminal_unplayable());
        assert!(!blocked.is_rate_limited());

        let asset = SoneError::Api {
            status: 401,
            body: r#"{"status":401,"subStatus":4005}"#.into(),
        };
        assert!(asset.is_terminal_unplayable());

        let expired = SoneError::Api {
            status: 401,
            body: r#"{"status":401,"subStatus":11003}"#.into(),
        };
        assert!(!expired.is_terminal_unplayable());

        let bare_401 = SoneError::Api {
            status: 401,
            body: String::new(),
        };
        assert!(!bare_401.is_terminal_unplayable());

        let server = SoneError::Api {
            status: 500,
            body: String::new(),
        };
        assert!(!server.is_rate_limited());
        assert!(!server.is_terminal_unplayable());
    }
}

#[cfg(test)]
mod proxy_message_tests {
    use super::*;
    use crate::proxy::HostCaps;

    fn enabled() -> crate::ProxySettings {
        crate::ProxySettings {
            enabled: true,
            proxy_type: crate::ProxyType::Http,
            host: "proxy.example".into(),
            port: 3128,
            username: None,
            password: None,
        }
    }

    #[test]
    fn a_refused_tier_is_named_as_a_proxy_problem() {
        let mut caps = HostCaps::assume_all_present();
        caps.has_dashdemux = false;
        let err = explain_block(&enabled(), &caps, true)
            .expect_err("dash is refused without the legacy demuxer");
        assert!(matches!(err, SoneError::ProxyBlocked { .. }));
        assert!(explain_block(&enabled(), &caps, false).is_ok());
    }

    #[test]
    fn settings_that_form_no_plan_are_refused_not_waved_through() {
        let mut bad = enabled();
        bad.port = 0;
        assert!(matches!(
            explain_block(&bad, &HostCaps::assume_all_present(), false),
            Err(SoneError::ProxyBlocked { .. })
        ));
    }

    /// `port = 0` is what makes this test able to fail. Every other field here
    /// routes `Ok` with the flag *on* as well, so without it the assertion
    /// holds whether or not `enabled` is honoured at all. `plan()` returns
    /// `Ok(Direct)` on the `!enabled` early return, which sits above the
    /// `port == 0` check — so these settings pass only while the flag is
    /// genuinely read, and `settings_that_form_no_plan_are_refused_not_waved_through`
    /// above proves the same port reds once it is on.
    #[test]
    fn the_check_is_inert_when_the_proxy_is_off() {
        let mut off = enabled();
        off.enabled = false;
        off.port = 0;
        for is_dash in [true, false] {
            assert!(explain_block(&off, &HostCaps::assume_all_present(), is_dash).is_ok());
        }
    }
}
