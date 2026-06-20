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

#[tauri::command(rename_all = "camelCase")]
pub async fn mcp_set_enabled(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    enabled: bool,
) -> Result<McpConnectionInfo, SoneError> {
    let mut settings = state.load_settings().unwrap_or_default();

    settings.mcp_enabled = enabled;

    if enabled && settings.mcp_token.is_empty() {
        settings.mcp_token = uuid::Uuid::new_v4().simple().to_string();
    }

    state.save_settings(&settings)?;

    {
        // Hold the guard across cancel→bind→store so this cannot race the
        // startup spawn (or a concurrent regenerate) into a double bind.
        let mut guard = state.mcp_handle.lock().await;
        if let Some(handle) = guard.take() {
            handle.cancel.cancel();
        }
        if enabled {
            let h = crate::mcp::start_server(
                app_handle.clone(),
                settings.mcp_port,
                settings.mcp_token.clone(),
            )
            .await?;
            *guard = Some(h);
        }
    }

    mcp_get_connection_info(state).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn mcp_regenerate_token(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<McpConnectionInfo, SoneError> {
    let mut settings = state.load_settings().unwrap_or_default();
    settings.mcp_token = uuid::Uuid::new_v4().simple().to_string();
    state.save_settings(&settings)?;

    {
        let mut guard = state.mcp_handle.lock().await;
        if let Some(handle) = guard.take() {
            handle.cancel.cancel();
        }
        if settings.mcp_enabled {
            let h = crate::mcp::start_server(
                app_handle.clone(),
                settings.mcp_port,
                settings.mcp_token.clone(),
            )
            .await?;
            *guard = Some(h);
        }
    }

    mcp_get_connection_info(state).await
}
