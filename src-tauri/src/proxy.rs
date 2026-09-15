//! Single source of truth for whether and how SONE proxies a request.
//!
//! Nothing outside this module constructs a proxy URI. `Direct` means the
//! system's own configuration applies; a `PlanError` blocks every capability.

use std::net::Ipv6Addr;
use std::path::{Path, PathBuf};

#[derive(Clone, PartialEq, Eq)]
pub struct Creds {
    pub user: String,
    pub pass: String,
}

// Hand-written so a stray `{plan:?}` log never prints the proxy password.
impl std::fmt::Debug for Creds {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Creds")
            .field("user", &self.user)
            .field("pass", &"***")
            .finish()
    }
}

/// Host facts that cannot be read without `gst::init()`, injected so `plan()`
/// stays pure and unit-testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostCaps {
    pub has_dashdemux: bool,
    pub has_curlhttpsrc: bool,
    pub gst_version: (u32, u32, u32),
}

impl HostCaps {
    /// A **test-only** stand-in for host facts. Production reads the registry
    /// through `crate::audio::probe_host_caps()` — `AppState` and the audio
    /// thread both do, and there are no production callers of this left. It
    /// stays `pub` only so the integration targets under `tests/` can build a
    /// `HostCaps` without a GStreamer registry.
    ///
    /// Every value here is the permissive one, and `gst_version` is exactly
    /// `CURL_SEEK_FIXED` — the lowest version that passes the seek gate. So a
    /// new production caller would not fail loudly: it would assert a host that
    /// can serve everything, which is the fail-open direction this work exists
    /// to close. Reach for the probe instead.
    #[doc(hidden)]
    pub fn assume_all_present() -> Self {
        Self {
            has_dashdemux: true,
            has_curlhttpsrc: true,
            gst_version: (1, 26, 10),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyPlan {
    Direct,
    Http {
        host: String,
        port: u16,
        creds: Option<Creds>,
    },
    Socks5 {
        host: String,
        port: u16,
        creds: Option<Creds>,
    },
}

#[derive(Clone, PartialEq, Eq)]
pub enum PlanError {
    PortZero,
    BadHost(String),
    NonAsciiHost,
    BracketedHost,
    EmbeddedPort,
}

// Hand-written for the same reason `Creds` above is, and about the same secret.
// `BadHost` carries the host field verbatim — `validate_host` rejects `@` and
// `/` precisely because people paste whole URIs in, so
// `socks5://user:secret@proxy.example` is one of the values it holds — and a
// derived `Debug` prints it the first time anyone writes `{e:?}`. Redacting the
// payload costs nothing: every `assert_eq!`/`matches!` on the enum still works,
// and a test that prints the error prints its own input alongside.
impl std::fmt::Debug for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PortZero => f.write_str("PortZero"),
            Self::BadHost(_) => f.write_str("BadHost(***)"),
            Self::NonAsciiHost => f.write_str("NonAsciiHost"),
            Self::BracketedHost => f.write_str("BracketedHost"),
            Self::EmbeddedPort => f.write_str("EmbeddedPort"),
        }
    }
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PortZero => write!(f, "proxy port must not be 0"),
            // The raw value is never echoed. `validate_host` rejects `@` and
            // `/` precisely because people paste whole URIs into the host
            // field, and `socks5://user:secret@proxy.example` is one of the
            // shapes that lands here — echoing it renders the password in a
            // toast and writes it to the log (`from_settings` logs this
            // Display). The user can still see what they typed; the advice is
            // what they cannot work out, so say that instead.
            Self::BadHost(_) => write!(
                f,
                "invalid proxy host: enter only a hostname or IP address, with \
                 no scheme, credentials, port or path"
            ),
            Self::NonAsciiHost => write!(f, "proxy host must be ASCII"),
            Self::BracketedHost => {
                write!(f, "enter an IPv6 address without brackets")
            }
            Self::EmbeddedPort => {
                write!(f, "enter the host without a port; use the port field")
            }
        }
    }
}

/// Reject anything that could change the meaning of a URI we build by
/// concatenation, or that would reach a parser known to abort on it.
fn validate_host(raw: &str) -> Result<String, PlanError> {
    let host = raw.trim();
    if host.is_empty() {
        return Err(PlanError::BadHost(raw.to_string()));
    }
    if !host.is_ascii() {
        return Err(PlanError::NonAsciiHost);
    }
    if host.starts_with('[') || host.ends_with(']') {
        return Err(PlanError::BracketedHost);
    }
    // Before the colon branch, and the order is what makes the message right.
    // A pasted `http://proxy.example` and a `user@proxy:1080` both contain a
    // colon, and both used to come back as "enter the host without a port; use
    // the port field" — advice that does not apply and does not fix either.
    // These characters can never appear in a hostname, so seeing one means the
    // field holds something other than a host, which is what to say.
    if host.contains(['@', '/', '?', '#']) {
        return Err(PlanError::BadHost(raw.to_string()));
    }
    // A bare IPv6 literal is the only legitimate reason for a colon here.
    if host.contains(':') {
        if host.parse::<Ipv6Addr>().is_ok() {
            return Ok(host.to_string());
        }
        // Scope ids (`fe80::1%eth0`) land here too: Ipv6Addr rejects them, and a
        // scoped address is meaningless for a proxy endpoint.
        if host.matches(':').count() == 1 {
            return Err(PlanError::EmbeddedPort);
        }
        return Err(PlanError::BadHost(raw.to_string()));
    }
    // Allowlist, not denylist: this string is later concatenated verbatim into
    // a URI and handed to a GStreamer element property with no `Url` parsing
    // in between, so anything that isn't plainly a hostname character is
    // rejected outright. This is what actually closes NUL bytes, C0/DEL
    // control characters, `%`-encoding, and stray URI delimiters — a denylist
    // of "known-bad" characters always misses one.
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err(PlanError::BadHost(raw.to_string()));
    }
    Ok(host.to_string())
}

fn creds_of(s: &crate::ProxySettings) -> Option<Creds> {
    let user = s.username.as_deref().unwrap_or("").trim();
    if user.is_empty() {
        return None;
    }
    Some(Creds {
        user: user.to_string(),
        // souphttpsrc only authenticates when BOTH properties are set, so an
        // absent password becomes empty rather than no credentials at all.
        pass: s.password.clone().unwrap_or_default(),
    })
}

pub fn plan(s: &crate::ProxySettings, _env: &HostCaps) -> Result<ProxyPlan, PlanError> {
    if !s.enabled {
        return Ok(ProxyPlan::Direct);
    }
    if s.port == 0 {
        return Err(PlanError::PortZero);
    }
    let host = validate_host(&s.host)?;
    let creds = creds_of(s);
    Ok(match s.proxy_type {
        crate::ProxyType::Http => ProxyPlan::Http {
            host,
            port: s.port,
            creds,
        },
        crate::ProxyType::Socks5 => ProxyPlan::Socks5 {
            host,
            port: s.port,
            creds,
        },
    })
}

/// Which consumer is asking. The spelling of a SOCKS5 URI and the element
/// requirements differ per consumer, so this is not cosmetic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    /// reqwest: API, auth, scrobbling, play reports, artwork, update check.
    Api,
    /// GStreamer progressive HTTP (lossy) — may use souphttpsrc.
    Lossy,
    /// GStreamer DASH segments (lossless/hi-res).
    Dash,
    /// The shared WebKit network session.
    Webview,
}

impl Capability {
    /// Every capability, so a status sweep cannot silently omit one the way a
    /// hand-written list does when a variant is added.
    pub const ALL: [Capability; 4] = [
        Capability::Api,
        Capability::Lossy,
        Capability::Dash,
        Capability::Webview,
    ];
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Proceed with the system's own configuration.
    NoProxy,
    Via {
        uri: String,
        creds: Option<Creds>,
    },
}

/// Why a capability cannot be served. Carries a cause because failures are
/// discovered in places `plan()` cannot see, such as resolving the proxy host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockReason {
    pub cause: String,
}

impl BlockReason {
    pub(crate) fn new(cause: impl Into<String>) -> Self {
        Self {
            cause: cause.into(),
        }
    }
}

impl std::fmt::Display for BlockReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.cause)
    }
}

/// Minimum GStreamer with a working `curlhttpsrc` progressive seek.
const CURL_SEEK_FIXED: (u32, u32, u32) = (1, 26, 10);

