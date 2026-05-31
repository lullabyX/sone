//! Cross-display-server idle/screen-blanking inhibition.
//!
//! Probes the active display server and runs every applicable layer additively:
//! Wayland native (zwp_idle_inhibit), X11 native (screensaver+DPMS), D-Bus
//! (ScreenSaver/GNOME/login1), and the XDG portal as a last-resort fallback.

mod dbus;
mod wayland;
mod x11;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayServer {
    Wayland,
    X11,
    Unknown,
}

impl DisplayServer {
    /// Detect from the environment. Wayland wins if WAYLAND_DISPLAY is set
    /// (apps can have both set under Xwayland).
    pub fn detect() -> Self {
        Self::detect_from(
            std::env::var_os("WAYLAND_DISPLAY").is_some(),
            std::env::var_os("DISPLAY").is_some(),
        )
    }

    fn detect_from(wayland: bool, x11: bool) -> Self {
        if wayland {
            DisplayServer::Wayland
        } else if x11 {
            DisplayServer::X11
        } else {
            DisplayServer::Unknown
        }
    }
}

pub struct IdleInhibitor {
    active: bool,
    dbus: dbus::DbusInhibitor,
    x11: Option<x11::X11Inhibitor>,
    wayland: Option<wayland::WaylandInhibitor>,
}

impl IdleInhibitor {
    pub fn new() -> Self {
        Self {
            active: false,
            dbus: dbus::DbusInhibitor::new(),
            x11: None,
            wayland: None,
        }
    }

    /// Inhibit. `window` is needed by the Wayland layer to reach the GDK surface.
    pub async fn inhibit(&mut self, _window: &tauri::WebviewWindow) {
        // filled in Task 6
    }

    pub async fn uninhibit(&mut self) {
        // filled in Task 6
    }
}
