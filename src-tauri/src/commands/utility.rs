use std::sync::atomic::Ordering;
use tauri::State;

use crate::AppState;
use crate::SoneError;
use crate::cache::{CacheResult, CacheTier};

#[tauri::command]
pub async fn get_image_bytes(state: State<'_, AppState>, url: String) -> Result<Vec<u8>, SoneError> {
    log::debug!("[get_image_bytes]: url={}", url);

    match state.disk_cache.get(&url, CacheTier::Image).await {
        CacheResult::Fresh(bytes) | CacheResult::Stale(bytes) => {
            log::debug!("[get_image_bytes]: cache hit ({} bytes)", bytes.len());
            Ok(bytes)
        }
        CacheResult::Miss => {
            let res = reqwest::get(&url).await?;
            let bytes = res.bytes().await?.to_vec();

            state.disk_cache
                .put(&url, &bytes, CacheTier::Image, &["image"])
                .await
                .ok();
            log::debug!("[get_image_bytes]: fetched and cached {} bytes", bytes.len());

            Ok(bytes)
        }
    }
}

#[tauri::command]
pub async fn get_cache_stats(state: State<'_, AppState>) -> Result<crate::cache::CacheStats, SoneError> {
    Ok(state.disk_cache.stats().await)
}

#[tauri::command]
pub async fn clear_disk_cache(state: State<'_, AppState>) -> Result<(), SoneError> {
    log::info!("[clear_disk_cache]: user-initiated cache clear");
    state.disk_cache.clear().await;
    Ok(())
}

#[tauri::command]
pub fn get_minimize_to_tray(state: State<'_, AppState>) -> bool {
    state.minimize_to_tray.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_minimize_to_tray(state: State<'_, AppState>, enabled: bool) -> Result<(), SoneError> {
    state.minimize_to_tray.store(enabled, Ordering::Relaxed);
    let mut settings = state.load_settings().unwrap_or(crate::Settings {
        auth_tokens: None,
        volume: 1.0,
        last_track_id: None,
        client_id: String::new(),
        client_secret: String::new(),
        minimize_to_tray: false,
        volume_normalization: false,
    });
    settings.minimize_to_tray = enabled;
    state.save_settings(&settings)?;
    Ok(())
}

#[tauri::command]
pub fn get_volume_normalization(state: State<'_, AppState>) -> bool {
    state.volume_normalization.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_volume_normalization(state: State<'_, AppState>, enabled: bool) -> Result<(), SoneError> {
    state.volume_normalization.store(enabled, Ordering::Relaxed);
    let mut settings = state.load_settings().unwrap_or(crate::Settings {
        auth_tokens: None,
        volume: 1.0,
        last_track_id: None,
        client_id: String::new(),
        client_secret: String::new(),
        minimize_to_tray: false,
        volume_normalization: false,
    });
    settings.volume_normalization = enabled;
    state.save_settings(&settings)?;
    Ok(())
}