fn authority(host: &str, port: u16) -> String {
    if host.parse::<Ipv6Addr>().is_ok() {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

impl ProxyPlan {
    /// The proxy as a user would recognise it — `host:port`, IPv6 bracketed —
    /// or `None` for `Direct`, which names no proxy because there is none.
    ///
    /// Credentials are structurally absent: they live beside the host in
    /// `Creds`, never in this string, so a value from here is safe to put in
    /// front of a user or into a log.
    pub fn endpoint(&self) -> Option<String> {
        match self {
            Self::Direct => None,
            Self::Http { host, port, .. } | Self::Socks5 { host, port, .. } => {
                Some(authority(host, *port))
            }
        }
    }

    pub fn route(&self, c: Capability, env: &HostCaps) -> Result<Route, BlockReason> {
        let (host, port, creds, socks) = match self {
            ProxyPlan::Direct => return Ok(Route::NoProxy),
            ProxyPlan::Http { host, port, creds } => (host, *port, creds, false),
            ProxyPlan::Socks5 { host, port, creds } => (host, *port, creds, true),
        };

        if matches!(c, Capability::Lossy | Capability::Dash) {
            // souphttpsrc cannot authenticate over a CONNECT tunnel, so credentials
            // force curlhttpsrc; and it cannot do authenticated SOCKS5 at all.
            if !socks && creds.is_some() && !env.has_curlhttpsrc {
                return Err(BlockReason::new(
                    "audio cannot be proxied with credentials: the curl source \
                     plugin (curlhttpsrc) is missing — install it and restart \
                     SONE, or use a proxy that needs no username or password",
                ));
            }
            if socks && creds.is_some() && !env.has_curlhttpsrc {
                return Err(BlockReason::new(
                    "authenticated SOCKS5 audio requires the curl source plugin \
                     (curlhttpsrc) — install it and restart SONE, or use a \
                     SOCKS5 proxy that needs no username or password",
                ));
            }
        }

        if c == Capability::Dash && !env.has_dashdemux {
            return Err(BlockReason::new(
                "high-resolution audio cannot be proxied: the legacy adaptive \
                 demuxer (dashdemux) is missing — install it and restart SONE, \
                 or lower the streaming quality below high-resolution",
            ));
        }

        if c == Capability::Lossy && creds.is_some() && env.gst_version < CURL_SEEK_FIXED {
            let (a, b, d) = env.gst_version;
            let (x, y, z) = CURL_SEEK_FIXED;
            return Err(BlockReason::new(format!(
                "authenticated proxies need GStreamer {x}.{y}.{z} or newer for seeking (found {a}.{b}.{d})"
            )));
        }

        // The spelling keys on which library resolves the name, not on the
        // capability: gio has a socks5 impl and none for socks5h, while libcurl
        // and reqwest resolve locally unless told socks5h.
        let scheme = match (socks, c) {
            (false, _) => "http",
            // reqwest: socks5h is what defers resolution to the proxy.
            (true, Capability::Api) => "socks5h",
            // WebKit resolves via gio, which implements socks5 only — and gio's socks5
            // already sends the hostname, so it carries socks5h semantics.
            (true, Capability::Webview) => "socks5",
            // Audio flips element on credentials: curl source (libcurl, needs socks5h)
            // when authenticating, soup source (gio, needs socks5) otherwise.
            (true, Capability::Lossy) | (true, Capability::Dash) => {
                if creds.is_some() {
                    debug_assert!(
                        env.has_curlhttpsrc,
                        "authenticated audio reached the scheme match without the curl source; \
                         the guard above must block this",
                    );
                    // `debug_assert!` compiles out under `--release`, and the
                    // degraded behaviour there is fail-open: socks5h handed to a
                    // gio-backed source that implements only socks5 is a wrong
                    // scheme, not a block. Fail closed in every profile.
                    if !env.has_curlhttpsrc {
                        return Err(BlockReason::new(
                            "authenticated SOCKS5 audio requires the curl source \
                             plugin (curlhttpsrc) — install it and restart SONE, \
                             or use a SOCKS5 proxy that needs no username or \
                             password",
                        ));
                    }
                    "socks5h"
                } else {
                    "socks5"
                }
            }
        };

        Ok(Route::Via {
            uri: format!("{scheme}://{}", authority(host, port)),
            creds: creds.clone(),
        })
    }
}

/// Every variable libcurl, libproxy or reqwest may read to find a proxy, in
/// both spellings — the list that is **captured** at startup, which is wider
/// than the list that is removed. See `SCRUBBED_PROXY_ENV_VARS` for what
/// actually goes, and why the two differ.
///
/// The capture has to be the full union even while the scrub is narrow: stage
/// 4a sets WebKit's proxy explicitly and will scrub the per-scheme names too,
/// and by then the values are gone from the environment. Capturing everything
/// once, at the only sound moment, is what leaves that stage a restore path.
///
/// Both cases of all four, because the three readers disagree and the union is
/// what has to go:
///
/// - libcurl (so `curlhttpsrc`) honours lowercase `http_proxy` only — an
///   uppercase one would be attacker-controlled through the `Proxy:` request
///   header under CGI — but reads either case of `https_proxy`, `all_proxy`
///   and `no_proxy`.
/// - reqwest prefers the uppercase spelling of `HTTP_PROXY`, `HTTPS_PROXY` and
///   `ALL_PROXY` and falls back to lowercase, and reads `NO_PROXY` then
///   `no_proxy`.
/// - libproxy (so gio, libsoup and WebKit) reads both cases of the per-scheme
///   names and of `no_proxy`, and never reads `all_proxy` at all — that one is
///   libcurl's and reqwest's.
///
/// So no single reader wants all eight, and scrubbing one spelling leaves the
/// other live for at least one of them. Per-scheme names SONE never speaks
/// (`ftp_proxy`, `rsync_proxy`) are deliberately absent: no transport in this
/// process reads them, and removing a variable that is not ours to remove is
/// its own surprise.
///
/// Not covered, and not coverable here: libproxy 0.4.x also honours
/// `_PX_DEBUG_PACURL`, which points the whole gio/libsoup/WebKit path at a PAC
/// file regardless of everything above. It is an obscure debug hook rather
/// than a configuration mechanism, and removing it would be mutating something
/// that is plainly not ours; noted so nobody concludes this list is airtight.
pub const PROXY_ENV_VARS: [&str; 8] = [
    "http_proxy",
    "HTTP_PROXY",
    "https_proxy",
    "HTTPS_PROXY",
    "all_proxy",
    "ALL_PROXY",
    "no_proxy",
    "NO_PROXY",
];

/// What `main.rs` actually removes when the launch sidecar says SONE is
/// proxying: the bypass list, and nothing else.
///
/// Narrower than `PROXY_ENV_VARS` on purpose, and the narrowness is the safe
/// direction. Removing `no_proxy` can only ever *increase* what gets proxied,
/// which is all finding F6 requires — `curlhttpsrc` forwards an ambient
/// `no_proxy` as `CURLOPT_NOPROXY` and it defeats an explicitly-set `proxy`
/// property, so it has to be gone before any element is constructed.
///
/// Removing a per-scheme variable is the opposite direction, and until the
/// stage that sets the corresponding explicit proxy has landed it is a
/// downgrade rather than containment. Nothing in this stage sets WebKit's
/// proxy, and `audio.rs` only honours an `http_proxy` for `ProxyType::Http`,
/// so for a user who exports `http_proxy` *and* enables SONE's proxy, deleting
/// it would move the WebView surfaces and SOCKS5 audio from "proxied by their
/// own ambient configuration" to direct, from the real IP.
///
/// So each of the remaining six is scrubbed by the stage that replaces it:
///
/// - `http_proxy` / `HTTP_PROXY`, `https_proxy` / `HTTPS_PROXY` and
///   `all_proxy` / `ALL_PROXY` — still here. The GStreamer sources now carry an
///   explicit `proxy` property, but the scrub was deliberately **not** widened
///   with them: WebKit (the login window, `<video>`, the blur backdrop) has no
///   explicit proxy yet, and those three names are the only thing routing it.
///   Deleting them would move that surface from proxied-by-ambient-config to
///   direct, from the real address. They go with the stage that sets
///   `WebKitNetworkProxySettings`, not before.
///
/// reqwest is already independent of all of this: `proxy_http.rs` builds every
/// client from the plan, and the `Direct` route restores the captured values
/// rather than reading the environment.
pub const SCRUBBED_PROXY_ENV_VARS: [&str; 2] = ["no_proxy", "NO_PROXY"];

/// One-shot repair of settings written before this module existed.
///
/// The old `build_http_client` read `enabled: true, host: "", port: 0` as "no
/// proxy" and handed back a direct client, so that combination is a real state
/// on disk today: an install where the user flipped the toggle, never filled
/// the fields in, and saw nothing go wrong. `plan()` is fail-closed and calls
/// the same value `PlanError::PortZero`, which blocks every capability — no
/// API, no artwork, no login, no update check, and a settings screen the user
/// cannot reach without logging in.
///
/// Disabling it reproduces exactly what that install already had: `Direct`,
/// the system's own configuration. It is the one shape where fail-closed would
/// punish a user for a state a previous version told them was fine, so it is
/// migrated rather than blocked. Everything else still fails closed.
///
/// Worth naming, because the two halves of this branch disagreed about this
/// value: `shouldSubmitProxy` calls it half-typed and withholds it, while
/// `plan()` calls it a hard block. Both are right about live input — the
/// frontend never sends it, so `plan()` never sees it from there — but neither
/// covers a value already sitting on disk from before either existed.
///
/// Returns whether anything changed, so the caller can persist and log once
/// rather than on every read.
pub fn migrate_incomplete_proxy(s: &mut crate::ProxySettings) -> bool {
    if s.enabled && (s.host.trim().is_empty() || s.port == 0) {
        s.enabled = false;
        return true;
    }
    false
}

/// A plaintext companion to the encrypted settings, holding only what `main.rs`
/// needs before `AppState` (and therefore the decryption key) exists.
pub fn sidecar_path(config_dir: &Path) -> PathBuf {
    config_dir.join("proxy.mode")
}

/// Mirror the two non-secret fields to the sidecar. Host, port and credentials
/// stay in the encrypted file: `main.rs` decides only *whether* it is proxying,
/// never *where to*, so nothing else belongs in a plaintext file.
///
/// Best effort by design. A sidecar that cannot be written leaves the next
/// launch believing SONE is not proxying, which is the same state as today and
/// degrades to a leak of the ambient configuration, not to a broken app —
/// whereas failing the save would strand the user on the one screen that can
/// undo a bad proxy.
pub fn write_sidecar(config_dir: &Path, s: &crate::ProxySettings) {
    let kind = match s.proxy_type {
        crate::ProxyType::Http => "http",
        crate::ProxyType::Socks5 => "socks5",
    };
    let body = format!("{}\n{}\n", if s.enabled { "on" } else { "off" }, kind);
    if let Err(e) = write_sidecar_file(&sidecar_path(config_dir), &body) {
        log::warn!("[proxy] could not write mode sidecar: {e}");
    }
}

/// Owner-only, 0600. The contents are not secret, but they do disclose *that*
/// this user proxies and *with what* — beside a settings file that is
/// encrypted precisely so a reader of the config directory learns neither.
///
/// The mode is set twice on purpose: `OpenOptions::mode` applies only when the
/// file is created, so a sidecar written before this change — or by an older
/// build under a loose umask — would keep its old permissions forever without
/// the explicit `set_permissions`.
fn write_sidecar_file(path: &Path, body: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(body.as_bytes())?;
    f.set_permissions(std::fs::Permissions::from_mode(0o600))
}

/// `None` whenever the file is absent, truncated, or carries a proxy type this
/// build does not know. The caller treats every `None` as "not proxying", so a
/// partial or unrecognised read must never come back as a half-answer — and
/// the type is validated rather than passed through because it is a value a
/// later task is expected to act on.
pub fn read_sidecar(config_dir: &Path) -> Option<(bool, String)> {
    let body = std::fs::read_to_string(sidecar_path(config_dir)).ok()?;
    let mut lines = body.lines();
    let enabled = lines.next()?.trim() == "on";
    let kind = match lines.next()?.trim() {
        k @ ("http" | "socks5") => k.to_string(),
        _ => return None,
    };
    Some((enabled, kind))
}

/// The proxy environment as it stood before `main.rs` removed it, captured so
/// the `Direct` path can hand it back.
///
/// Empty whenever no scrub happened, which is both the common case and the
/// safe default: consumers then behave exactly as they did before this
/// existed, letting their own auto-detection read a untouched environment.
static SCRUBBED_ENV: std::sync::OnceLock<Vec<(String, String)>> = std::sync::OnceLock::new();

/// Called once from `main.rs`, immediately before the variables are removed.
/// Later calls are ignored: the first capture is the only true one, since by
/// then the environment no longer holds what it is recording.
pub fn remember_scrubbed_env(vars: Vec<(String, String)>) {
    let _ = SCRUBBED_ENV.set(vars);
}

pub fn scrubbed_env() -> &'static [(String, String)] {
    SCRUBBED_ENV.get().map(Vec::as_slice).unwrap_or(&[])
}

/// Whether a proxy bypass list survived startup — set in the environment when
/// the process began *and* left there, because the scrub did not run.
///
/// Deliberately not folded into `SCRUBBED_ENV`. That capture feeds
/// `system_proxy_from_env` and means "what the user's shell configured"; this
/// means "what is still in the environment and will defeat an explicit proxy".
/// The two coincide only when the scrub did not run, which is precisely the
/// case this exists for.
static LAUNCH_BYPASS: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Record whether a proxy bypass list was present in the environment when the
/// process started. Call once, from `main.rs`, before any thread exists.
pub fn remember_launch_bypass(present: bool) {
    let _ = LAUNCH_BYPASS.set(present);
}

pub fn launch_bypass_was_set() -> bool {
    *LAUNCH_BYPASS.get().unwrap_or(&false)
}

/// Which slot a captured value is being resolved for.
///
/// reqwest builds a *different* proxy object per scheme from the same string,
/// so the parse cannot be shared between the two and the caller has to be told
/// which one it is producing. That is also why `ALL_PROXY` costs two parses:
/// it fills both slots, and 0.11.27 likewise calls `insert_from_env` twice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvScheme {
    Http,
    Https,
}

