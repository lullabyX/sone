use tauri::State;

use crate::tidal_api::{ExternalLink, Profile};
use crate::AppState;
use crate::SoneError;

#[tauri::command(rename_all = "camelCase")]
pub async fn get_profile(state: State<'_, AppState>, user_id: u64) -> Result<Profile, SoneError> {
    log::debug!("[get_profile]: user_id={}", user_id);
    let mut client = state.tidal_client.lock().await;
    client.get_profile(user_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn update_profile_meta(
    state: State<'_, AppState>,
    artist_id: u64,
    name: Option<String>,
    handle: Option<String>,
    dry_run: bool,
) -> Result<(), SoneError> {
    log::debug!("[update_profile_meta]: artist_id={}, dry_run={}", artist_id, dry_run);
    let client = state.tidal_client.lock().await;
    client
        .update_artist_meta(artist_id, name.as_deref(), handle.as_deref(), dry_run)
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn update_profile_bio(
    state: State<'_, AppState>,
    bio_id: String,
    text: String,
) -> Result<(), SoneError> {
    log::debug!("[update_profile_bio]: bio_id={}", bio_id);
    let client = state.tidal_client.lock().await;
    client.update_bio(&bio_id, &text).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn update_profile_links(
    state: State<'_, AppState>,
    artist_id: u64,
    links: Vec<ExternalLink>,
) -> Result<(), SoneError> {
    log::debug!("[update_profile_links]: artist_id={}, n={}", artist_id, links.len());
    let client = state.tidal_client.lock().await;
    client.update_external_links(artist_id, links).await
}
