use std::os::fd::OwnedFd;

// ── Proxies ──────────────────────────────────────────────────────────────

#[zbus::proxy(
    interface = "org.freedesktop.ScreenSaver",
    default_service = "org.freedesktop.ScreenSaver",
    default_path = "/org/freedesktop/ScreenSaver"
)]
trait ScreenSaver {
    fn inhibit(&self, application_name: &str, reason: &str) -> zbus::Result<u32>;
    fn un_inhibit(&self, cookie: u32) -> zbus::Result<()>;
}

#[zbus::proxy(
    interface = "org.gnome.SessionManager",
    default_service = "org.gnome.SessionManager",
    default_path = "/org/gnome/SessionManager"
)]
trait GnomeSessionManager {
    // flags: 8 = inhibit idle (screen blanking). xid 0 = no toplevel.
    fn inhibit(&self, app_id: &str, toplevel_xid: u32, reason: &str, flags: u32)
        -> zbus::Result<u32>;
    fn uninhibit(&self, cookie: u32) -> zbus::Result<()>;
}

#[zbus::proxy(
    interface = "org.freedesktop.login1.Manager",
    default_service = "org.freedesktop.login1",
    default_path = "/org/freedesktop/login1"
)]
trait Login1Manager {
    fn inhibit(&self, what: &str, who: &str, why: &str, mode: &str)
        -> zbus::Result<zbus::zvariant::OwnedFd>;
}

#[zbus::proxy(
    interface = "org.freedesktop.portal.Inhibit",
    default_service = "org.freedesktop.portal.Desktop",
    default_path = "/org/freedesktop/portal/desktop"
)]
trait PortalInhibit {
    fn inhibit(
        &self,
        window: &str,
        flags: u32,
        options: std::collections::HashMap<&str, zbus::zvariant::Value<'_>>,
    ) -> zbus::Result<zbus::zvariant::OwnedObjectPath>;
}

// ── DbusInhibitor ────────────────────────────────────────────────────────

/// Holds every D-Bus inhibition. Connections are KEPT ALIVE for the lifetime
/// of the inhibition (dropping a session connection releases ksmserver/GNOME
/// inhibitions immediately; holding the login1 fd holds the sleep inhibition).
pub struct DbusInhibitor {
    screensaver: Option<(zbus::Connection, u32)>,
    gnome: Option<(zbus::Connection, u32)>,
    sleep_fd: Option<OwnedFd>,
    portal_conn: Option<zbus::Connection>,
}

impl DbusInhibitor {
    pub fn new() -> Self {
        Self { screensaver: None, gnome: None, sleep_fd: None, portal_conn: None }
    }

    /// Inhibit screen-off via the session bus. Returns true if at least one
    /// screen-keeping inhibition (ScreenSaver or GNOME) succeeded.
    pub async fn inhibit_screen(&mut self) -> bool {
        let mut any = false;
        if let Ok(conn) = zbus::Connection::session().await {
            if let Ok(proxy) = ScreenSaverProxy::new(&conn).await {
                match proxy.inhibit("sone", "Fullscreen playback").await {
                    Ok(cookie) => {
                        log::info!("ScreenSaver inhibited (cookie={cookie})");
                        self.screensaver = Some((conn.clone(), cookie));
                        any = true;
                    }
                    Err(e) => log::warn!("ScreenSaver inhibit failed: {e}"),
                }
            }
            if let Ok(proxy) = GnomeSessionManagerProxy::new(&conn).await {
                match proxy.inhibit("org.sone.app", 0, "Fullscreen playback", 8).await {
                    Ok(cookie) => {
                        log::info!("GNOME SessionManager inhibited (cookie={cookie})");
                        self.gnome = Some((conn, cookie));
                        any = true;
                    }
                    Err(e) => log::debug!("GNOME SessionManager inhibit unavailable: {e}"),
                }
            }
        } else {
            log::warn!("session bus unavailable for screen inhibit");
        }
        any
    }

    /// Inhibit system sleep via logind (holds the returned fd open).
    pub async fn inhibit_sleep(&mut self) {
        let Ok(conn) = zbus::Connection::system().await else {
            log::warn!("system bus unavailable for sleep inhibit");
            return;
        };
        let Ok(proxy) = Login1ManagerProxy::new(&conn).await else { return };
        match proxy.inhibit("idle:sleep", "sone", "Fullscreen playback", "block").await {
            Ok(fd) => {
                log::info!("Sleep inhibited via logind");
                self.sleep_fd = Some(fd.into());
            }
            Err(e) => log::warn!("logind inhibit failed: {e}"),
        }
    }

    /// Last-resort fallback: XDG portal Inhibit (suspend|idle = 12).
    /// Inhibition lives as long as the connection.
    pub async fn inhibit_portal(&mut self) -> bool {
        let Ok(conn) = zbus::Connection::session().await else { return false };
        let Ok(proxy) = PortalInhibitProxy::new(&conn).await else { return false };
        let mut options = std::collections::HashMap::new();
        options.insert("reason", zbus::zvariant::Value::from("Fullscreen playback"));
        match proxy.inhibit("", 4 | 8, options).await {
            Ok(_) => {
                log::info!("Idle inhibited via XDG portal (fallback)");
                self.portal_conn = Some(conn);
                true
            }
            Err(e) => {
                log::warn!("XDG portal inhibit failed: {e}");
                false
            }
        }
    }

    pub async fn release(&mut self) {
        if let Some((conn, cookie)) = self.screensaver.take() {
            if let Ok(proxy) = ScreenSaverProxy::new(&conn).await {
                let _ = proxy.un_inhibit(cookie).await;
            }
            log::info!("ScreenSaver uninhibited");
        }
        if let Some((conn, cookie)) = self.gnome.take() {
            if let Ok(proxy) = GnomeSessionManagerProxy::new(&conn).await {
                let _ = proxy.uninhibit(cookie).await;
            }
            log::info!("GNOME SessionManager uninhibited");
        }
        if self.sleep_fd.take().is_some() {
            log::info!("Sleep uninhibited (fd closed)");
        }
        if self.portal_conn.take().is_some() {
            log::info!("Portal idle inhibition released");
        }
    }
}