/// What the system's own configuration said, resolved from captured variables.
///
/// Generic over what a captured value resolves *to* so the resolution and the
/// construction are a single step: `proxy_http.rs` instantiates it with
/// `reqwest::Proxy`, so every string that is parsed yields the object that is
/// then used, and nothing is parsed twice. That matters because parsing a
/// `socks5h://` value resolves its host — a second parse is a second
/// `getaddrinfo`. Tests here use `String`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemProxyEnv<T> {
    pub http: Option<T>,
    pub https: Option<T>,
    pub no_proxy: Option<String>,
}

// Hand-written: the derive would bound `T: Default`, and `reqwest::Proxy` is
// not — every field here is an `Option`, so nothing about `T` is needed.
impl<T> Default for SystemProxyEnv<T> {
    fn default() -> Self {
        Self {
            http: None,
            https: None,
            no_proxy: None,
        }
    }
}

impl<T> SystemProxyEnv<T> {
    pub fn is_empty(&self) -> bool {
        self.http.is_none() && self.https.is_none() && self.no_proxy.is_none()
    }
}

/// Resolve captured variables exactly as **reqwest 0.11.27** would have, so
/// restoring them reproduces the routing the user already had.
///
/// This is a deliberate mirror of one release — `reqwest-0.11.27/src/proxy.rs`,
/// `get_from_environment` and `NoProxy::from_env` — and not an attempt at a
/// good rule:
///
/// - Per scheme, the uppercase spelling is tried first and the lowercase one
///   is the fallback, where "tried" means set, non-empty after trimming, and
///   parseable as a proxy URI. An unparseable `HTTP_PROXY` therefore falls
///   through to `http_proxy` rather than winning and yielding nothing.
/// - `ALL_PROXY` (then `all_proxy`) is applied **last and overwrites both
///   schemes**, because 0.11.27 runs that block after the per-scheme ones and
///   `insert_proxy` is an unconditional `HashMap::insert`.
/// - `NO_PROXY` wins over `no_proxy` on *presence*, not on emptiness: 0.11.27
///   takes `env::var("NO_PROXY").or_else(|_| env::var("no_proxy"))`, so an
///   exported-but-empty `NO_PROXY` suppresses the lowercase one entirely.
///
/// The `ALL_PROXY` rule is the one worth defending, because it is the one a
/// reviewer will want to "fix": per-scheme-wins is saner and is what reqwest
/// 0.12+ does. It is still wrong here. With `ALL_PROXY=http://all:1` and
/// `https_proxy=http://s:2` this user's traffic *was* going to `all:1`; a
/// better precedence would silently send it somewhere their own configuration
/// never chose. Restoration must be faithful, not improved. `source_guards.rs`
/// pins the `reqwest = "0.11"` requirement so a major bump fails the suite
/// instead of diverging quietly.
///
/// One documented non-mirror: 0.11.27 ignores `HTTP_PROXY` when `REQUEST_METHOD`
/// is set, because under CGI that variable is attacker-controlled. SONE is a
/// desktop application, never a CGI process, and `REQUEST_METHOD` is not among
/// the variables `main.rs` captures, so there is nothing to reproduce.
///
/// `parse` is injected rather than called directly for two reasons: deciding
/// whether a captured string is a usable proxy means building a
/// `reqwest::Proxy`, and those are confined to `proxy_http.rs`; and returning
/// the parsed object rather than a yes/no keeps this to one parse per value.
/// Pure otherwise, because the precedence is the whole of the risk and is not
/// observable from outside the process.
pub fn system_proxy_from_env<T>(
    vars: &[(String, String)],
    parse: impl Fn(EnvScheme, &str) -> Option<T>,
) -> SystemProxyEnv<T> {
    let present = |name: &str| {
        vars.iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    };
    // `insert_proxy`: empty or whitespace is rejected before parsing, and an
    // unparseable value is rejected too — both leave the lowercase fallback to
    // be tried.
    let get = |scheme, name: &str| {
        present(name)
            .filter(|v| !v.trim().is_empty())
            .and_then(|v| parse(scheme, v))
    };

    let mut resolved = SystemProxyEnv {
        http: get(EnvScheme::Http, "HTTP_PROXY").or_else(|| get(EnvScheme::Http, "http_proxy")),
        https: get(EnvScheme::Https, "HTTPS_PROXY")
            .or_else(|| get(EnvScheme::Https, "https_proxy")),
        // Presence, not usability: `from_env` reads the variable and hands
        // whatever it finds to `from_string`, which rejects an empty list on
        // its own.
        no_proxy: present("NO_PROXY")
            .or_else(|| present("no_proxy"))
            .map(str::to_string),
    };

    // Last, and overwriting. See the note above before changing this.
    //
    // Shaped to match 0.11.27 statement for statement, including two things
    // that look like slips and are not. The `&&` short-circuits, so the https
    // insert never runs when the http one failed. And a failed `insert_proxy`
    // leaves the slot alone rather than clearing it, so a value that parses for
    // one scheme and not the other keeps whatever the per-scheme name put
    // there — which is why each assignment is guarded instead of unconditional.
    let upper = get(EnvScheme::Http, "ALL_PROXY");
    let both_landed = match upper {
        Some(http) => {
            let https = get(EnvScheme::Https, "ALL_PROXY");
            resolved.http = Some(http);
            let landed = https.is_some();
            if https.is_some() {
                resolved.https = https;
            }
            landed
        }
        None => false,
    };
    if !both_landed {
        if let Some(http) = get(EnvScheme::Http, "all_proxy") {
            resolved.http = Some(http);
        }
        if let Some(https) = get(EnvScheme::Https, "all_proxy") {
            resolved.https = Some(https);
        }
    }
    resolved
}

/// What the settings screen shows for the proxy as a whole.
///
/// The four states are not interchangeable, and the distinction is the point:
///
/// - `Off` — the user has no proxy enabled. `ProxyPlan::Direct`, the system's
///   own configuration applies, and there is nothing to report.
/// - `Blocked` — the settings cannot be turned into a plan at all, so *every*
///   capability is refused and nothing egresses through the proxy. Per the
///   spec this is exactly the `PlanError` case; it carries the reason so the
///   banner can say which field is wrong instead of "connection failed".
/// - `Unreachable` — the plan is usable, the client built, and requests are
///   going out and getting nothing back. This is the *common* failure and the
///   one `Blocked` does not cover: a host that is merely unresolvable plans
///   fine and, over `http://`, builds fine too, because reqwest defers the
///   proxy's name lookup to the first request. It carries the proxy's
///   `host:port` and nothing else, because `host:port` is the whole of what is
///   known. Note how little that is: reqwest cannot tell an unreachable proxy
///   from one that answered and refused — a 407 on the CONNECT tunnel, which
///   is what a mistyped proxy password produces, arrives as the same kind as a
///   failed DNS lookup — and an unplugged cable produces the same evidence
///   again. So the wording this feeds says a reply is not coming back through
///   `host:port` and lists every cause that fits. It must never become "your
///   proxy is down": that claim is not observed, it is guessed, and it is
///   wrong for the most likely user in this state.
///   Raising it takes `UNANSWERED_THRESHOLD` unanswered requests in a row, not
///   one, because the action it offers removes containment.
/// - `Active { degraded }` — the plan is usable, but some capabilities cannot
///   be served on this host (a missing GStreamer element, a GStreamer too old
///   to seek through an authenticated proxy). That is a per-feature notice,
///   never a global "your proxy is broken" banner: the API, and therefore the
///   whole UI, is working.
///
/// `degraded` is `Vec<Capability>` rather than a vector of strings so a caller
/// cannot match on prose. The refusal text for each one lives in `BlockReason`
/// and is re-derived by `route()` where it is needed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum ProxyStatus {
    Off,
    Active { degraded: Vec<Capability> },
    Unreachable { endpoint: String },
    Blocked { reason: String },
}

impl ProxyStatus {
    /// Pure, so the whole table can be tested without a GStreamer registry or
    /// an `AppState` — which is all this is for now. **Production reports
    /// through `observed`**, which corrects this verdict with what the live
    /// client cell holds; nothing outside tests calls this, and a caller that
    /// did would report `Active` for a proxy that cannot hand out a client.
    ///
    /// `caps` is the real probe wherever the answer reaches a user, so
    /// `degraded` genuinely fills: on a host below `CURL_SEEK_FIXED` with a
    /// credentialed proxy it carries `Lossy`.
    #[doc(hidden)]
    pub fn evaluate(s: &crate::ProxySettings, caps: &HostCaps) -> Self {
        match plan(s, caps) {
            Ok(p) => Self::for_plan(&p, caps),
            // Unplannable settings block every capability, not some of them.
            Err(e) => Self::Blocked {
                reason: e.to_string(),
            },
        }
    }

