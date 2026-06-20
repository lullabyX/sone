pub mod events;
pub mod sanitizer;
pub mod server;
pub mod state_mirror;
pub mod tools;

pub use server::{start_server, McpHandle};
pub use state_mirror::{
    new_state, McpStateRef, NowPlayingSnapshot, QueueTrackSnapshot,
};

/// Start the MCP server if it is enabled in settings and not already running.
/// Holds the `mcp_handle` lock across the whole check→bind→store so that
/// concurrent callers (startup spawn + login restore) cannot both bind the
/// port. No-op if MCP is disabled or a server is already running.
pub(crate) async fn ensure_mcp_started(app: &tauri::AppHandle) {
    use tauri::Manager;

    let state = app.state::<crate::AppState>();
    let mut guard = state.mcp_handle.lock().await;
    if guard.is_some() {
        return;
    }

    let mut settings = state.load_settings().unwrap_or_default();
    if !settings.mcp_enabled {
        log::info!("MCP server disabled in settings");
        return;
    }
    if settings.mcp_token.is_empty() {
        settings.mcp_token = uuid::Uuid::new_v4().simple().to_string();
        if let Err(e) = state.save_settings(&settings) {
            log::warn!("Failed to persist MCP token: {e}");
        }
    }

    match start_server(app.clone(), settings.mcp_port, settings.mcp_token.clone()).await {
        Ok(handle) => *guard = Some(handle),
        Err(e) => log::error!("MCP server failed to start: {e}"),
    }
}
