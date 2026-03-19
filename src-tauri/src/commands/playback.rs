use serde::Deserialize;
use std::sync::atomic::Ordering;
use tauri::State;

use crate::tidal_api::StreamInfo;
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

#[tauri::command(rename_all = "camelCase")]
pub async fn play_tidal_track(
    state: State<'_, AppState>,
    track_id: u64,
    use_track_gain: bool,
) -> Result<StreamInfo, SoneError> {
    // Try quality tiers from highest to lowest.
    // Without client_secret, skip Hi-Res (those credentials typically return
    // encrypted DASH streams that require Widevine). With a secret, the
    // confidential PKCE credentials may return unencrypted Hi-Res BTS streams.
    let stream_info = {
        let mut client = state.tidal_client.lock().await;
        let has_secret = !client.client_secret.is_empty();

        if has_secret {
            match client.get_stream_url(track_id, "HI_RES_LOSSLESS").await {
                Ok(info) => info,
                Err(e) if e.is_network() => return Err(e),
                Err(_) => match client.get_stream_url(track_id, "HI_RES").await {
                    Ok(info) => info,
                    Err(e) if e.is_network() => return Err(e),
                    Err(_) => match client.get_stream_url(track_id, "LOSSLESS").await {
                        Ok(info) => info,
                        Err(e) if e.is_network() => return Err(e),
                        Err(_) => client.get_stream_url(track_id, "HIGH").await?,
                    },
                },
            }
        } else {
            match client.get_stream_url(track_id, "LOSSLESS").await {
                Ok(info) => info,
                Err(e) if e.is_network() => return Err(e),
                Err(_) => client.get_stream_url(track_id, "HIGH").await?,
            }
        }
    };

    log::debug!(
        "[play_tidal_track]: track_id={} — quality={:?}, bitDepth={:?}, sampleRate={:?}, codec={:?}, dash={}",
        track_id, stream_info.audio_quality, stream_info.bit_depth, stream_info.sample_rate,
        stream_info.codec, stream_info.manifest.is_some()
    );

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

    // Store selected values for live toggle
    state
        .last_replay_gain
        .store(selected_rg.unwrap_or(f64::NAN).to_bits(), Ordering::Relaxed);
    state.last_peak_amplitude.store(
        selected_peak.unwrap_or(f64::NAN).to_bits(),
        Ordering::Relaxed,
    );

    // Apply normalization gain BEFORE play_url so the pipeline builds with
    // the correct current_norm_gain — prevents volume spike on track start.
    let norm_gain = if state.volume_normalization.load(Ordering::Relaxed) {
        compute_norm_gain(selected_rg, selected_peak)
    } else {
        1.0
    };
    log::debug!(
        "[play_tidal_track]: normalization gain={:.3} (use_track_gain={}, rg={:?}, peak={:?})",
        norm_gain,
        use_track_gain,
        selected_rg,
        selected_peak
    );

    let player = state.audio_player.clone();
    let uri_clone = uri.clone();
    tokio::task::spawn_blocking(move || {
        player.set_normalization_gain(norm_gain)?;
        player.play_url(&uri_clone)
    })
        .await
        .map_err(|e| SoneError::Audio(e.to_string()))?
        .map_err(SoneError::Audio)?;

    // Save last played track
    if let Some(mut settings) = state.load_settings() {
        settings.last_track_id = Some(track_id);
        state.save_settings(&settings).ok();
    }

    Ok(stream_info)
}

#[tauri::command]
pub async fn pause_track(state: State<'_, AppState>) -> Result<(), SoneError> {
    log::debug!("[pause_track]");
    let result = state.audio_player.pause().map_err(SoneError::Audio);
    state.scrobble_manager.on_pause().await;
    result
}

#[tauri::command]
pub async fn resume_track(state: State<'_, AppState>) -> Result<(), SoneError> {
    log::debug!("[resume_track]");
    let result = state.audio_player.resume().map_err(SoneError::Audio);
    state.scrobble_manager.on_resume().await;
    result
}

#[tauri::command]
pub async fn stop_track(state: State<'_, AppState>) -> Result<(), SoneError> {
    log::debug!("[stop_track]");
    let result = state.audio_player.stop().map_err(SoneError::Audio);
    #[cfg(target_os = "linux")]
    state.mpris.send(crate::mpris::MprisCommand::Stop);
    state.discord.send(crate::discord::DiscordCommand::Stop);
    state.scrobble_manager.on_track_stopped().await;
    result
}

#[tauri::command]
pub fn set_volume(state: State<'_, AppState>, level: f32) -> Result<(), SoneError> {
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

#[tauri::command]
pub fn get_playback_position(state: State<'_, AppState>) -> Result<f32, SoneError> {
    state.audio_player.get_position().map_err(SoneError::Audio)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn seek_track(state: State<'_, AppState>, position_secs: f32) -> Result<(), SoneError> {
    log::debug!("[seek_track]: position_secs={:.1}", position_secs);
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
    state.scrobble_manager.on_seek().await;
    result
}

#[tauri::command]
pub fn is_track_finished(state: State<'_, AppState>) -> Result<bool, SoneError> {
    state.audio_player.is_finished().map_err(SoneError::Audio)
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
