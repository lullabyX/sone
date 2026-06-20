use tauri::State;

use crate::tidal_api::Profile;
use crate::AppState;
use crate::SoneError;

#[tauri::command(rename_all = "camelCase")]
pub async fn get_profile(state: State<'_, AppState>, user_id: u64) -> Result<Profile, SoneError> {
    log::debug!("[get_profile]: user_id={}", user_id);
    let mut client = state.tidal_client.lock().await;
    client.get_profile(user_id).await
}
