use std::sync::atomic::Ordering;
use tauri::State;

use crate::AppState;
use crate::SoneError;
use crate::tidal_api::StreamInfo;

#[tauri::command(rename_all = "camelCase")]
pub async fn play_tidal_track(state: State<'_, AppState>, track_id: u64) -> Result<StreamInfo, SoneError> {
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
                Err(_) => match client.get_stream_url(track_id, "HI_RES").await {
                    Ok(info) => info,
                    Err(_) => match client.get_stream_url(track_id, "LOSSLESS").await {
                        Ok(info) => info,
                        Err(_) => client.get_stream_url(track_id, "HIGH").await?,
                    }
                }
            }
        } else {
            match client.get_stream_url(track_id, "LOSSLESS").await {
                Ok(info) => info,
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

    state.audio_player.play_url(&uri).map_err(SoneError::Audio)?;

    // Apply normalization gain if enabled
    let norm_gain = if state.volume_normalization.load(Ordering::Relaxed) {
        if let Some(rg) = stream_info.album_replay_gain {
            let linear = 10.0_f64.powf(rg / 20.0);
            linear.min(1.0) // cap at 0dB
        } else {
            1.0
        }
    } else {
        1.0
    };
    log::debug!("[play_tidal_track]: normalization gain={:.3} (albumReplayGain={:?})", norm_gain, stream_info.album_replay_gain);
    state.audio_player.set_normalization_gain(norm_gain).map_err(SoneError::Audio)?;

    // Save last played track
    if let Some(mut settings) = state.load_settings() {
        settings.last_track_id = Some(track_id);
        state.save_settings(&settings).ok();
    }

    Ok(stream_info)
}

#[tauri::command]
pub fn pause_track(state: State<'_, AppState>) -> Result<(), SoneError> {
    log::debug!("[pause_track]");
    state.audio_player.pause().map_err(SoneError::Audio)
}

#[tauri::command]
pub fn resume_track(state: State<'_, AppState>) -> Result<(), SoneError> {
    log::debug!("[resume_track]");
    state.audio_player.resume().map_err(SoneError::Audio)
}

#[tauri::command]
pub fn stop_track(state: State<'_, AppState>) -> Result<(), SoneError> {
    log::debug!("[stop_track]");
    state.audio_player.stop().map_err(SoneError::Audio)
}

#[tauri::command]
pub fn set_volume(state: State<'_, AppState>, level: f32) -> Result<(), SoneError> {
    state.audio_player.set_volume(level).map_err(SoneError::Audio)?;

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
pub fn seek_track(state: State<'_, AppState>, position_secs: f32) -> Result<(), SoneError> {
    log::debug!("[seek_track]: position_secs={:.1}", position_secs);
    state.audio_player.seek(position_secs).map_err(SoneError::Audio)
}

#[tauri::command]
pub fn is_track_finished(state: State<'_, AppState>) -> Result<bool, SoneError> {
    state.audio_player.is_finished().map_err(SoneError::Audio)
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_playback_queue(state: State<'_, AppState>, snapshot_json: String) -> Result<(), SoneError> {
    state.write_state_file("queue.json", &snapshot_json)?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn load_playback_queue(state: State<'_, AppState>) -> Result<Option<String>, SoneError> {
    Ok(state.read_state_file("queue.json"))
}