    /// The settings-only verdict for a plan that already parsed.
    fn for_plan(plan: &ProxyPlan, caps: &HostCaps) -> Self {
        if *plan == ProxyPlan::Direct {
            return Self::Off;
        }
        // Deliberately not "if everything is degraded, call it Blocked".
        // `Capability::Api` has no host requirement once a plan exists, so a
        // usable plan always serves it, and collapsing a partial refusal into a
        // global banner is the failure mode the spec calls out by name.
        Self::Active {
            degraded: Capability::ALL
                .into_iter()
                .filter(|c| plan.route(*c, caps).is_err())
                .collect(),
        }
    }

    /// `evaluate`, corrected by what the live client cell actually holds.
    ///
    /// `evaluate` alone is not enough to report a block, because a `PlanError`
    /// is not the only way to reach one. reqwest resolves a SOCKS5 proxy host
    /// while building the client, so `socks5://no-such-host:1080` plans
    /// perfectly and blocks the cell anyway — and that is precisely the state
    /// a user can save, log out of, and then be unable to reach the settings
    /// screen to undo. Reporting `Active` for it would leave the banner that
    /// carries the way out unrendered.
    ///
    /// The cell wins whenever it is blocked, including over `Off`: it is what
    /// egresses, so if it cannot hand out a client then nothing is getting out
    /// regardless of what the settings say.
    ///
    /// `unanswered` is the cell's record of whether the last request it served
    /// got a reply, and it is consulted **last and only for a plan that routes
    /// through a proxy**. That ordering is the honesty rule in code: under
    /// `Direct` the same failure is an ordinary network error and must read as
    /// one, because no proxy was in the path to blame.
    pub fn observed(
        s: &crate::ProxySettings,
        caps: &HostCaps,
        cell_block: Option<&str>,
        unanswered: bool,
    ) -> Self {
        if let Some(reason) = cell_block {
            return Self::Blocked {
                reason: reason.to_string(),
            };
        }
        let plan = match plan(s, caps) {
            Ok(p) => p,
            Err(e) => {
                return Self::Blocked {
                    reason: e.to_string(),
                }
            }
        };
        match (unanswered, plan.endpoint()) {
            (true, Some(endpoint)) => Self::Unreachable { endpoint },
            _ => Self::for_plan(&plan, caps),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ProxySettings, ProxyType};

    fn settings(host: &str, port: u16) -> ProxySettings {
        ProxySettings {
            enabled: true,
            proxy_type: ProxyType::Http,
            host: host.to_string(),
            port,
            username: None,
            password: None,
        }
    }

    #[test]
    fn disabled_is_direct() {
        let mut s = settings("127.0.0.1", 8080);
        s.enabled = false;
        assert!(matches!(
            plan(&s, &HostCaps::assume_all_present()),
            Ok(ProxyPlan::Direct)
        ));
    }

    #[test]
    fn port_zero_is_an_error_not_direct() {
        // Regression: today this silently resolves to Direct, which is fail-open.
        assert!(matches!(
            plan(&settings("127.0.0.1", 0), &HostCaps::assume_all_present()),
            Err(PlanError::PortZero)
        ));
    }

    #[test]
    fn plain_host_is_accepted() {
        let p = plan(
            &settings("proxy.example", 3128),
            &HostCaps::assume_all_present(),
        )
        .unwrap();
        assert!(
            matches!(p, ProxyPlan::Http { ref host, port: 3128, .. } if host == "proxy.example")
        );
    }

    #[test]
    fn host_is_trimmed() {
        let p = plan(
            &settings("  proxy.example  ", 3128),
            &HostCaps::assume_all_present(),
        )
        .unwrap();
        assert!(matches!(p, ProxyPlan::Http { ref host, .. } if host == "proxy.example"));
    }

    #[test]
    fn bare_ipv6_is_accepted_and_stored_unbracketed() {
        let p = plan(
            &settings("2001:db8::1", 8080),
            &HostCaps::assume_all_present(),
        )
        .unwrap();
        assert!(matches!(p, ProxyPlan::Http { ref host, .. } if host == "2001:db8::1"));
    }

    #[test]
    fn already_bracketed_ipv6_is_rejected() {
        // Not a crash guard, whatever the sibling cases suggest: `[::1]` was
        // measured building a well-formed URI and exiting 0. `authority()`
        // would even emit a correct `[::1]:8080` for it, since a bracketed
        // literal does not parse as an `Ipv6Addr` and so skips the bracketing
        // step.
        //
        // It is a normalization choice. The host field holds one spelling of
        // an address — a bare literal — and `authority()` is the single place
        // that brackets it. Two spellings mean every consumer decides for
        // itself, and `[[::1]]` is what that produces when one decides twice;
        // *that* one core-dumps souphttpsrc. `tests/proxy_host_abort.rs` keeps
        // the measurement.
        assert!(matches!(
            plan(&settings("[::1]", 8080), &HostCaps::assume_all_present()),
            Err(PlanError::BracketedHost)
        ));
    }

    #[test]
    fn host_with_embedded_port_is_rejected() {
        assert!(matches!(
            plan(
                &settings("1.2.3.4:9999", 8080),
                &HostCaps::assume_all_present()
            ),
            Err(PlanError::EmbeddedPort)
        ));
    }

    #[test]
    fn ipv6_scope_id_is_rejected() {
        assert!(matches!(
            plan(
                &settings("fe80::1%eth0", 8080),
                &HostCaps::assume_all_present()
            ),
            Err(PlanError::BadHost(_))
        ));
    }

    #[test]
    fn non_ascii_host_is_rejected() {
        assert!(matches!(
            plan(
                &settings("пример.рф", 8080),
                &HostCaps::assume_all_present()
            ),
            Err(PlanError::NonAsciiHost)
        ));
    }

    #[test]
    fn url_ish_and_delimiter_hosts_are_rejected() {
        for bad in [
            "http://proxy.example",
            "user@proxy",
            "pro?xy",
            "pro#xy",
            "",
            "   ",
        ] {
            assert!(
                plan(&settings(bad, 8080), &HostCaps::assume_all_present()).is_err(),
                "expected {bad:?} to be rejected"
            );
        }
    }

    /// Rejected, and rejected for the right reason. Both of these contain a
    /// colon, so a URI delimiter check placed after the colon branch answers
    /// them with "enter the host without a port; use the port field" — advice
    /// that neither describes what is wrong nor fixes it. The two forms a user
    /// actually produces are a pasted URL and a copied `user@host:port`.
    #[test]
    fn a_pasted_url_is_not_reported_as_a_host_with_a_port() {
        for bad in [
            "http://proxy.example",
            "https://proxy.example:3128",
            "user@proxy:1080",
            "user:pass@proxy",
        ] {
            let err = plan(&settings(bad, 8080), &HostCaps::assume_all_present()).unwrap_err();
            assert!(
                matches!(err, PlanError::BadHost(_)),
                "{bad:?} should read as a bad host, not as a port problem: {err}"
            );
        }
    }

    /// The message is rendered in a toast, in the settings banner
    /// (`ProxyStatus::Blocked`) and in the log (`ProxiedHttp::from_settings`
    /// logs this Display). A pasted `scheme://user:pass@host` is one of the
    /// shapes `validate_host` rejects — the `@` branch is there because people
    /// paste whole URIs — so echoing the field publishes the password.
    #[test]
    fn a_rejected_host_is_not_echoed_back_with_whatever_was_in_it() {
        for raw in [
            "socks5://user:hunter2@proxy.example",
            "user:hunter2@proxy.example",
            "hunter2@proxy",
        ] {
            let err = plan(&settings(raw, 3128), &HostCaps::assume_all_present()).unwrap_err();
            let shown = err.to_string();
            assert!(
                !shown.contains("hunter2"),
                "{raw:?} put its password in a user-visible message: {shown}"
            );
            assert!(!shown.contains(raw), "{raw:?} is echoed verbatim: {shown}");
            // Debug too, and for the same reason `Creds` hand-writes one: the
            // Display fix is undone by the first `{e:?}` anyone adds.
            let dbg = format!("{err:?}");
            assert!(
                !dbg.contains("hunter2") && !dbg.contains(raw),
                "{raw:?} survives a `{{:?}}` log: {dbg}"
            );
            // Still worth reading: a bare "invalid proxy host" leaves a user
            // who pasted a URI with nothing to do about it.
            assert!(
                shown.contains("hostname") && shown.contains("credentials"),
                "the refusal must still say what to enter instead: {shown}"
            );
        }
    }

    #[test]
    fn credentials_are_captured_with_empty_password_preserved() {
        let mut s = settings("proxy.example", 3128);
        s.username = Some("bob".into());
        s.password = Some(String::new());
        let p = plan(&s, &HostCaps::assume_all_present()).unwrap();
        match p {
            ProxyPlan::Http { creds: Some(c), .. } => {
                assert_eq!(c.user, "bob");
                assert_eq!(c.pass, "");
            }
            other => panic!("expected creds, got {other:?}"),
        }
    }

    #[test]
    fn username_without_password_still_yields_creds() {
        // souphttpsrc needs BOTH properties set; an absent password becomes empty,
        // never a missing credential pair.
        let mut s = settings("proxy.example", 3128);
        s.username = Some("bob".into());
        s.password = None;
        assert!(matches!(
            plan(&s, &HostCaps::assume_all_present()),
            Ok(ProxyPlan::Http { creds: Some(_), .. })
        ));
    }

    #[test]
    fn password_without_username_is_no_credentials() {
        let mut s = settings("proxy.example", 3128);
        s.username = None;
        s.password = Some("hunter2".into());
        assert!(matches!(
            plan(&s, &HostCaps::assume_all_present()),
            Ok(ProxyPlan::Http { creds: None, .. })
        ));
    }

    #[test]
    fn socks5_type_is_preserved() {
        let mut s = settings("proxy.example", 1080);
        s.proxy_type = ProxyType::Socks5;
        s.username = Some("bob".into());
        s.password = Some("hunter2".into());
        let p = plan(&s, &HostCaps::assume_all_present()).unwrap();
        match p {
            ProxyPlan::Socks5 { host, port, creds } => {
                assert_eq!(host, "proxy.example");
                assert_eq!(port, 1080);
                let c = creds.expect("expected creds to survive on the Socks5 arm");
                assert_eq!(c.user, "bob");
                assert_eq!(c.pass, "hunter2");
            }
            other => panic!("expected Socks5, got {other:?}"),
        }
    }

    #[test]
    fn nul_byte_host_is_rejected() {
        // ToGlibPtr for str only checks interior NULs under debug_assertions;
        // in release the host is silently truncated at the NUL, so the
        // element ends up contacting a different host than was validated.
        assert!(matches!(
            plan(
                &settings("evil.com\0.good.proxy", 8080),
                &HostCaps::assume_all_present()
            ),
            Err(PlanError::BadHost(_))
        ));
    }

    #[test]
    fn control_character_host_is_rejected() {
        for bad in ["pro\x07xy", "a\x1bb.com", "a\x7fb.com"] {
            assert!(
                matches!(
                    plan(&settings(bad, 8080), &HostCaps::assume_all_present()),
                    Err(PlanError::BadHost(_))
                ),
                "expected {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn percent_encoded_host_is_rejected() {
        // Unfiltered `%` lets a downstream percent-decoder reach a different
        // host than the one validated here.
        for bad in ["good.proxy%00.evil.com", "pro%40evil.com", "evil%2ecom"] {
            assert!(
                matches!(
                    plan(&settings(bad, 8080), &HostCaps::assume_all_present()),
                    Err(PlanError::BadHost(_))
                ),
                "expected {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn delimiter_hosts_are_rejected() {
        for bad in [
            "a,b.com", "a;b.com", "a|b.com", "a<b>.com", "a\"b.com", "a`b.com", "a*b.com",
            "a{b}.com", "a[b", "a]b.com",
        ] {
            assert!(
                plan(&settings(bad, 8080), &HostCaps::assume_all_present()).is_err(),
                "expected {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn creds_debug_redacts_password() {
        let c = Creds {
            user: "bob".into(),
            pass: "hunter2".into(),
        };
        let debug = format!("{c:?}");
        assert!(debug.contains("bob"));
        assert!(!debug.contains("hunter2"));
    }

    fn http_plan(port: u16) -> ProxyPlan {
        plan(
            &settings("proxy.example", port),
            &HostCaps::assume_all_present(),
        )
        .unwrap()
    }

    fn socks_plan(with_creds: bool) -> ProxyPlan {
        let mut s = settings("proxy.example", 1080);
        s.proxy_type = ProxyType::Socks5;
        if with_creds {
            s.username = Some("bob".into());
            s.password = Some("hunter2".into());
        }
        plan(&s, &HostCaps::assume_all_present()).unwrap()
    }

    fn authed_plan(port: u16) -> ProxyPlan {
        let mut s = settings("proxy.example", port);
        s.username = Some("bob".into());
        s.password = Some("hunter2".into());
        plan(&s, &HostCaps::assume_all_present()).unwrap()
    }

    fn uri_of(r: &Route) -> &str {
        match r {
            Route::Via { uri, .. } => uri,
            Route::NoProxy => panic!("expected a proxied route"),
        }
    }

    #[test]
    fn direct_routes_to_noproxy_for_every_capability() {
        let caps = HostCaps::assume_all_present();
        for c in [
            Capability::Api,
            Capability::Lossy,
            Capability::Dash,
            Capability::Webview,
        ] {
            assert!(matches!(
                ProxyPlan::Direct.route(c, &caps),
                Ok(Route::NoProxy)
            ));
        }
    }

    #[test]
    fn port_80_is_preserved_for_every_capability() {
        // Regression: round-tripping through url::Url drops a default port and
        // libcurl then silently dials 1080.
        let caps = HostCaps::assume_all_present();
        let p = http_plan(80);
        for c in [
            Capability::Api,
            Capability::Lossy,
            Capability::Dash,
            Capability::Webview,
        ] {
            let r = p.route(c, &caps).unwrap();
            assert_eq!(uri_of(&r), "http://proxy.example:80", "capability {c:?}");
        }
    }

    #[test]
    fn every_port_round_trips_exactly() {
        let caps = HostCaps::assume_all_present();
        for port in [1u16, 80, 443, 1080, 8080, 65535] {
            let r = http_plan(port).route(Capability::Api, &caps).unwrap();
            assert_eq!(uri_of(&r), format!("http://proxy.example:{port}"));
        }
    }

    #[test]
    fn ipv6_is_bracketed_exactly_once_in_the_uri() {
        let caps = HostCaps::assume_all_present();
        let p = plan(&settings("2001:db8::1", 8080), &caps).unwrap();
        let r = p.route(Capability::Lossy, &caps).unwrap();
        assert_eq!(uri_of(&r), "http://[2001:db8::1]:8080");
    }

    #[test]
    fn socks5_spellings_without_credentials_cover_every_capability() {
        // The spelling keys on the resolving library, never on the capability
        // alone. Unauthenticated audio goes through the soup source (gio), and
        // gio implements socks5 only — its socks5 already sends the hostname.
        // reqwest resolves locally unless told socks5h.
        let caps = HostCaps::assume_all_present();
        let p = socks_plan(false);
        for (c, want) in [
            (Capability::Api, "socks5h://proxy.example:1080"),
            (Capability::Webview, "socks5://proxy.example:1080"),
            (Capability::Lossy, "socks5://proxy.example:1080"),
            (Capability::Dash, "socks5://proxy.example:1080"),
        ] {
            assert_eq!(
                uri_of(&p.route(c, &caps).unwrap()),
                want,
                "capability {c:?}"
            );
        }
    }

    #[test]
    fn socks5_spellings_with_credentials_cover_every_capability() {
        // Credentials flip both audio capabilities onto the curl source, which
        // is libcurl and so resolves locally unless told socks5h. Webview still
        // goes through gio and must stay socks5, or it reaches NO GProxy IMPL.
        let caps = HostCaps::assume_all_present();
        let p = socks_plan(true);
        for (c, want) in [
            (Capability::Api, "socks5h://proxy.example:1080"),
            (Capability::Webview, "socks5://proxy.example:1080"),
            (Capability::Lossy, "socks5h://proxy.example:1080"),
            (Capability::Dash, "socks5h://proxy.example:1080"),
        ] {
            assert_eq!(
                uri_of(&p.route(c, &caps).unwrap()),
                want,
                "capability {c:?}"
            );
        }
    }

    #[test]
    fn http_plans_are_http_for_every_capability_regardless_of_credentials() {
        let caps = HostCaps::assume_all_present();
        for p in [http_plan(3128), authed_plan(3128)] {
            for c in [
                Capability::Api,
                Capability::Webview,
                Capability::Lossy,
                Capability::Dash,
            ] {
                assert_eq!(
                    uri_of(&p.route(c, &caps).unwrap()),
                    "http://proxy.example:3128",
                    "capability {c:?}"
                );
            }
        }
    }

    #[test]
    fn no_route_uri_ever_contains_credentials() {
        let caps = HostCaps::assume_all_present();
        let p = authed_plan(3128);
        for c in [
            Capability::Api,
            Capability::Lossy,
            Capability::Dash,
            Capability::Webview,
        ] {
            let r = p.route(c, &caps).unwrap();
            let uri = uri_of(&r);
            assert!(!uri.contains('@'), "{uri}");
            assert!(!uri.contains("bob"), "{uri}");
            assert!(!uri.contains("hunter2"), "{uri}");
            assert!(matches!(r, Route::Via { creds: Some(_), .. }));
        }
    }

    fn block_cause(p: &ProxyPlan, c: Capability, env: &HostCaps) -> String {
        match p.route(c, env) {
            Err(b) => b.cause,
            Ok(r) => panic!("expected {c:?} to be blocked, got {r:?}"),
        }
    }

    #[test]
    fn socks5_with_credentials_needs_curlhttpsrc_for_audio() {
        let mut caps = HostCaps::assume_all_present();
        caps.has_curlhttpsrc = false;
        let p = socks_plan(true);
        for c in [Capability::Lossy, Capability::Dash] {
            let cause = block_cause(&p, c, &caps);
            assert!(cause.contains("SOCKS5"), "capability {c:?}: {cause}");
        }
        // The API transport is unaffected by a missing GStreamer plugin.
        assert!(p.route(Capability::Api, &caps).is_ok());
    }

    #[test]
    fn authenticated_socks5_audio_fails_closed_even_if_the_earlier_guard_is_bypassed() {
        // Pins the release profile, where the `debug_assert!` in the scheme match
        // is compiled out. Without the guard beside it this state would yield a
        // socks5h URI for a gio-backed source instead of a block — a wrong scheme,
        // which is a DNS leak rather than a clean failure.
        let mut caps = HostCaps::assume_all_present();
        caps.has_curlhttpsrc = false;
        let p = socks_plan(true);
        for c in [Capability::Lossy, Capability::Dash] {
            assert_eq!(
                block_cause(&p, c, &caps),
                "authenticated SOCKS5 audio requires the curl source plugin \
                 (curlhttpsrc) — install it and restart SONE, or use a SOCKS5 \
                 proxy that needs no username or password",
                "capability {c:?} must fail closed"
            );
        }
    }

    #[test]
    fn http_with_credentials_needs_curlhttpsrc_for_audio() {
        // Mirror of the SOCKS5 case: both branches must stay reachable and must
        // not share a message, or the SOCKS5 wording silently stops firing.
        let mut caps = HostCaps::assume_all_present();
        caps.has_curlhttpsrc = false;
        let p = authed_plan(3128);
        for c in [Capability::Lossy, Capability::Dash] {
            let cause = block_cause(&p, c, &caps);
            assert!(!cause.contains("SOCKS5"), "capability {c:?}: {cause}");
            assert!(
                cause.contains("curl source plugin"),
                "capability {c:?}: {cause}"
            );
        }
        assert!(p.route(Capability::Api, &caps).is_ok());
    }

    #[test]
    fn socks5_without_credentials_works_without_curlhttpsrc() {
        let mut caps = HostCaps::assume_all_present();
        caps.has_curlhttpsrc = false;
        assert!(socks_plan(false).route(Capability::Lossy, &caps).is_ok());
    }

    #[test]
    fn missing_legacy_demuxer_blocks_dash_but_not_lossy() {
        let mut caps = HostCaps::assume_all_present();
        caps.has_dashdemux = false;
        let p = http_plan(3128);
        let cause = block_cause(&p, Capability::Dash, &caps);
        assert!(cause.contains("adaptive demuxer"), "{cause}");
        assert!(p.route(Capability::Lossy, &caps).is_ok());
        assert!(p.route(Capability::Api, &caps).is_ok());
    }

    // Load-bearing jointly with `curl_seek_version_boundary_is_exact`: the
    // substring assertion below is also satisfied by a constant of (1, 26, 101),
    // which only the boundary test rejects. Deleting either weakens the pair.
    #[test]
    fn old_gstreamer_blocks_lossy_only_when_credentials_are_present() {
        // curlhttpsrc progressive seek is broken below 1.26.10 and it is the only
        // element that can authenticate over a CONNECT tunnel.
        let mut caps = HostCaps::assume_all_present();
        caps.gst_version = (1, 24, 2);

        let with_creds = authed_plan(3128);
        let cause = block_cause(&with_creds, Capability::Lossy, &caps);
        assert!(cause.contains("1.26.10"), "{cause}");
        assert!(cause.contains("1.24.2"), "{cause}");
        assert!(with_creds.route(Capability::Dash, &caps).is_ok());

        let without = http_plan(3128);
        assert!(without.route(Capability::Lossy, &caps).is_ok());
    }

    // The other half of that pair: this is what catches a (1, 26, 101) constant
    // that the substring assertions above would happily accept.
    #[test]
    fn curl_seek_version_boundary_is_exact() {
        // Only the far-away (1,24,2) was covered, so mutating CURL_SEEK_FIXED to
        // (1,26,0) left the suite green. Pin both sides of the real boundary.
        let p = authed_plan(3128);

        let mut just_below = HostCaps::assume_all_present();
        just_below.gst_version = (1, 26, 9);
        let cause = block_cause(&p, Capability::Lossy, &just_below);
        assert!(cause.contains("1.26.9"), "{cause}");

        let mut exactly_fixed = HostCaps::assume_all_present();
        exactly_fixed.gst_version = (1, 26, 10);
        assert!(p.route(Capability::Lossy, &exactly_fixed).is_ok());
    }

    /// The sidecar exists so `main.rs` can decide whether to scrub before
    /// `AppState` — and therefore the decryption key — exists. Everything it
    /// does not strictly need stays in the encrypted file.
    #[test]
    fn sidecar_round_trips_only_enabled_and_type() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = settings("secret-proxy.internal", 3128);
        s.username = Some("bob".into());
        s.password = Some("hunter2".into());
        s.proxy_type = ProxyType::Socks5;

        write_sidecar(dir.path(), &s);
        let raw = std::fs::read_to_string(sidecar_path(dir.path())).unwrap();

        // Nothing secret may leave the encrypted settings file.
        assert!(!raw.contains("secret-proxy.internal"), "{raw}");
        assert!(!raw.contains("bob"), "{raw}");
        assert!(!raw.contains("hunter2"), "{raw}");
        assert!(!raw.contains("3128"), "{raw}");

        assert_eq!(read_sidecar(dir.path()), Some((true, "socks5".to_string())));
    }

    /// Disabled must round-trip as `false`, not merely as "absent". A sidecar
    /// that only ever recorded the enabled case would leave a stale `on` on
    /// disk after the user turns the proxy off, and the next launch would scrub
    /// a host whose own configuration is now the only thing routing it.
    #[test]
    fn turning_the_proxy_off_is_recorded_as_off() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = settings("127.0.0.1", 8080);

        write_sidecar(dir.path(), &s);
        assert_eq!(read_sidecar(dir.path()), Some((true, "http".to_string())));

        s.enabled = false;
        write_sidecar(dir.path(), &s);
        assert_eq!(read_sidecar(dir.path()), Some((false, "http".to_string())));
    }

    /// A first launch, and the common case: no sidecar means nothing is known,
    /// which must read as "not proxying" rather than as a default.
    #[test]
    fn missing_sidecar_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_sidecar(dir.path()), None);
    }

    /// A truncated or hand-edited file must not read as a half-answer. Anything
    /// the writer would not have produced is no answer at all.
    #[test]
    fn a_truncated_sidecar_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(sidecar_path(dir.path()), "on\n").unwrap();
        assert_eq!(read_sidecar(dir.path()), None);
    }

    /// A type this build does not know is not a half-answer to be passed
    /// along: a later task is expected to act on that string.
    #[test]
    fn an_unknown_proxy_type_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(sidecar_path(dir.path()), "off\nbanana\n").unwrap();
        assert_eq!(read_sidecar(dir.path()), None);
    }

    /// Not secret, but it discloses that this user proxies and with what,
    /// beside a settings file encrypted so that a reader of the config
    /// directory learns neither.
    #[test]
    fn the_sidecar_is_owner_only_even_when_it_already_existed() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = sidecar_path(dir.path());

        // A sidecar left by an older build under a loose umask.
        std::fs::write(&path, "on\nhttp\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        write_sidecar(dir.path(), &settings("127.0.0.1", 8080));
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "sidecar is {mode:o}, not 0600");
    }

