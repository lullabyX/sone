use tauri::State;

use crate::cache::{CacheResult, CacheTier};
use crate::tidal_api::{StreamInfo, TidalCredit, TidalLyrics};
use crate::AppState;
use crate::SoneError;

#[tauri::command(rename_all = "camelCase")]
pub async fn get_stream_url(
    state: State<'_, AppState>,
    track_id: u64,
    quality: String,
) -> Result<StreamInfo, SoneError> {
    log::debug!(
        "[get_stream_url]: track_id={}, quality={}",
        track_id,
        quality
    );
    let mut client = state.tidal_client.lock().await;
    client.get_stream_url(track_id, &quality).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_playlist_details(
    state: State<'_, AppState>,
    playlist_id: String,
) -> Result<serde_json::Value, SoneError> {
    log::debug!("[get_playlist_details]: playlist_id={}", playlist_id);
    let mut client = state.tidal_client.lock().await;
    client.get_playlist_details(&playlist_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_track(
    state: State<'_, AppState>,
    track_id: u64,
) -> Result<serde_json::Value, SoneError> {
    log::debug!("[get_track]: track_id={}", track_id);
    let mut client = state.tidal_client.lock().await;
    client.get_track(track_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_track_lyrics(
    state: State<'_, AppState>,
    track_id: u64,
) -> Result<TidalLyrics, SoneError> {
    log::debug!("[get_track_lyrics]: track_id={}", track_id);
    let mut client = state.tidal_client.lock().await;
    client.get_track_lyrics(track_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_track_credits(
    state: State<'_, AppState>,
    track_id: u64,
) -> Result<Vec<TidalCredit>, SoneError> {
    log::debug!("[get_track_credits]: track_id={}", track_id);

    let cache_key = format!("credits:{}", track_id);
    match state
        .disk_cache
        .get(&cache_key, CacheTier::StaticMeta)
        .await
    {
        CacheResult::Fresh(bytes) | CacheResult::Stale(bytes) => {
            if let Ok(credits) = serde_json::from_slice(&bytes) {
                return Ok(credits);
            }
        }
        CacheResult::Miss => {}
    }

    let mut client = state.tidal_client.lock().await;
    let credits = client.get_track_credits(track_id).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&credits) {
        state
            .disk_cache
            .put(&cache_key, &json, CacheTier::StaticMeta, &["credits"])
            .await
            .ok();
    }
    Ok(credits)
}

