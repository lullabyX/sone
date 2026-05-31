use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use x11rb::connection::Connection;
use x11rb::protocol::dpms::ConnectionExt as _;
use x11rb::protocol::screensaver::ConnectionExt as _;
use x11rb::protocol::xproto::{ConnectionExt as _, ScreenSaver};

/// X11 native inhibition: MIT-SCREEN-SAVER suspend + DPMS disable, kept alive by
/// holding the connection on a background heartbeat thread that resets the X
/// screensaver every 10s (mpv's approach). Covers XFCE/MATE/bare-WM where the X
/// server itself does the blanking. Does NOT cover KDE/GNOME (they idle-detect
/// via XSync IDLETIME) — those are handled by the D-Bus layer.
pub struct X11Inhibitor {
    stop: Sender<()>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl X11Inhibitor {
    /// Start inhibition. Returns None if X11 is unreachable.
    pub fn start() -> Option<Self> {
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let handle = std::thread::Builder::new()
            .name("sone-x11-idle".into())
            .spawn(move || {
                if let Err(e) = run(stop_rx) {
                    log::warn!("X11 idle inhibitor thread error: {e}");
                }
            })
            .ok()?;
        Some(Self { stop: stop_tx, handle: Some(handle) })
    }

    pub fn stop(&mut self) {
        let _ = self.stop.send(());
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

fn run(stop_rx: Receiver<()>) -> Result<(), Box<dyn std::error::Error>> {
    let (conn, _screen) = x11rb::connect(None)?;

    // MIT-SCREEN-SAVER suspend (arg is u32: 1 = suspend). Also suspends the
    // server DPMS timer on modern servers. Released when the connection drops.
    if conn.screensaver_suspend(1).is_ok() {
        let _ = conn.flush();
    } else {
        log::debug!("screensaver suspend unavailable");
    }

    // DPMS: save prior state, disable if it was enabled. Restore on exit.
    let mut dpms_was_enabled = false;
    let mut saved = (0u16, 0u16, 0u16);
    if let Ok(cookie) = conn.dpms_info() {
        if let Ok(info) = cookie.reply() {
            dpms_was_enabled = info.state;
            if let Ok(tcookie) = conn.dpms_get_timeouts() {
                if let Ok(t) = tcookie.reply() {
                    saved = (t.standby_timeout, t.suspend_timeout, t.off_timeout);
                }
            }
            if dpms_was_enabled {
                let _ = conn.dpms_disable();
                let _ = conn.flush();
                log::info!("X11 DPMS disabled");
            }
        }
    }
    log::info!("X11 screensaver/DPMS inhibition active");

    // Heartbeat: reset the X screensaver every 10s until told to stop.
    loop {
        match stop_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {
                let _ = conn.force_screen_saver(ScreenSaver::RESET);
                let _ = conn.flush();
            }
        }
    }

    // Release: undo suspend + restore DPMS. (Dropping conn alone releases the
    // suspend, but we restore DPMS explicitly since it's global server state.)
    let _ = conn.screensaver_suspend(0);
    if dpms_was_enabled {
        let _ = conn.dpms_enable();
        let _ = conn.dpms_set_timeouts(saved.0, saved.1, saved.2);
    }
    let _ = conn.flush();
    log::info!("X11 screensaver/DPMS inhibition released");
    Ok(())
}