    /// Stands in for reqwest's `into_proxy_scheme`, which is private and lives
    /// behind a `reqwest::Proxy` this module is not allowed to build. Coarse on
    /// purpose — these tests are about precedence, not about URI parsing — but
    /// it agrees with the real one on every value used below: reqwest rejects
    /// an `ftp://` proxy outright, while a bare word is *accepted* as
    /// `http://<word>`, which is why no test here uses one. `proxy_http.rs`
    /// exercises the real predicate end to end.
    fn parses(uri: &str) -> bool {
        uri.starts_with("http://") || uri.starts_with("https://")
    }

    fn owned(vars: &[(&str, &str)]) -> Vec<(String, String)> {
        vars.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn resolve(vars: &[(&str, &str)]) -> SystemProxyEnv<String> {
        system_proxy_from_env(&owned(vars), |_, uri| parses(uri).then(|| uri.to_string()))
    }

    /// Nothing was scrubbed, so nothing is restored and every consumer keeps
    /// reading the untouched environment itself. The common case.
    #[test]
    fn an_unscrubbed_environment_resolves_to_nothing() {
        assert!(resolve(&[]).is_empty());
        assert_eq!(resolve(&[]), SystemProxyEnv::default());
    }

    /// reqwest 0.11.27's own precedence, reproduced: restoring has to give the
    /// user back what they had, not a policy of our own invention.
    #[test]
    fn uppercase_wins_over_lowercase_for_every_name() {
        let e = resolve(&[
            ("http_proxy", "http://lower:1"),
            ("HTTP_PROXY", "http://upper:1"),
            ("https_proxy", "http://lower:2"),
            ("HTTPS_PROXY", "http://upper:2"),
            ("no_proxy", "lower.example"),
            ("NO_PROXY", "upper.example"),
        ]);
        assert_eq!(e.http.as_deref(), Some("http://upper:1"));
        assert_eq!(e.https.as_deref(), Some("http://upper:2"));
        assert_eq!(e.no_proxy.as_deref(), Some("upper.example"));
    }

    #[test]
    fn lowercase_is_used_when_it_is_the_only_spelling() {
        let e = resolve(&[
            ("http_proxy", "http://lower:1"),
            ("no_proxy", "lower.example"),
        ]);
        assert_eq!(e.http.as_deref(), Some("http://lower:1"));
        assert_eq!(e.no_proxy.as_deref(), Some("lower.example"));
        assert_eq!(e.https, None);
    }

    /// An unparseable uppercase value is not a win, it is a miss: 0.11.27's
    /// `insert_proxy` returns false for anything it cannot turn into a proxy
    /// scheme, so the lowercase spelling is still tried. Getting this wrong
    /// leaves the user with no http proxy at all where they had a working one.
    #[test]
    fn an_unparseable_uppercase_value_falls_through_to_the_lowercase_one() {
        let e = resolve(&[
            ("HTTP_PROXY", "ftp://nope:1"),
            ("http_proxy", "http://ok:1"),
            ("HTTPS_PROXY", "gopher://nope:2"),
            ("https_proxy", "http://ok:2"),
        ]);
        assert_eq!(e.http.as_deref(), Some("http://ok:1"));
        assert_eq!(e.https.as_deref(), Some("http://ok:2"));
    }

    #[test]
    fn an_unparseable_value_with_no_fallback_is_no_proxy() {
        assert!(resolve(&[("HTTP_PROXY", "ftp://nope:1")]).is_empty());
    }

    /// The deliberate mirror of 0.11.27, and the assertion most likely to be
    /// "corrected" by a future reader: `ALL_PROXY` is applied last and
    /// **overwrites** the per-scheme names. reqwest 0.12+ reversed this and the
    /// reversal is saner — but restoring has to reproduce where this user's
    /// traffic was actually going, which with `all_proxy` set was `all:1`.
    #[test]
    fn all_proxy_is_applied_last_and_overwrites_the_per_scheme_names() {
        let e = resolve(&[("ALL_PROXY", "http://all:1")]);
        assert_eq!(e.http.as_deref(), Some("http://all:1"));
        assert_eq!(e.https.as_deref(), Some("http://all:1"));

        let e = resolve(&[("all_proxy", "http://all:1"), ("https_proxy", "http://s:2")]);
        assert_eq!(e.http.as_deref(), Some("http://all:1"));
        assert_eq!(
            e.https.as_deref(),
            Some("http://all:1"),
            "0.11.27 overwrites https_proxy with all_proxy; a per-scheme-wins \
             rule here would route this user somewhere their own configuration \
             never chose"
        );
    }

    /// And uppercase-first applies to the catch-all too, with the lowercase
    /// spelling tried only when the uppercase one is unusable.
    #[test]
    fn the_uppercase_catch_all_wins_and_an_unusable_one_falls_through() {
        let e = resolve(&[
            ("ALL_PROXY", "http://upper:1"),
            ("all_proxy", "http://lower:1"),
        ]);
        assert_eq!(e.http.as_deref(), Some("http://upper:1"));

        let e = resolve(&[
            ("ALL_PROXY", "ftp://nope:1"),
            ("all_proxy", "http://lower:1"),
        ]);
        assert_eq!(e.http.as_deref(), Some("http://lower:1"));
    }

    /// An exported-but-empty variable is how a shell profile disables one.
    /// Treating it as a proxy endpoint would be worse than ignoring it.
    #[test]
    fn empty_and_whitespace_values_are_not_proxies() {
        assert!(resolve(&[("HTTP_PROXY", ""), ("https_proxy", "   ")]).is_empty());
    }

    /// `no_proxy` is chosen on presence, not on content: `NoProxy::from_env`
    /// reads `NO_PROXY` and only falls back when that variable is *unset*, so
    /// an exported-but-empty one suppresses the lowercase spelling. The list
    /// itself is then rejected downstream by `from_string`.
    #[test]
    fn an_exported_but_empty_no_proxy_suppresses_the_lowercase_one() {
        let e = resolve(&[("NO_PROXY", ""), ("no_proxy", "lower.example")]);
        assert_eq!(e.no_proxy.as_deref(), Some(""));
    }

    /// What this pins, and all it pins: `scrubbed_env()` reads back as an empty
    /// slice when `remember_scrubbed_env` was never called, rather than
    /// panicking or standing in for a live environment read.
    ///
    /// It cannot pin more. `SCRUBBED_ENV` is a process-wide `OnceLock` that no
    /// test can set — the first capture is the only true one, by design — so
    /// this only ever exercises the default arm, and the resolution it drives
    /// is `system_proxy_from_env(&[])`, which the cases above already cover
    /// against explicit inputs. A non-empty capture is tested by handing those
    /// cases their variables directly.
    #[test]
    fn the_unset_capture_reads_back_as_an_empty_slice() {
        assert!(scrubbed_env().is_empty());
        let e = system_proxy_from_env(scrubbed_env(), |_, uri| {
            parses(uri).then(|| uri.to_string())
        });
        assert!(e.is_empty());
    }

    /// The scheme reaches the parser, and reaches it correctly. reqwest builds
    /// a different proxy object per scheme from the same string, so a resolver
    /// that passed the wrong one would attach an https proxy to http traffic —
    /// invisible in every precedence assertion above, because those only look
    /// at which *value* landed in which slot.
    #[test]
    fn each_slot_is_parsed_for_its_own_scheme() {
        let seen = std::cell::RefCell::new(Vec::new());
        let vars = owned(&[
            ("HTTP_PROXY", "http://h:1"),
            ("HTTPS_PROXY", "http://s:2"),
            ("ALL_PROXY", "http://a:3"),
        ]);
        let _ = system_proxy_from_env(&vars, |scheme, uri| {
            seen.borrow_mut().push((scheme, uri.to_string()));
            Some(uri.to_string())
        });

        assert_eq!(
            seen.into_inner(),
            vec![
                (EnvScheme::Http, "http://h:1".to_string()),
                (EnvScheme::Https, "http://s:2".to_string()),
                (EnvScheme::Http, "http://a:3".to_string()),
                (EnvScheme::Https, "http://a:3".to_string()),
            ],
            "each value must be parsed once, for the slot it fills"
        );
    }

    /// No value is parsed twice. A second parse of a `socks5h://` value is a
    /// second `getaddrinfo`, and this function used to hand back strings that
    /// the caller then re-parsed to build the proxy objects.
    #[test]
    fn no_captured_value_is_parsed_more_than_once_per_slot() {
        let calls = std::cell::RefCell::new(Vec::new());
        let vars = owned(&[
            ("HTTP_PROXY", "http://h:1"),
            ("http_proxy", "http://h:2"),
            ("HTTPS_PROXY", "http://s:1"),
        ]);
        let _ = system_proxy_from_env(&vars, |scheme, uri| {
            calls.borrow_mut().push((scheme, uri.to_string()));
            Some(uri.to_string())
        });

        let calls = calls.into_inner();
        let mut unique = calls.clone();
        unique.dedup();
        assert_eq!(calls, unique, "a value was parsed twice: {calls:?}");
        // The lowercase fallback is never even looked at once the uppercase
        // spelling lands.
        assert_eq!(calls.len(), 2, "{calls:?}");
    }

    /// Both spellings, because the consumers disagree about which they read:
    /// libcurl takes lowercase `http_proxy` only but uppercase for the rest,
    /// while reqwest and libproxy read either. Capturing one case leaves the
    /// other unrecoverable for the stage that scrubs it.
    #[test]
    fn the_capture_list_covers_both_cases_of_all_four_names() {
        for name in ["http_proxy", "https_proxy", "all_proxy", "no_proxy"] {
            assert!(PROXY_ENV_VARS.contains(&name), "missing {name}");
            let upper = name.to_uppercase();
            assert!(PROXY_ENV_VARS.contains(&upper.as_str()), "missing {upper}");
        }
    }

    /// The scrub is the bypass list and nothing else, in both spellings.
    ///
    /// Widening it is the regression this pins. Removing a per-scheme variable
    /// before the stage that sets the corresponding explicit proxy has landed
    /// takes the WebView surfaces — and SOCKS5 audio, which `audio.rs` never
    /// routed through `http_proxy` — from proxied by the user's own ambient
    /// configuration to direct, from the real IP. Narrowing it is the other
    /// failure: without `no_proxy` gone, `curlhttpsrc` forwards it as
    /// `CURLOPT_NOPROXY` and bypasses the proxy property outright (F6).
    #[test]
    fn the_scrub_removes_the_bypass_list_and_nothing_else() {
        assert_eq!(
            SCRUBBED_PROXY_ENV_VARS.len(),
            2,
            "the startup scrub grew past the bypass list: {SCRUBBED_PROXY_ENV_VARS:?}"
        );
        for name in ["no_proxy", "NO_PROXY"] {
            assert!(SCRUBBED_PROXY_ENV_VARS.contains(&name), "missing {name}");
        }
        for name in [
            "http_proxy",
            "HTTP_PROXY",
            "https_proxy",
            "HTTPS_PROXY",
            "all_proxy",
            "ALL_PROXY",
        ] {
            assert!(
                !SCRUBBED_PROXY_ENV_VARS.contains(&name),
                "{name} is scrubbed, but nothing in this stage sets the explicit \
                 proxy that would replace it — removing it egresses direct"
            );
        }
    }

    /// The legacy shape, and only the legacy shape.
    ///
    /// `enabled: true, host: "", port: 0` is what the old `build_http_client`
    /// silently treated as no proxy, so it exists on disk. Under `plan()` it is
    /// `PortZero`, which blocks everything including the login screen. The
    /// migration must catch every spelling of "incomplete" — and must not
    /// widen into disabling proxies that are merely wrong, which stay blocked.
    #[test]
    fn an_enabled_proxy_with_no_host_or_port_is_migrated_off() {
        for (host, port) in [("", 0u16), ("", 3128), ("127.0.0.1", 0), ("   ", 8080)] {
            let mut s = settings(host, port);
            assert!(
                migrate_incomplete_proxy(&mut s),
                "{host:?}:{port} should have migrated"
            );
            assert!(!s.enabled);
            assert!(
                matches!(
                    plan(&s, &HostCaps::assume_all_present()),
                    Ok(ProxyPlan::Direct)
                ),
                "a migrated proxy must plan as Direct, not block the app"
            );
        }
    }

    #[test]
    fn a_complete_or_disabled_proxy_is_left_alone() {
        let mut s = settings("127.0.0.1", 3128);
        assert!(!migrate_incomplete_proxy(&mut s));
        assert!(s.enabled);

        // Invalid, not incomplete: fail-closed still applies to these.
        let mut s = settings("http://proxy.example", 3128);
        assert!(!migrate_incomplete_proxy(&mut s));
        assert!(s.enabled);

        let mut s = settings("", 0);
        s.enabled = false;
        assert!(!migrate_incomplete_proxy(&mut s));
        assert!(!s.enabled);
    }

    /// Everything that is removed must have been captured, or the `Direct`
    /// route hands back an environment missing the value it just deleted.
    #[test]
    fn everything_scrubbed_is_also_captured() {
        for name in SCRUBBED_PROXY_ENV_VARS {
            assert!(
                PROXY_ENV_VARS.contains(&name),
                "{name} is scrubbed but never captured, so restoring cannot \
                 reproduce the user's own routing"
            );
        }
    }

    // ---- ProxyStatus -----------------------------------------------------
    //
    // The serialized shape is a contract with the settings screen, so it is
    // asserted as JSON rather than by matching the Rust enum: a rename or a
    // change of representation would be invisible to a `matches!` test and
    // would silently break the UI.

    #[test]
    fn a_disabled_proxy_is_off_not_active() {
        let mut s = settings("127.0.0.1", 8080);
        s.enabled = false;
        let st = ProxyStatus::evaluate(&s, &HostCaps::assume_all_present());
        assert_eq!(st, ProxyStatus::Off);
        assert_eq!(
            serde_json::to_value(&st).unwrap(),
            serde_json::json!({ "state": "off" })
        );
    }

    #[test]
    fn a_usable_plan_is_active_with_nothing_degraded() {
        let st = ProxyStatus::evaluate(
            &settings("proxy.example", 3128),
            &HostCaps::assume_all_present(),
        );
        assert_eq!(
            serde_json::to_value(&st).unwrap(),
            serde_json::json!({ "state": "active", "degraded": [] })
        );
    }

    #[test]
    fn unplannable_settings_are_blocked_and_carry_the_reason() {
        // The reason is the whole value of this variant: "connection failed" is
        // what the UI said before, and it named no field.
        let st = ProxyStatus::evaluate(&settings("127.0.0.1", 0), &HostCaps::assume_all_present());
        assert_eq!(
            serde_json::to_value(&st).unwrap(),
            serde_json::json!({ "state": "blocked", "reason": "proxy port must not be 0" })
        );

        let st = ProxyStatus::evaluate(
            &settings("bad host!", 3128),
            &HostCaps::assume_all_present(),
        );
        let v = serde_json::to_value(&st).unwrap();
        assert_eq!(v["state"], "blocked");
        assert!(
            v["reason"]
                .as_str()
                .unwrap()
                .starts_with("invalid proxy host"),
            "{v}"
        );
    }

    /// The block a `PlanError` cannot see, and the one that strands a user.
    ///
    /// A SOCKS5 proxy whose host does not resolve plans fine and fails while
    /// the client is being built. Save it, log out, and login is refused with
    /// `ProxyBlocked` while the settings screen sits behind the login — so the
    /// pre-login banner has to render for this, which means the status has to
    /// report it.
    #[test]
    fn a_cell_that_cannot_hand_out_a_client_is_blocked_whatever_the_plan_says() {
        let caps = HostCaps::assume_all_present();
        let s = settings("proxy.example", 3128);
        assert!(matches!(
            ProxyStatus::observed(&s, &caps, None, false),
            ProxyStatus::Active { .. }
        ));

        let st = ProxyStatus::observed(
            &s,
            &caps,
            Some("proxy unusable (socks5h://x:1): oops"),
            false,
        );
        assert_eq!(
            serde_json::to_value(&st).unwrap(),
            serde_json::json!({
                "state": "blocked",
                "reason": "proxy unusable (socks5h://x:1): oops"
            })
        );
    }

    /// Even with the proxy off. The cell is what egresses: if it holds no
    /// client, nothing is getting out, and saying `Off` would render no banner
    /// and no way to act.
    #[test]
    fn a_blocked_cell_outranks_a_disabled_proxy() {
        let mut s = settings("127.0.0.1", 8080);
        s.enabled = false;
        let st = ProxyStatus::observed(
            &s,
            &HostCaps::assume_all_present(),
            Some("no client"),
            false,
        );
        assert_eq!(
            st,
            ProxyStatus::Blocked {
                reason: "no client".into()
            }
        );
    }

    /// The failure the `Blocked` variant does not cover, and the one manual
    /// testing actually hit.
    ///
    /// `nope.invalid:8080` over `http://` plans fine and builds fine — reqwest
    /// defers an http proxy's name lookup to the first request — so the cell
    /// hands out a client and every request dies in transit. Before this
    /// variant existed the status said `active`, no banner rendered, and the
    /// user saw a raw DNS error that named the origin they were trying to
    /// reach rather than the proxy that never carried them there.
    #[test]
    fn a_proxied_request_that_got_no_answer_is_unreachable_and_names_the_proxy() {
        let caps = HostCaps::assume_all_present();
        let s = settings("nope.invalid", 8080);
        let st = ProxyStatus::observed(&s, &caps, None, true);
        assert_eq!(
            serde_json::to_value(&st).unwrap(),
            // `host:port` and nothing else. It is the whole of what is known,
            // and it is what the user typed, so it is what they can act on.
            serde_json::json!({ "state": "unreachable", "endpoint": "nope.invalid:8080" })
        );
    }

    /// The honesty rule, in the one place it can be broken.
    ///
    /// An offline machine fails every request exactly the same way. With no
    /// proxy in the path there is nothing to attribute the failure to, so the
    /// status must stay `Off` and the failure must surface as the ordinary
    /// network error it is.
    #[test]
    fn the_same_failure_with_the_proxy_off_is_not_the_proxys_fault() {
        let caps = HostCaps::assume_all_present();
        let mut s = settings("127.0.0.1", 8080);
        s.enabled = false;
        assert_eq!(
            ProxyStatus::observed(&s, &caps, None, true),
            ProxyStatus::Off
        );
    }

    /// Ordering, because the two states answer different questions. `Blocked`
    /// means nothing was ever sent; `Unreachable` means something was sent and
    /// died on the way. A cell that cannot hand out a client cannot have sent
    /// the request whose silence is being reported, so the block is the truth.
    #[test]
    fn a_blocked_cell_outranks_an_unanswered_request() {
        let caps = HostCaps::assume_all_present();
        let st = ProxyStatus::observed(
            &settings("proxy.example", 3128),
            &caps,
            Some("no client"),
            true,
        );
        assert_eq!(
            st,
            ProxyStatus::Blocked {
                reason: "no client".into()
            }
        );
    }

    /// Unplannable settings too: `plan()` is consulted before the mark, so a
    /// bad field still reports the field rather than a silent proxy.
    #[test]
    fn unplannable_settings_outrank_an_unanswered_request() {
        let st = ProxyStatus::observed(
            &settings("127.0.0.1", 0),
            &HostCaps::assume_all_present(),
            None,
            true,
        );
        assert_eq!(
            serde_json::to_value(&st).unwrap(),
            serde_json::json!({ "state": "blocked", "reason": "proxy port must not be 0" })
        );
    }

    /// One answered request is enough, and no restart is involved: the cell
    /// stores the last outcome, so `false` here is the whole of the recovery.
    #[test]
    fn an_answered_request_puts_the_status_back_to_active() {
        let caps = HostCaps::assume_all_present();
        let s = settings("nope.invalid", 8080);
        assert!(matches!(
            ProxyStatus::observed(&s, &caps, None, true),
            ProxyStatus::Unreachable { .. }
        ));
        assert!(matches!(
            ProxyStatus::observed(&s, &caps, None, false),
            ProxyStatus::Active { .. }
        ));
    }

    /// The endpoint is built by `authority()`, so an IPv6 proxy reads back as
    /// something a user can paste, not as `2001:db8::1:8080`.
    #[test]
    fn the_reported_endpoint_brackets_an_ipv6_proxy() {
        let caps = HostCaps::assume_all_present();
        let st = ProxyStatus::observed(&settings("2001:db8::1", 8080), &caps, None, true);
        assert_eq!(
            st,
            ProxyStatus::Unreachable {
                endpoint: "[2001:db8::1]:8080".into()
            }
        );
        // And `Direct` names no endpoint at all, which is what keeps the
        // variant unreachable from the `Off` path.
        assert_eq!(ProxyPlan::Direct.endpoint(), None);
    }

    #[test]
    fn a_missing_dash_demuxer_degrades_one_capability_rather_than_blocking() {
        // The regression this guards: reporting a global `Blocked` banner for a
        // proxy that serves the API, the webview and lossy audio perfectly well.
        let caps = HostCaps {
            has_dashdemux: false,
            ..HostCaps::assume_all_present()
        };
        let st = ProxyStatus::evaluate(&settings("proxy.example", 3128), &caps);
        assert_eq!(
            serde_json::to_value(&st).unwrap(),
            serde_json::json!({ "state": "active", "degraded": ["dash"] })
        );
    }

    #[test]
    fn an_authenticated_proxy_on_an_old_gstreamer_degrades_audio_only() {
        let mut s = settings("proxy.example", 3128);
        s.username = Some("u".into());
        s.password = Some("p".into());
        let caps = HostCaps {
            has_dashdemux: false,
            has_curlhttpsrc: false,
            gst_version: (1, 24, 0),
        };
        let st = ProxyStatus::evaluate(&s, &caps);
        let v = serde_json::to_value(&st).unwrap();
        assert_eq!(v["state"], "active");
        // Both audio tiers refuse; the API and the webview still work, so this
        // is never a global block.
        assert_eq!(v["degraded"], serde_json::json!(["lossy", "dash"]));
    }

    #[test]
    fn degraded_is_capabilities_not_prose() {
        // Serializing as lowercase identifiers is what lets the UI attach a
        // per-feature notice; a sentence would force it to match on text.
        let st = ProxyStatus::Active {
            degraded: Capability::ALL.to_vec(),
        };
        assert_eq!(
            serde_json::to_value(&st).unwrap()["degraded"],
            serde_json::json!(["api", "lossy", "dash", "webview"])
        );
    }
}

#[cfg(test)]
mod props {
    use super::*;
    use crate::{ProxySettings, ProxyType};
    use proptest::prelude::*;

