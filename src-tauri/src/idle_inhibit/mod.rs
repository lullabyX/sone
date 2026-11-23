//! Cross-display-server idle/screen-blanking inhibition.
//!
//! Probes the active display server and runs every applicable layer additively:
//! Wayland native (zwp_idle_inhibit), X11 native (screensaver+DPMS), D-Bus
//! (ScreenSaver/GNOME/login1), and the XDG portal as a last-resort fallback.

mod dbus;
mod wayland;
mod x11;

use std::collections::HashSet;

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

/// Who currently wants the screen kept awake; the inhibition is held while
/// any holder remains.
#[derive(Default)]
pub struct IdleHolders(HashSet<String>);

impl IdleHolders {
    /// True when this is the first holder.
    fn add(&mut self, h: &str) -> bool {
        let was_empty = self.0.is_empty();
        self.0.insert(h.to_string());
        was_empty
    }

    /// True when this was the last holder.
    fn remove(&mut self, h: &str) -> bool {
        self.0.remove(h) && self.0.is_empty()
    }

    fn clear(&mut self) {
        self.0.clear();
    }
}

pub struct IdleInhibitor {
    active: bool,
    holders: IdleHolders,
    dbus: dbus::DbusInhibitor,
    x11: Option<x11::X11Inhibitor>,
    wayland: Option<wayland::WaylandInhibitor>,
}

impl IdleInhibitor {
    pub fn new() -> Self {
        Self {
            active: false,
            holders: IdleHolders::default(),
            dbus: dbus::DbusInhibitor::new(),
            x11: None,
            wayland: None,
        }
    }

    /// Inhibit screen blanking + system sleep. Runs every applicable layer for
    /// the detected display server — no short-circuit.
    pub async fn inhibit(&mut self, window: &tauri::WebviewWindow) {
        if self.active {
            return;
        }
        self.active = true;

        let server = DisplayServer::detect();
        log::info!("idle inhibit requested (display server: {server:?})");

        // Layer 1: display-server native.
        match server {
            DisplayServer::Wayland => {
                self.wayland = wayland::WaylandInhibitor::start(window);
            }
            DisplayServer::X11 => {
                self.x11 = x11::X11Inhibitor::start();
            }
            DisplayServer::Unknown => {}
        }

        // Layer 2: D-Bus session (KDE/GNOME screen-off) — always attempt; harmless
        // where unsupported. Returns whether a screen-keeping inhibition landed.
        let dbus_screen = self.dbus.inhibit_screen().await;

        // Layer 3: D-Bus system suspend (logind) — always attempt.
        self.dbus.inhibit_sleep().await;

        // Layer 4: portal fallback — only if NOTHING screen-keeping succeeded.
        let native_screen = self.wayland.is_some() || self.x11.is_some();
        if !native_screen && !dbus_screen {
            log::warn!("no native/D-Bus screen inhibition succeeded; trying portal");
            self.dbus.inhibit_portal().await;
        }
    }

    pub async fn acquire(&mut self, holder: &str, window: &tauri::WebviewWindow) {
        if self.holders.add(holder) {
            self.inhibit(window).await;
        }
    }

    pub async fn release(&mut self, holder: &str) {
        if self.holders.remove(holder) {
            self.uninhibit().await;
        }
    }

    /// Releases for every holder (logout, exit).
    pub async fn uninhibit(&mut self) {
        self.holders.clear();
        if !self.active {
            return;
        }
        self.active = false;

        if let Some(mut x) = self.x11.take() {
            x.stop();
        }
        if let Some(w) = self.wayland.take() {
            w.stop();
        }
        self.dbus.release().await;
        log::info!("idle inhibit released");
    }
}

#[cfg(test)]
mod tests {
    use super::{DisplayServer, IdleHolders};

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
    fn first_holder_starts_and_last_holder_stops() {
        let mut h = IdleHolders::default();
        assert!(h.add("tv"));
        assert!(!h.add("default"));
        assert!(!h.add("tv"));
        assert!(!h.remove("tv"));
        assert!(h.remove("default"));
        assert!(!h.remove("default"));
    }

    #[test]
    fn clear_releases_everyone() {
        let mut h = IdleHolders::default();
        h.add("tv");
        h.add("default");
        h.clear();
        assert!(h.add("tv"));
    }
}
