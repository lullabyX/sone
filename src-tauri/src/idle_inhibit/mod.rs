//! Keeps the computer awake (sleep lock) and the screen on (screen lock), each
//! held separately.
//!
//! Screen: every applicable layer additively — Wayland native
//! (zwp_idle_inhibit), X11 native (screensaver+DPMS), D-Bus
//! (ScreenSaver/GNOME), and the XDG portal as a last-resort fallback.

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

/// Drops calls that finish after a newer one (the frontend sends one per state
/// change, and they can land out of order).
#[derive(Default)]
struct LatestOnly(u64);

impl LatestOnly {
    fn accept(&mut self, seq: u64) -> bool {
        if seq <= self.0 {
            return false;
        }
        self.0 = seq;
        true
    }
}

/// Two independent locks: `sleep` keeps the computer from suspending, `screen`
/// keeps the display from blanking or locking.
pub struct IdleInhibitor {
    latest: LatestOnly,
    sleep: bool,
    screen: bool,
    dbus: dbus::DbusInhibitor,
    x11: Option<x11::X11Inhibitor>,
    wayland: Option<wayland::WaylandInhibitor>,
}

impl IdleInhibitor {
    pub fn new() -> Self {
        Self {
            latest: LatestOnly::default(),
            sleep: false,
            screen: false,
            dbus: dbus::DbusInhibitor::new(),
            x11: None,
            wayland: None,
        }
    }

    pub async fn set(
        &mut self,
        seq: u64,
        sleep: bool,
        screen: bool,
        window: &tauri::WebviewWindow,
    ) {
        if !self.latest.accept(seq) {
            return;
        }
        self.set_sleep(sleep).await;
        if screen {
            self.hold_screen(window).await;
        } else {
            self.release_screen().await;
        }
    }

    async fn set_sleep(&mut self, on: bool) {
        if on == self.sleep {
            return;
        }
        self.sleep = on;
        if on {
            self.dbus.hold_sleep().await;
        } else {
            self.dbus.release_sleep().await;
        }
    }

    /// Runs every applicable layer for the detected display server — no
    /// short-circuit.
    async fn hold_screen(&mut self, window: &tauri::WebviewWindow) {
        if self.screen {
            return;
        }
        self.screen = true;

        let server = DisplayServer::detect();
        log::info!("screen inhibit requested (display server: {server:?})");

        match server {
            DisplayServer::Wayland => {
                self.wayland = wayland::WaylandInhibitor::start(window);
            }
            DisplayServer::X11 => {
                self.x11 = x11::X11Inhibitor::start();
            }
            DisplayServer::Unknown => {}
        }

        let dbus_screen = self.dbus.hold_screen().await;

        let native_screen = self.wayland.is_some() || self.x11.is_some();
        if !native_screen && !dbus_screen {
            log::warn!("no native/D-Bus screen inhibition succeeded; trying portal");
            self.dbus.hold_screen_portal().await;
        }
    }

    async fn release_screen(&mut self) {
        if !self.screen {
            return;
        }
        self.screen = false;
        if let Some(mut x) = self.x11.take() {
            x.stop();
        }
        if let Some(w) = self.wayland.take() {
            w.stop();
        }
        self.dbus.release_screen().await;
        log::info!("screen inhibit released");
    }

    /// Releases both (logout, exit).
    pub async fn uninhibit(&mut self) {
        self.set_sleep(false).await;
        self.release_screen().await;
    }
}

#[cfg(test)]
mod tests {
    use super::{DisplayServer, LatestOnly};

    #[test]
    fn wayland_wins_when_both_set() {
        assert_eq!(DisplayServer::detect_from(true, true), DisplayServer::Wayland);
    }

    #[test]
    fn x11_when_only_display_set() {
        assert_eq!(DisplayServer::detect_from(false, true), DisplayServer::X11);
    }

    #[test]
    fn wayland_when_only_wayland_set() {
        assert_eq!(DisplayServer::detect_from(true, false), DisplayServer::Wayland);
    }

    #[test]
    fn unknown_when_neither_set() {
        assert_eq!(DisplayServer::detect_from(false, false), DisplayServer::Unknown);
    }

    #[test]
    fn only_newer_calls_are_applied() {
        let mut l = LatestOnly::default();
        assert!(l.accept(5));
        assert!(!l.accept(5));
        assert!(!l.accept(3));
        assert!(l.accept(6));
    }
}