    /// Mixes shapes that each reach a different branch of `validate_host`. An
    /// arbitrary-Unicode host alone is almost never accepted, which leaves the
    /// accept path and the bracketing in `authority()` untested.
    fn any_host() -> impl Strategy<Value = String> {
        prop_oneof![
            // Reaches the accept path.
            4 => "[a-z][a-z0-9._-]{0,20}",
            // Reaches the IPv6 accept branch, and the single-bracketing in `authority`.
            3 => any::<std::net::Ipv6Addr>().prop_map(|a| a.to_string()),
            // Reaches `BracketedHost`: the input that double-brackets a URI and
            // core-dumps souphttpsrc if it is ever let through.
            3 => any::<std::net::Ipv6Addr>().prop_map(|a| format!("[{a}]")),
            // Reaches `EmbeddedPort`.
            3 => (any::<std::net::Ipv4Addr>(), any::<u16>()).prop_map(|(a, p)| format!("{a}:{p}")),
            // Broad adversarial coverage: brackets, colons, percent signs,
            // delimiters, non-ASCII and whitespace. Weighted to roughly a third
            // of generated hosts — both historical crashes came from here, and
            // starving this arm to steer cases at the structured shapes is what
            // would let the next one through.
            7 => "[\\PC]{0,40}",
        ]
    }

