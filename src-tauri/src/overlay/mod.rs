pub mod server;
pub mod state;

pub use server::{start_server, OverlayHandle};
pub use state::{new_state, OverlayStateRef, OverlayTrackState};

pub(crate) async fn ensure_overlay_started(app: &tauri::AppHandle) {
    use tauri::Manager;

    let state = app.state::<crate::AppState>();
    let mut guard = state.overlay_handle.lock().await;
    if guard.is_some() {
        return;
    }

    let settings = state.load_settings().unwrap_or_default();
    if !settings.overlay_enabled {
        log::info!("Overlay server disabled in settings");
        return;
    }

    let tx = {
        let s = state.overlay_state.read().await;
        s.tx.clone()
    };

    match start_server(state.overlay_state.clone(), tx, &settings.overlay_host, settings.overlay_port).await {
        Ok(handle) => *guard = Some(handle),
        Err(e) => log::error!("Overlay server failed to start: {e}"),
    }
}
