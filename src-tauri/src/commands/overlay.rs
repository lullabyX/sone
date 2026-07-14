use serde::Serialize;
use tauri::State;

use crate::AppState;
use crate::error::SoneError;
use crate::overlay::OverlayTrackState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayConnectionInfo {
    pub enabled: bool,
    pub url: Option<String>,
    pub port: Option<u16>,
    pub host: String,
}

#[tauri::command]
pub async fn overlay_get_connection_info(
    state: State<'_, AppState>,
) -> Result<OverlayConnectionInfo, SoneError> {
    let handle = state.overlay_handle.lock().await;
    let settings_host = state
        .load_settings()
        .map(|s| s.overlay_host)
        .unwrap_or_else(|| "127.0.0.1".to_string());
    Ok(match handle.as_ref() {
        Some(h) => OverlayConnectionInfo {
            enabled: true,
            url: Some(h.url()),
            port: Some(h.port),
            host: h.host.clone(),
        },
        None => OverlayConnectionInfo {
            enabled: false,
            url: None,
            port: None,
            host: settings_host,
        },
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn overlay_publish_state(
    state: State<'_, AppState>,
    track: Option<OverlayTrackState>,
) -> Result<(), SoneError> {
    let mut s = state.overlay_state.write().await;
    s.track = track.clone();

    // Broadcast to all SSE listeners
    if let Some(t) = track {
        let json = serde_json::to_string(&t).unwrap_or_default();
        let _ = s.tx.send(json);
    } else {
        // Send empty state so overlay hides itself
        let empty = serde_json::to_string(&OverlayTrackState::default()).unwrap_or_default();
        let _ = s.tx.send(empty);
    }

    Ok(())
}

/// Helper: restart the overlay server using current settings (if enabled).
async fn restart_if_running(state: &AppState) -> Result<(), SoneError> {
    let mut guard = state.overlay_handle.lock().await;
    if guard.is_none() {
        return Ok(());
    }
    if let Some(handle) = guard.take() {
        handle.cancel.cancel();
    }
    let settings = state.load_settings().unwrap_or_default();
    let tx = {
        let s = state.overlay_state.read().await;
        s.tx.clone()
    };
    let h = crate::overlay::start_server(
        state.overlay_state.clone(),
        tx,
        &settings.overlay_host,
        settings.overlay_port,
    )
    .await
    .map_err(|e| SoneError::Io(e.to_string()))?;
    *guard = Some(h);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn overlay_set_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<OverlayConnectionInfo, SoneError> {
    let mut settings = state.load_settings().unwrap_or_default();
    settings.overlay_enabled = enabled;
    state.save_settings(&settings)?;

    {
        let mut guard = state.overlay_handle.lock().await;
        if let Some(handle) = guard.take() {
            handle.cancel.cancel();
        }
        if enabled {
            let tx = {
                let s = state.overlay_state.read().await;
                s.tx.clone()
            };
            let h = crate::overlay::start_server(
                state.overlay_state.clone(),
                tx,
                &settings.overlay_host,
                settings.overlay_port,
            )
            .await
            .map_err(|e| SoneError::Io(e.to_string()))?;
            *guard = Some(h);
        }
    }

    overlay_get_connection_info(state).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn overlay_set_port(
    state: State<'_, AppState>,
    port: u16,
) -> Result<OverlayConnectionInfo, SoneError> {
    let mut settings = state.load_settings().unwrap_or_default();
    settings.overlay_port = port;
    state.save_settings(&settings)?;
    restart_if_running(&state).await?;
    overlay_get_connection_info(state).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn overlay_set_host(
    state: State<'_, AppState>,
    host: String,
) -> Result<OverlayConnectionInfo, SoneError> {
    // Basic validation: must parse as a valid IP or "0.0.0.0" etc.
    let trimmed = host.trim().to_string();
    if trimmed.is_empty() {
        return Err(SoneError::Io("Host cannot be empty".to_string()));
    }
    // Try parsing as SocketAddr to validate
    let test = format!("{trimmed}:0");
    if test.parse::<std::net::SocketAddr>().is_err() {
        return Err(SoneError::Io(format!("Invalid host address: {trimmed}")));
    }

    let mut settings = state.load_settings().unwrap_or_default();
    settings.overlay_host = trimmed;
    state.save_settings(&settings)?;
    restart_if_running(&state).await?;
    overlay_get_connection_info(state).await
}

/// Receive the full CSS variable block from the frontend (already computed by
/// `themeToCssVars`) and store it so `/overlay/theme.css` serves it, then
/// notify connected overlays via SSE so they hot-reload the stylesheet.
#[tauri::command(rename_all = "camelCase")]
pub async fn overlay_publish_theme(
    state: State<'_, AppState>,
    css: String,
) -> Result<(), SoneError> {
    let mut s = state.overlay_state.write().await;
    s.theme_css = css;
    // Signal all connected overlays to reload theme.css
    let _ = s.theme_tx.send("reload".to_string());
    Ok(())
}
