//! The window's real fullscreen state. On Linux the window library answers
//! `is_fullscreen()` with the last fullscreen request SONE made, never with
//! what the window manager did, so this reads GDK's window state instead.

use gtk::prelude::*;
use tauri::{Emitter, WebviewWindow};

use crate::SoneError;

/// Sent with `true` / `false` whenever the window enters or leaves fullscreen.
pub const FULLSCREEN_EVENT: &str = "window:fullscreen";

fn gdk_fullscreen(window: &WebviewWindow) -> Option<bool> {
    let gdk_window = window.gtk_window().ok()?.window()?;
    Some(gdk_window.state().contains(gdk::WindowState::FULLSCREEN))
}

/// Emit [`FULLSCREEN_EVENT`] on every fullscreen change. Main thread only.
pub fn watch(window: &WebviewWindow) {
    let Ok(gtk_window) = window.gtk_window() else {
        return;
    };
    let win = window.clone();
    gtk_window.connect_window_state_event(move |_, event| {
        if event.changed_mask().contains(gdk::WindowState::FULLSCREEN) {
            let on = event
                .new_window_state()
                .contains(gdk::WindowState::FULLSCREEN);
            let _ = win.emit(FULLSCREEN_EVENT, on);
        }
        gtk::glib::Propagation::Proceed
    });
}

#[tauri::command]
pub async fn is_window_fullscreen(window: WebviewWindow) -> Result<bool, SoneError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let win = window.clone();
    window.run_on_main_thread(move || {
        let _ = tx.send(gdk_fullscreen(&win));
    })?;
    match rx.await {
        Ok(Some(on)) => Ok(on),
        // Not realized yet: nothing has made it fullscreen.
        _ => Ok(window.is_fullscreen()?),
    }
}