    fn any_settings() -> impl Strategy<Value = ProxySettings> {
        (
            any::<bool>(),
            any::<bool>(),
            any_host(),
            any::<u16>(),
            proptest::option::of("[\\PC]{0,20}"),
            proptest::option::of("[\\PC]{0,20}"),
        )
            .prop_map(
                |(enabled, socks, host, port, username, password)| ProxySettings {
                    enabled,
                    proxy_type: if socks {
                        ProxyType::Socks5
                    } else {
                        ProxyType::Http
                    },
                    host,
                    port,
                    username,
                    password,
                },
            )
    }

    proptest! {
        #[test]
        fn plan_never_panics_and_routes_are_credential_free(s in any_settings()) {
            let caps = HostCaps::assume_all_present();
            if let Ok(p) = plan(&s, &caps) {
                for c in [Capability::Api, Capability::Lossy, Capability::Dash, Capability::Webview] {
                    if let Ok(Route::Via { uri, .. }) = p.route(c, &caps) {
                        prop_assert!(!uri.contains('@'), "uri leaked a delimiter: {uri}");
                        // A one- or two-character credential collides with a port
                        // digit or a `:`/`/` delimiter by coincidence, not by
                        // leaking, so only a credential long enough to be
                        // unambiguous proves anything. The `@` check above stays
                        // unconditional: it cannot false-positive. A non-ASCII
                        // credential needs no length floor at all: the host is
                        // ASCII-only by `validate_host`, so it cannot collide.
                        if let Some(u) = s.username.as_deref() {
                            let u = u.trim();
                            if !u.is_ascii() || u.len() >= 4 {
                                prop_assert!(!uri.contains(u), "uri leaked the username: {uri}");
                            }
                        }
                        if let Some(pw) = s.password.as_deref() {
                            if !pw.is_ascii() || pw.len() >= 4 {
                                prop_assert!(!uri.contains(pw), "uri leaked the password: {uri}");
                            }
                        }
                    }
                }
            }
        }

        #[test]
        fn accepted_uris_are_single_bracketed_and_end_in_the_given_port(s in any_settings()) {
            let caps = HostCaps::assume_all_present();
            if let Ok(p @ (ProxyPlan::Http { .. } | ProxyPlan::Socks5 { .. })) = plan(&s, &caps) {
                if let Ok(Route::Via { uri, .. }) = p.route(Capability::Api, &caps) {
                    prop_assert!(!uri.contains("[["), "double bracketed: {uri}");
                    prop_assert!(!uri.contains("]]"), "double bracketed: {uri}");
                    prop_assert!(
                        uri.ends_with(&format!(":{}", s.port)),
                        "port not preserved: {uri}"
                    );
                }
            }
        }

        #[test]
        fn enabled_settings_never_silently_become_direct(s in any_settings()) {
            // The original fail-open: `enabled` with unusable input resolved to Direct.
            let caps = HostCaps::assume_all_present();
            if s.enabled {
                prop_assert!(!matches!(plan(&s, &caps), Ok(ProxyPlan::Direct)));
            }
        }
    }
}
