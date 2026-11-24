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
    // flags: 4 = suspend, 8 = idle (screen blanking). xid 0 = no toplevel.
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

#[zbus::proxy(
    interface = "org.freedesktop.portal.Request",
    default_service = "org.freedesktop.portal.Desktop"
)]
trait PortalRequest {
    fn close(&self) -> zbus::Result<()>;
}

// ── DbusInhibitor ────────────────────────────────────────────────────────

const SCREEN_REASON: &str = "Playback on screen";
const SLEEP_REASON: &str = "Playing music";

const SUSPEND_FLAG: u32 = 4;
const IDLE_FLAG: u32 = 8;

/// An XDG portal inhibition; it lasts until its Request is closed or the
/// connection drops.
struct PortalHold {
    conn: zbus::Connection,
    handle: zbus::zvariant::OwnedObjectPath,
}

async fn portal_inhibit(flags: u32, reason: &str) -> Option<PortalHold> {
    let conn = zbus::Connection::session().await.ok()?;
    let proxy = PortalInhibitProxy::new(&conn).await.ok()?;
    let mut options = std::collections::HashMap::new();
    options.insert("reason", zbus::zvariant::Value::from(reason));
    match proxy.inhibit("", flags, options).await {
        Ok(handle) => Some(PortalHold { conn, handle }),
        Err(e) => {
            log::warn!("XDG portal inhibit (flags={flags}) failed: {e}");
            None
        }
    }
}

async fn portal_release(hold: PortalHold) {
    if let Ok(builder) = PortalRequestProxy::builder(&hold.conn).path(hold.handle) {
        if let Ok(req) = builder.build().await {
            let _ = req.close().await;
        }
    }
}

async fn gnome_inhibit(flags: u32, reason: &str) -> Option<(zbus::Connection, u32)> {
    let conn = zbus::Connection::session().await.ok()?;
    let proxy = GnomeSessionManagerProxy::new(&conn).await.ok()?;
    match proxy.inhibit("org.sone.app", 0, reason, flags).await {
        Ok(cookie) => Some((conn, cookie)),
        Err(e) => {
            log::debug!("GNOME SessionManager inhibit (flags={flags}) unavailable: {e}");
            None
        }
    }
}

async fn gnome_release((conn, cookie): (zbus::Connection, u32)) {
    if let Ok(proxy) = GnomeSessionManagerProxy::new(&conn).await {
        let _ = proxy.uninhibit(cookie).await;
    }
}

/// Holds every D-Bus inhibition. Connections are KEPT ALIVE for the lifetime
/// of the inhibition (dropping a session connection releases ksmserver/GNOME
/// inhibitions immediately; holding the login1 fd holds the sleep inhibition).
pub struct DbusInhibitor {
    screensaver: Option<(zbus::Connection, u32)>,
    gnome_screen: Option<(zbus::Connection, u32)>,
    logind_fd: Option<OwnedFd>,
    portal_screen: Option<PortalHold>,
    gnome_sleep: Option<(zbus::Connection, u32)>,
    portal_sleep: Option<PortalHold>,
}

impl DbusInhibitor {
    pub fn new() -> Self {
        Self {
            screensaver: None,
            gnome_screen: None,
            logind_fd: None,
            portal_screen: None,
            gnome_sleep: None,
            portal_sleep: None,
        }
    }

    /// Suspend only — blanking and locking still happen. The portal is the
    /// only route out of a Flatpak (GNOME and KDE map flag 4 to suspend-only);
    /// the direct GNOME call covers native builds without a portal. No logind
    /// block here: GNOME's own Suspend menu would then ask for a password.
    pub async fn hold_sleep(&mut self) {
        self.portal_sleep = portal_inhibit(SUSPEND_FLAG, SLEEP_REASON).await;
        self.gnome_sleep = gnome_inhibit(SUSPEND_FLAG, SLEEP_REASON).await;
        log::info!(
            "sleep inhibit: portal={} gnome={}",
            self.portal_sleep.is_some(),
            self.gnome_sleep.is_some()
        );
    }

    pub async fn release_sleep(&mut self) {
        if let Some(h) = self.portal_sleep.take() {
            portal_release(h).await;
        }
        if let Some(g) = self.gnome_sleep.take() {
            gnome_release(g).await;
        }
        log::info!("sleep inhibit released");
    }

    /// Screen-off via the session bus, plus a logind block so nothing suspends
    /// under a screen kept on. Returns true if at least one screen-keeping
    /// inhibition (ScreenSaver or GNOME) succeeded.
    pub async fn hold_screen(&mut self) -> bool {
        if let Ok(conn) = zbus::Connection::session().await {
            if let Ok(proxy) = ScreenSaverProxy::new(&conn).await {
                match proxy.inhibit("sone", SCREEN_REASON).await {
                    Ok(cookie) => {
                        log::info!("ScreenSaver inhibited (cookie={cookie})");
                        self.screensaver = Some((conn, cookie));
                    }
                    Err(e) => log::warn!("ScreenSaver inhibit failed: {e}"),
                }
            }
        } else {
            log::warn!("session bus unavailable for screen inhibit");
        }
        self.gnome_screen = gnome_inhibit(IDLE_FLAG, SCREEN_REASON).await;
        self.hold_logind().await;
        self.screensaver.is_some() || self.gnome_screen.is_some()
    }

    async fn hold_logind(&mut self) {
        let Ok(conn) = zbus::Connection::system().await else {
            log::warn!("system bus unavailable for logind inhibit");
            return;
        };
        let Ok(proxy) = Login1ManagerProxy::new(&conn).await else { return };
        match proxy.inhibit("idle:sleep", "sone", SCREEN_REASON, "block").await {
            Ok(fd) => {
                log::info!("Sleep inhibited via logind");
                self.logind_fd = Some(fd.into());
            }
            Err(e) => log::warn!("logind inhibit failed: {e}"),
        }
    }

    /// Last-resort fallback when nothing else kept the screen on.
    pub async fn hold_screen_portal(&mut self) {
        self.portal_screen = portal_inhibit(SUSPEND_FLAG | IDLE_FLAG, SCREEN_REASON).await;
        if self.portal_screen.is_some() {
            log::info!("Idle inhibited via XDG portal (fallback)");
        }
    }

    pub async fn release_screen(&mut self) {
        if let Some((conn, cookie)) = self.screensaver.take() {
            if let Ok(proxy) = ScreenSaverProxy::new(&conn).await {
                let _ = proxy.un_inhibit(cookie).await;
            }
            log::info!("ScreenSaver uninhibited");
        }
        if let Some(g) = self.gnome_screen.take() {
            gnome_release(g).await;
            log::info!("GNOME SessionManager uninhibited");
        }
        if self.logind_fd.take().is_some() {
            log::info!("logind inhibit released (fd closed)");
        }
        if let Some(h) = self.portal_screen.take() {
            portal_release(h).await;
            log::info!("Portal idle inhibition released");
        }
    }
}
