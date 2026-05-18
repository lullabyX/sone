use serde::Serialize;
use tauri::State;

use crate::AppState;
use crate::error::SoneError;
use crate::mcp::{NowPlayingSnapshot, QueueTrackSnapshot};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectionInfo {
    pub enabled: bool,
    pub url: Option<String>,
    pub port: Option<u16>,
}

#[tauri::command]
pub async fn mcp_get_connection_info(
    state: State<'_, AppState>,
) -> Result<McpConnectionInfo, SoneError> {
    let handle = state.mcp_handle.lock().await;
    Ok(match handle.as_ref() {
        Some(h) => McpConnectionInfo {
            enabled: true,
            url: Some(h.url()),
            port: Some(h.port),
        },
        None => McpConnectionInfo {
            enabled: false,
            url: None,
            port: None,
        },
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn mcp_publish_state(
    state: State<'_, AppState>,
    now_playing: Option<NowPlayingSnapshot>,
    queue: Option<Vec<QueueTrackSnapshot>>,
) -> Result<(), SoneError> {
    let mut s = state.mcp_state.write().await;
    if let Some(np) = now_playing {
        s.now_playing = Some(np);
    }
    if let Some(q) = queue {
        s.queue = q;
    }
    Ok(())
}
