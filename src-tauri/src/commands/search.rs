use tauri::State;

use crate::tidal_api::{SuggestionsResponse, TidalSearchResults};
use crate::AppState;
use crate::SoneError;

#[tauri::command(rename_all = "camelCase")]
pub async fn search_tidal(
    state: State<'_, AppState>,
    query: String,
    limit: u32,
) -> Result<TidalSearchResults, SoneError> {
    log::debug!("[search_tidal]: query=\"{}\", limit={}", query, limit);
    let mut client = state.tidal_client.lock().await;
    client.search(&query, limit).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_suggestions(
    state: State<'_, AppState>,
    query: String,
    limit: u32,
) -> Result<SuggestionsResponse, SoneError> {
    log::debug!("[get_suggestions]: query=\"{}\", limit={}", query, limit);
    let mut client = state.tidal_client.lock().await;
    Ok(client.get_suggestions(&query, limit).await)
}
