use ksni::menu::{MenuItem, StandardItem};
use ksni::TrayMethods;
use tauri::{Emitter, Manager};

/// Wrapper around ksni::Handle for tooltip updates.
/// Stored in Tauri managed state via `app.manage()`.
pub struct TrayHandle(ksni::Handle<SoneTray>);

impl TrayHandle {
    pub async fn update_tooltip(&self, text: String) {
        self.0
            .update(move |tray| {
                tray.tooltip = text;
            })
            .await;
    }
}

struct SoneTray {
    app_handle: tauri::AppHandle,
    tooltip: String,
    icon: ksni::Icon,
}

impl std::fmt::Debug for SoneTray {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SoneTray")
            .field("tooltip", &self.tooltip)
            .finish()
    }
}

/// Convert RGBA8 pixel data to ARGB32 in network byte order (big-endian),
/// as required by the StatusNotifierItem D-Bus protocol.
fn rgba_to_argb(rgba: &[u8]) -> Vec<u8> {
    let mut argb = Vec::with_capacity(rgba.len());
    for pixel in rgba.chunks_exact(4) {
        argb.push(pixel[3]); // A
        argb.push(pixel[0]); // R
        argb.push(pixel[1]); // G
        argb.push(pixel[2]); // B
    }
    argb
}

fn restore_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();

        // Wayland GTK CSD workaround: after hide()+show(), GTK client-side
        // decoration hit-test regions go stale — buttons render but ignore
        // pointer events.  Toggling decorations forces GTK to recalculate.
        //
        // Skip on KDE (KWin uses server-side decorations — the rapid toggle
        // corrupts KWin's own button regions instead of helping).
        if std::env::var("WAYLAND_DISPLAY").is_ok() {
            let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
            let is_kde = desktop.to_ascii_uppercase().contains("KDE");
            if !is_kde {
                let state = app.state::<crate::AppState>();
                let wants = state
                    .decorations
                    .load(std::sync::atomic::Ordering::Relaxed);
                let _ = window.set_decorations(!wants);
                let _ = window.set_decorations(wants);
            }
        }
    }
}

impl ksni::Tray for SoneTray {
    fn id(&self) -> String {
        "sone".into()
    }

    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        vec![self.icon.clone()]
    }

    fn title(&self) -> String {
        self.tooltip.clone()
    }

    fn tool_tip(&self) -> ksni::ToolTip {
        ksni::ToolTip {
            title: self.tooltip.clone(),
            description: String::new(),
            icon_name: String::new(),
            icon_pixmap: Vec::new(),
        }
    }

    fn activate(&mut self, _x: i32, _y: i32) {
        restore_window(&self.app_handle);
    }

    fn menu(&self) -> Vec<MenuItem<Self>> {
        vec![
            StandardItem {
                label: "Show".into(),
                activate: Box::new(|this: &mut Self| {
                    restore_window(&this.app_handle);
                }),
                ..Default::default()
            }
            .into(),
            MenuItem::Separator,
            StandardItem {
                label: "Play / Pause".into(),
                activate: Box::new(|this: &mut Self| {
                    this.app_handle.emit("tray:toggle-play", ()).ok();
                }),
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: "Next Track".into(),
                activate: Box::new(|this: &mut Self| {
                    this.app_handle.emit("tray:next-track", ()).ok();
                }),
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: "Previous Track".into(),
                activate: Box::new(|this: &mut Self| {
                    this.app_handle.emit("tray:prev-track", ()).ok();
                }),
                ..Default::default()
            }
            .into(),
            MenuItem::Separator,
            StandardItem {
                label: "Quit".into(),
                activate: Box::new(|this: &mut Self| {
                    this.app_handle.exit(0);
                }),
                ..Default::default()
            }
            .into(),
        ]
    }
}

/// Spawn the ksni tray on the tokio runtime. Non-blocking — registers the
/// tray handle in Tauri state once the D-Bus connection is established.
/// If it fails, logs a warning and disables minimize-to-tray.
pub fn setup(app: &tauri::App) {
    let icon_bytes = include_bytes!("../icons/icon.png");
    let icon = match image::load_from_memory(icon_bytes) {
        Ok(img) => {
            let rgba = img.to_rgba8();
            let (w, h) = rgba.dimensions();
            ksni::Icon {
                width: w as i32,
                height: h as i32,
                data: rgba_to_argb(rgba.as_raw()),
            }
        }
        Err(e) => {
            log::warn!("Failed to decode tray icon: {e}");
            return;
        }
    };

    let tray = SoneTray {
        app_handle: app.handle().clone(),
        tooltip: "Sone".into(),
        icon,
    };

    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        // In Flatpak/Snap sandbox, ksni can't own a well-known D-Bus name
        // (would need --own-name with a dynamic PID-based name).
        // disable_dbus_name makes it register via the unique connection name instead.
        let is_sandboxed =
            std::env::var("FLATPAK_ID").is_ok() || std::env::var("SNAP").is_ok();
        match tray.disable_dbus_name(is_sandboxed).spawn().await {
            Ok(handle) => {
                app_handle.manage(TrayHandle(handle));
                log::info!("ksni tray icon registered");
            }
            Err(e) => {
                log::warn!("Failed to create ksni tray: {e}");
                let state = app_handle.state::<crate::AppState>();
                state
                    .minimize_to_tray
                    .store(false, std::sync::atomic::Ordering::Relaxed);
            }
        }
    });
}
