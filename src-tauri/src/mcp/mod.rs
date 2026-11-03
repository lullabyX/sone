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
    // Test-harness override: SONE_MCP_ENABLE=1 turns the MCP server on for
    // this run only, with a fixed token from SONE_MCP_TOKEN so scripts know
    // the URL. The encrypted settings store is deliberately NOT touched:
    // normal runs and packaged builds behave exactly as configured.
    if std::env::var("SONE_MCP_ENABLE").as_deref() == Ok("1") {
        if let Ok(tok) = std::env::var("SONE_MCP_TOKEN") {
            if !tok.is_empty() {
                settings.mcp_enabled = true;
                settings.mcp_token = tok;
                log::info!("MCP server enabled by SONE_MCP_ENABLE test override (token from env)");
            }
        }
    }
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

    // The port can also be overridden for parallel dev/test runs.
    if let Ok(port) = std::env::var("SONE_MCP_PORT") {
        if let Ok(p) = port.parse::<u16>() {
            settings.mcp_port = p;
        }
    }

    match start_server(app.clone(), settings.mcp_port, settings.mcp_token.clone()).await {        Ok(handle) => *guard = Some(handle),
        Err(e) => log::error!("MCP server failed to start: {e}"),
    }
}
