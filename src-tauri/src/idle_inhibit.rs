use std::os::fd::OwnedFd;

// ─── Direct D-Bus proxies (native, non-sandboxed) ────────────────────────

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
    interface = "org.freedesktop.login1.Manager",
    default_service = "org.freedesktop.login1",
    default_path = "/org/freedesktop/login1"
)]
trait Login1Manager {
    fn inhibit(
        &self,
        what: &str,
        who: &str,
        why: &str,
        mode: &str,
    ) -> zbus::Result<zbus::zvariant::OwnedFd>;
}

// ─── XDG Desktop Portal proxy (works inside Flatpak sandbox) ─────────────

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

// ─── IdleInhibitor ───────────────────────────────────────────────────────

pub struct IdleInhibitor {
    screensaver_cookie: Option<u32>,
    sleep_fd: Option<OwnedFd>,
    /// Kept alive to hold the portal inhibition (released on drop/disconnect)
    portal_conn: Option<zbus::Connection>,
}

impl IdleInhibitor {
    pub fn new() -> Self {
        Self {
            screensaver_cookie: None,
            sleep_fd: None,
            portal_conn: None,
        }
    }

    pub async fn inhibit(&mut self) {
        if self.screensaver_cookie.is_some() || self.portal_conn.is_some() || self.sleep_fd.is_some() {
            return;
        }

        // Try XDG Portal first (works in Flatpak and most native DEs)
        if self.try_portal_inhibit().await {
            return;
        }

        // Fall back to direct D-Bus (native only, blocked in Flatpak)
        self.try_screensaver_inhibit().await;
        self.try_logind_inhibit().await;
    }

    pub async fn uninhibit(&mut self) {
        // Portal: dropping the connection releases the inhibition
        if self.portal_conn.take().is_some() {
            log::info!("Portal idle inhibition released");
        }

        // Screensaver: explicit UnInhibit call
        if let Some(cookie) = self.screensaver_cookie.take() {
            if let Ok(conn) = zbus::Connection::session().await {
                if let Ok(proxy) = ScreenSaverProxy::new(&conn).await {
                    let _ = proxy.un_inhibit(cookie).await;
                    log::info!("Screensaver uninhibited");
                }
            }
        }

        // Logind: dropping the fd releases the inhibition
        if self.sleep_fd.take().is_some() {
            log::info!("Sleep uninhibited (fd closed)");
        }
    }

    /// XDG Portal: inhibit suspend (4) + idle (8) = 12.
    /// The inhibition lives as long as the D-Bus connection that called it.
    async fn try_portal_inhibit(&mut self) -> bool {
        let conn = match zbus::Connection::session().await {
            Ok(c) => c,
            Err(_) => return false,
        };

        let proxy = match PortalInhibitProxy::new(&conn).await {
            Ok(p) => p,
            Err(_) => return false,
        };

        const INHIBIT_SUSPEND_AND_IDLE: u32 = 4 | 8;
        let mut options = std::collections::HashMap::new();
        options.insert(
            "reason",
            zbus::zvariant::Value::from("Fullscreen playback"),
        );

        match proxy
            .inhibit("", INHIBIT_SUSPEND_AND_IDLE, options)
            .await
        {
            Ok(_) => {
                log::info!("Idle inhibited via XDG portal");
                self.portal_conn = Some(conn);
                true
            }
            Err(e) => {
                log::warn!("XDG portal Inhibit failed: {e}");
                false
            }
        }
    }

    async fn try_screensaver_inhibit(&mut self) {
        let conn = match zbus::Connection::session().await {
            Ok(c) => c,
            Err(e) => {
                log::warn!("Session bus unavailable: {e}");
                return;
            }
        };

        let proxy = match ScreenSaverProxy::new(&conn).await {
            Ok(p) => p,
            Err(e) => {
                log::warn!("ScreenSaver proxy failed: {e}");
                return;
            }
        };

        match proxy.inhibit("sone", "Fullscreen playback").await {
            Ok(cookie) => {
                log::info!("Screensaver inhibited (cookie={cookie})");
                self.screensaver_cookie = Some(cookie);
            }
            Err(e) => log::warn!("Failed to inhibit screensaver: {e}"),
        }
    }

    async fn try_logind_inhibit(&mut self) {
        let conn = match zbus::Connection::system().await {
            Ok(c) => c,
            Err(e) => {
                log::warn!("System bus unavailable: {e}");
                return;
            }
        };

        let proxy = match Login1ManagerProxy::new(&conn).await {
            Ok(p) => p,
            Err(e) => {
                log::warn!("login1 proxy failed: {e}");
                return;
            }
        };

        match proxy
            .inhibit("sleep:idle", "sone", "Fullscreen playback", "block")
            .await
        {
            Ok(fd) => {
                log::info!("Sleep inhibited via logind");
                self.sleep_fd = Some(fd.into());
            }
            Err(e) => log::warn!("Failed to inhibit sleep: {e}"),
        }
    }
}
