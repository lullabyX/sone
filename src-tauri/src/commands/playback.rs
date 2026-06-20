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

#[tauri::command(rename_all = "camelCase")]
pub async fn play_tidal_track(
    state: State<'_, AppState>,
    track_id: u64,
    use_track_gain: bool,
) -> Result<StreamInfo, SoneError> {
    let (stream_info, uri, norm_gain, rg, peak, _is_dash) =
        resolve_play_uri(state.inner(), track_id, use_track_gain).await?;

    // Store selected values for live toggle
    state.last_replay_gain.store(rg.to_bits(), Ordering::Relaxed);
    state
        .last_peak_amplitude
        .store(peak.to_bits(), Ordering::Relaxed);

    // Apply normalization gain BEFORE play_url so the pipeline builds with
    // the correct current_norm_gain — prevents volume spike on track start.
    let player = state.audio_player.clone();
    tokio::task::spawn_blocking(move || {
        player.set_normalization_gain(norm_gain)?;
        player.play_url(&uri)
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

#[tauri::command(rename_all = "camelCase")]
pub async fn set_next_track(
    state: State<'_, AppState>,
    track_id: u64,
    qid: String,
    use_track_gain: bool,
) -> Result<StreamInfo, SoneError> {
    let (info, uri, gain, rg, peak, is_dash) =
        resolve_play_uri(state.inner(), track_id, use_track_gain).await?;
    state
        .audio_player
        .set_next_track(uri, gain, track_id, qid, rg, peak, is_dash)
        .map_err(SoneError::Audio)?;
    Ok(info)
}

#[tauri::command]
pub fn clear_next_track(state: State<'_, AppState>) -> Result<(), SoneError> {
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

/// Tear down playback: stop the audio pipeline, clear the MPRIS/Discord
/// now-playing surfaces, and notify the scrobble manager. Shared by the
/// `stop_track` command and `logout`.
pub(crate) async fn stop_playback(state: &AppState) -> Result<(), SoneError> {
    let result = state.audio_player.stop().map_err(SoneError::Audio);
    #[cfg(target_os = "linux")]
    state.mpris.send(crate::mpris::MprisCommand::Stop);
    state.discord.send(crate::discord::DiscordCommand::Stop);
    state.scrobble_manager.on_track_stopped().await;
    result
}

#[tauri::command]
pub async fn stop_track(state: State<'_, AppState>) -> Result<(), SoneError> {
    log::debug!("[stop_track]");
    stop_playback(state.inner()).await
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

#[cfg(test)]
mod tests {
    use super::quality_tiers;

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
}
