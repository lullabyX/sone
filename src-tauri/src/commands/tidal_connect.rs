use tauri::State;
use crate::AppState;
use crate::tidal_connect::models::{ConnectDevice, PlaybackCommand};

#[tauri::command]
pub async fn tidal_connect_start_discovery(state: State<'_, AppState>) -> Result<(), String> {
    let mut engine = state.tidal_connect.discovery.write().await;
    engine.start().await
}

#[tauri::command]
pub async fn tidal_connect_stop_discovery(state: State<'_, AppState>) -> Result<(), String> {
    let mut engine = state.tidal_connect.discovery.write().await;
    engine.stop().await
}

#[tauri::command]
pub async fn tidal_connect_get_available_devices(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectDevice>, String> {
    let engine = state.tidal_connect.discovery.read().await;
    Ok(engine.get_devices().await)
}

#[tauri::command]
pub async fn tidal_connect_select_device(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    device_id: String,
) -> Result<(), String> {
    if device_id == "local" {
        crate::tidal_connect::teardown_cast(&state.tidal_connect).await;
        state.tidal_connect.client.set_cast_active(false);
        state.tidal_connect.client.disconnect().await;
        let mut active = state.tidal_connect.active_device.write().await;
        *active = None;
        return Ok(());
    }

    let engine = state.tidal_connect.discovery.read().await;
    let devices = engine.get_devices().await;
    let selected = devices.into_iter().find(|d| d.id == device_id);

    match selected {
        Some(dev) => {
            let dev_for_notify = dev.clone();
            let target_host = dev
                .addresses
                .iter()
                .find(|a| !a.contains(':')) // Prefer IPv4
                .unwrap_or(&dev.host);

            state
                .tidal_connect
                .client
                .connect(&dev.id, target_host, dev.port, Some(app.clone()))
                .await?;

            let _ = state.audio_player.stop();

            let mut active = state.tidal_connect.active_device.write().await;
            *active = Some(dev);
            drop(active);

            // Notify the renderer so activeDeviceAtom mirrors backend-driven
            // selection (SONE_CAST_DEVICE autoselect, or any future backend
            // path). Without this the frontend still holds localDevice and
            // routes set_volume to the local DAC instead of the receiver.
            {
                use tauri::Emitter;
                let _ = app.emit("tidal-connect:device-selected", &dev_for_notify);
            }

            // The 1 s poller drives push-URL cast events (track end, knob
            // volume changes via LinkPlay's own status). Cheap while idle.
            // Takes ownership of app; the emit above must happen first.
            crate::tidal_connect::ensure_cast_poller(app, &state.tidal_connect).await;

            Ok(())
        }
        None => Err("Device not found".to_string()),
    }
}

#[tauri::command]
pub async fn tidal_connect_get_active_device(
    state: State<'_, AppState>,
) -> Result<Option<ConnectDevice>, String> {
    // Predicates are read BEFORE the write lock: holding active_device.write()
    // across `is_connected()` (session RwLock) and the cast_host read made this
    // the one command a wedged client could use to stall every renderer
    // refresh behind a foreign lock, while the lock carries no await of its
    // own once the predicates are known.
    let connected = state.tidal_connect.client.is_connected().await;
    let cast_alive = state.tidal_connect.cast_host.read().await.is_some();
    let mut active = state.tidal_connect.active_device.write().await;
    // With an active push-URL cast the TIDAL Connect WebSocket session is
    // irrelevant to playback; only drop the selection when neither session
    // nor cast exists.
    if active.is_some() && !connected && !cast_alive {
        *active = None;
    }
    Ok(active.clone())
}

#[tauri::command]
pub async fn tidal_connect_send_command(
    state: State<'_, AppState>,
    command: PlaybackCommand,
) -> Result<(), String> {
    let active = state.tidal_connect.active_device.read().await;
    match &*active {
        Some(dev) => {
            log::info!("Sending command {:?} to remote device {}", command, dev.name);
            if !state.tidal_connect.client.is_connected().await {
                log::info!("TIDAL Connect session inactive, reconnecting to {}...", dev.name);
                let target_host = dev
                    .addresses
                    .iter()
                    .find(|a| !a.contains(':'))
                    .unwrap_or(&dev.host);
                let _ = state.tidal_connect.client.connect(&dev.id, target_host, dev.port, None).await;
            }
            match command {
                PlaybackCommand::Play => state.tidal_connect.client.play().await,
                PlaybackCommand::Pause => state.tidal_connect.client.pause().await,
                PlaybackCommand::Stop => state.tidal_connect.client.stop().await,
                PlaybackCommand::Next | PlaybackCommand::Previous => Ok(()),
                PlaybackCommand::Seek { position_ms } => {
                    state.tidal_connect.client.seek(position_ms as f64 / 1000.0).await
                }
                PlaybackCommand::SetVolume { volume } => {
                    state.tidal_connect.client.set_volume(volume).await
                }
                PlaybackCommand::SetMute { mute } => {
                    state.tidal_connect.client.set_mute(mute).await
                }
            }
        }
        None => Err("No active remote device selected".to_string()),
    }
}
