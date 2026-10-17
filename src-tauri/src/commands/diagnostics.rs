use tauri::State;
use crate::AppState;

/// Renderer-to-log bridge. The packaged webview has no visible console, so a
/// JS error at boot is otherwise silent; the frontend forwards uncaught
/// errors and rejections here for the app log (see tools/cast_drive.py
/// methodology in AGENTS.md 5.3).
#[tauri::command]
pub async fn log_frontend_error(state: State<'_, AppState>, message: String) -> Result<(), ()> {
    let _ = state;
    log::error!("[frontend-error] {}", message.replace('\n', " | "));
    Ok(())
}
