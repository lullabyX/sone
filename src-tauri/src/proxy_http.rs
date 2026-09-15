//! The one HTTP client SONE's reqwest consumers share.
//!
//! Holding a `Result` rather than a `Client` is deliberate: there is no way to
//! obtain a client when the plan is blocked, so no consumer can fall back to a
//! direct one. reqwest auto-detects the system proxy, so a client "without a
//! proxy" would egress.

use crate::proxy::{
    BlockReason, Capability, EnvScheme, HostCaps, ProxyPlan, Route, SystemProxyEnv,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

/// Captured system proxies, already built. Parsing a value and constructing
/// its proxy object are one step, so nothing is parsed twice.
type CapturedProxies = SystemProxyEnv<reqwest::Proxy>;

pub fn build_client(p: &ProxyPlan, env: &HostCaps) -> Result<reqwest::Client, BlockReason> {
    build_client_with(p, env, captured_system_proxy)
}

/// The system's proxy configuration as it stood before startup scrubbed it.
///
/// The parser is supplied here rather than inside `proxy.rs` because building a
/// `reqwest::Proxy` is confined to this file. `Proxy::http`/`Proxy::https` run
/// the same `into_proxy_scheme` that reqwest's own environment detection uses,
/// so a value accepted here would have been accepted by it too.
///
/// Never call this speculatively: for a `socks5h://` value `into_proxy_scheme`
/// resolves the proxy host, so this can block on `getaddrinfo`. It is reached
/// only from the `Direct` arm of `build_client_with`, where the result is
/// actually used.
fn captured_system_proxy() -> CapturedProxies {
    crate::proxy::system_proxy_from_env(crate::proxy::scrubbed_env(), |scheme, uri| {
        let built = match scheme {
            EnvScheme::Http => reqwest::Proxy::http(uri),
            EnvScheme::Https => reqwest::Proxy::https(uri),
        };
        match built {
            Ok(obj) => Some(obj),
            Err(e) => {
                log::warn!("[proxy] captured system proxy unusable ({uri}): {e}");
                None
            }
        }
    })
}

/// The system's configuration arrives as a thunk, for two reasons.
///
/// It must be *lazy*: producing it parses captured URIs, and parsing a
/// `socks5h://` one resolves its host. `AppState::new` builds a client
/// synchronously inside Tauri's `setup` closure, so evaluating it eagerly would
/// stall startup on a `getaddrinfo` for a value the proxied path discards
/// unused — and the ordinary configuration, sidecar on and settings on, is
/// exactly that path. Only the `Direct` arm needs it.
///
/// (Settings that cannot be planned never arrive here at all: `from_settings`
/// blocks the cell before building anything. And `route` cannot currently fail
/// for `Capability::Api` — its refusals are all audio capabilities — so `Via`
/// is the one path that would have paid for an eager capture.)
///
/// And it is a parameter rather than a global read so the `Direct` behaviour
/// can be tested at all: the real capture is a process-wide cell that can only
/// be written once, before any test runs.
fn build_client_with(
    p: &ProxyPlan,
    env: &HostCaps,
    system: impl FnOnce() -> CapturedProxies,
) -> Result<reqwest::Client, BlockReason> {
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(30));

    match p.route(Capability::Api, env)? {
        // Direct means the system's own configuration applies. Ordinarily
        // reqwest auto-detects that from the environment and there is nothing
        // to do — but if SONE scrubbed those variables at startup, which it
        // does whenever the proxy was on at launch, that environment is now
        // empty and auto-detection finds nothing.
        //
        // That is the mid-session *disable*: a user whose shell exports
        // `http_proxy` launches with SONE's proxy on, we remove it, they turn
        // SONE's proxy off — and without this their traffic would go direct
        // instead of through the proxy their system is configured for. We
        // destroyed the information `Direct` depends on, so we hand it back.
        Route::NoProxy => builder = restore_system_proxy(builder, system()),
        Route::Via { uri, creds } => {
            // Credentials never travel in the URI: `Route::Via` keeps them
            // apart and `basic_auth` is the only thing that reunites them.
            let mut obj = reqwest::Proxy::all(&uri)
                .map_err(|e| BlockReason::new(format!("proxy unusable ({uri}): {e}")))?;
            if let Some(c) = creds {
                obj = obj.basic_auth(&c.user, &c.pass);
            }
            builder = builder.proxy(obj);
        }
    }

    builder
        .build()
        .map_err(|e| BlockReason::new(format!("could not build HTTP client: {e}")))
}

/// Re-attach the system proxy configuration SONE removed from the environment.
///
/// Only reached on the `Direct` route — while SONE is proxying, its own plan is
/// the whole answer and the captured configuration must stay out of it.
///
/// A captured value that reqwest rejects is logged and skipped rather than
/// blocking: it would have been ignored by auto-detection too, so refusing to
/// build a client over it would turn a malformed shell variable into a dead
/// app.
fn restore_system_proxy(
    mut builder: reqwest::ClientBuilder,
    system: CapturedProxies,
) -> reqwest::ClientBuilder {
    if system.is_empty() {
        return builder;
    }
    let bypass = system
        .no_proxy
        .as_deref()
        .and_then(reqwest::NoProxy::from_string);

    // The objects arrive built: `system_proxy_from_env` parsed each captured
    // value exactly once, for the scheme it fills. Re-parsing them here would
    // mean a second `getaddrinfo` for every socks value.
    for obj in [system.http, system.https].into_iter().flatten() {
        builder = builder.proxy(obj.no_proxy(bypass.clone()));
    }
    builder
}

/// Did this request fail before any answer came back?
///
/// reqwest's own kinds decide it, never the message text. `Kind::Request` —
/// what `is_request()` reports — is precisely "something went wrong while
/// sending": the proxy's own DNS lookup, the TCP connect to it, the CONNECT
/// tunnel, or a timeout before the response head arrived. `is_connect()` and a
/// pre-head `is_timeout()` are refinements of it and are named here for the
/// reader, not because they add cases.
///
/// The excluded kinds are the ones that *prove* the far side answered, and
/// they are excluded explicitly so a future reqwest that widens a flag cannot
/// quietly pull them in. A body or decode failure — including a timeout partway
/// through the body — happened after the response head arrived. A status error
/// is not here at all: reqwest hands a 401 or a 404 back as `Ok`, which is why
/// an origin refusing SONE can never be read as a proxy that is not answering.
pub fn is_transport_failure(e: &reqwest::Error) -> bool {
    if e.is_body() || e.is_decode() || e.is_status() || e.is_redirect() {
        return false;
    }
    e.is_request() || e.is_connect() || e.is_timeout()
}

/// A claimed position in the cell's write order.
///
/// A newtype rather than a bare `u64` so the ordering cannot be handed a
/// number that was never claimed — the whole value of the counter is that
/// every writer's position came from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Generation(u64);

/// How many *consecutive* unanswered requests it takes before the status flips.
///
/// One is not enough, and the asymmetry is deliberate. The recovery action this
/// state offers is "turn the proxy off", which removes containment — the one
/// thing this whole design exists to prevent — so it must not be put in front
/// of a user by a two-second wifi drop. Nothing clears the count but an
/// answered request, and `get_proxy_status` deliberately sends nothing, so a
/// single blip would otherwise leave a standing invitation to disable the proxy
/// long after the network came back.
///
/// Two is the smallest number that requires the failure to still be there when
/// the app next tries, which is the weakest form of "this is not transient"
/// that costs the user nothing.
const UNANSWERED_THRESHOLD: u32 = 2;

/// The cell's contents, read and written as one.
///
/// `unanswered` lives in here rather than beside it because it is only
/// meaningful *about* a particular client: pairing them under one lock is what
/// lets `client_at` hand out a client and the generation it belongs to with no
/// window in between, and `observe_at` discard an observation whose client the
/// cell has already replaced.
struct Cell {
    /// The generation that produced the current state.
    generation: Generation,
    state: Result<reqwest::Client, BlockReason>,
    /// Consecutive requests through `state` that got no answer. Reset by any
    /// answered request, and by replacing `state` at all.
    unanswered: u32,
}

#[derive(Clone)]
pub struct ProxiedHttp {
    cell: Arc<RwLock<Cell>>,
    /// Dispenses a generation to each writer BEFORE it starts building, so
    /// "newest" means the newest caller rather than whichever build happened to
    /// finish last. A slow build must never resurrect the settings it replaced.
    next: Arc<AtomicU64>,
}

impl ProxiedHttp {
    fn wrap(state: Result<reqwest::Client, BlockReason>) -> Self {
        Self {
            cell: Arc::new(RwLock::new(Cell {
                generation: Generation(0),
                state,
                unanswered: 0,
            })),
            next: Arc::new(AtomicU64::new(1)),
        }
    }

    pub fn from_plan(p: &ProxyPlan, env: &HostCaps) -> Self {
        Self::wrap(build_client(p, env))
    }

    /// A cell that can never hand out a client. Used where the settings do not
    /// even form a plan: the alternative — treating an unplannable proxy as
    /// `Direct` — is the silent downgrade this module exists to prevent.
    pub fn blocked(cause: impl Into<String>) -> Self {
        Self::wrap(Err(BlockReason::new(cause)))
    }

    /// The cell for a settings value. The single place that decides what an
    /// unplannable proxy means, so neither startup nor a settings save can
    /// drift back to `Direct`.
    pub fn from_settings(s: &crate::ProxySettings, env: &HostCaps) -> Self {
        match crate::proxy::plan(s, env) {
            Ok(p) => Self::from_plan(&p, env),
            Err(e) => {
                log::error!("proxy settings unusable, blocking all HTTP: {e}");
                Self::blocked(e.to_string())
            }
        }
    }

    /// Blocked plans return `Err`; there is no proxy-less fallback.
    pub fn client(&self) -> Result<reqwest::Client, BlockReason> {
        self.read().state.clone()
    }

    /// Swap in the client for a new plan. Blocking: `build_client` may resolve
    /// the proxy host, so call it off the async runtime (`spawn_blocking`).
    ///
    /// `Err` is *this* caller's own build outcome, not the cell's. It stays
    /// true even when a newer caller's generation wins the store below, so a
    /// caller is told what its own settings did rather than what someone
    /// else's did — which is what reading the cell back would report.
    pub fn replace(&self, p: &ProxyPlan, env: &HostCaps) -> Result<(), BlockReason> {
        self.replace_at(self.claim(), p, env)
    }

    /// `replace` with the position already claimed. See `claim`.
    pub fn replace_at(
        &self,
        generation: Generation,
        p: &ProxyPlan,
        env: &HostCaps,
    ) -> Result<(), BlockReason> {
        // Deliberately outside every lock: this can block on `getaddrinfo`, and
        // a reader or a concurrent `block` must never wait on that.
        let built = build_client(p, env);
        let outcome = match &built {
            Ok(_) => Ok(()),
            Err(e) => Err(e.clone()),
        };
        self.store(generation, built);
        outcome
    }

    /// Block the cell outright, for settings that do not form a plan at all.
    pub fn block(&self, cause: impl Into<String>) {
        self.block_at(self.claim(), cause);
    }

    /// `block` with the position already claimed. See `claim`.
    fn block_at(&self, generation: Generation, cause: impl Into<String>) {
        self.store(generation, Err(BlockReason::new(cause)));
    }

    /// Apply a settings value to the live cell. Blocking, for the same reason
    /// as `replace`.
    ///
    /// `Err` means egress is now blocked, and carries why. Both ways of
    /// failing arrive here: settings that form no plan at all, and a plan
    /// whose client cannot be built (SOCKS5 resolves the proxy host eagerly,
    /// so `plan` cannot see that one coming).
    pub fn apply(&self, s: &crate::ProxySettings, env: &HostCaps) -> Result<(), BlockReason> {
        self.apply_at(self.claim(), s, env)
    }

    /// `apply` with the position already claimed.
    ///
    /// This is what lets a caller that also writes to disk put its claim next
    /// to the write instead of next to the build — see
    /// `commands::utility::persist_then_reconfigure`, where the build happens
    /// on a blocking pool whose dispatch order is a scheduler decision.
    pub fn apply_at(
        &self,
        generation: Generation,
        s: &crate::ProxySettings,
        env: &HostCaps,
    ) -> Result<(), BlockReason> {
        match crate::proxy::plan(s, env) {
            Ok(p) => self.replace_at(generation, &p, env),
            Err(e) => {
                log::error!("proxy settings unusable, blocking all HTTP: {e}");
                let cause = e.to_string();
                self.block_at(generation, cause.clone());
                Err(BlockReason::new(cause))
            }
        }
    }

    /// The client and the generation it belongs to, read together.
    ///
    /// Callers that will report what the request did must take both from here,
    /// never a bare `client()` plus a separate generation read: the pair is
    /// what makes `observe_at` able to tell "this request used the client the
    /// cell still holds" from "this request used the one it replaced".
    pub fn client_at(&self) -> (Generation, Result<reqwest::Client, BlockReason>) {
        let c = self.read();
        (c.generation, c.state.clone())
    }

    /// Record what a request did, and hand the outcome straight back.
    ///
    /// `generation` must be the one `client_at` returned beside the client that
    /// made the request. An observation about a client the cell has since
    /// replaced is dropped, because the two failure modes it could otherwise
    /// produce are both lies: a slow failure through the *old* proxy landing
    /// after a reconfiguration would be counted against the new one, and — the
    /// worse direction — a new client's success followed by an old client's
    /// failure would leave a freshly saved, working proxy reported as
    /// unreachable under its own name.
    ///
    /// An answered request zeroes the count outright, so recovery needs one
    /// request and no restart, while raising the state needs
    /// `UNANSWERED_THRESHOLD` in a row.
    ///
    /// Nothing here changes what the caller gets. It cannot retry, cannot
    /// unwrap a block, and cannot reach the client; a request that failed
    /// through the proxy stays failed.
    pub fn observe_at<T>(
        &self,
        generation: Generation,
        outcome: Result<T, reqwest::Error>,
    ) -> Result<T, reqwest::Error> {
        let mut c = self.write();
        if c.generation == generation {
            c.unanswered = match outcome.as_ref().err() {
                Some(e) if is_transport_failure(e) => c.unanswered.saturating_add(1),
                _ => 0,
            };
        }
        drop(c);
        outcome
    }

    /// Whether enough consecutive requests got no answer to say so out loud.
    /// Meaningless on its own — only `ProxyStatus::observed` may read it, and
    /// only after it has established that a proxy is actually in the path.
    pub fn unreachable(&self) -> bool {
        self.read().unanswered >= UNANSWERED_THRESHOLD
    }

    /// Claim a position in the write order. Must happen before the build,
    /// never after — and, for a caller that also persists, next to the persist
    /// rather than next to the build.
    pub fn claim(&self) -> Generation {
        Generation(self.next.fetch_add(1, Ordering::SeqCst))
    }

    /// Read through a poisoned lock rather than around it: a panic elsewhere
    /// must not downgrade egress by substituting a fresh, unproxied client, and
    /// must not strand the cell on stale settings either.
    fn read(&self) -> std::sync::RwLockReadGuard<'_, Cell> {
        self.cell.read().unwrap_or_else(|p| p.into_inner())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, Cell> {
        self.cell.write().unwrap_or_else(|p| p.into_inner())
    }

    fn store(&self, generation: Generation, built: Result<reqwest::Client, BlockReason>) {
        let mut c = self.write();
        // The whole point. Without this comparison a slow build started under
        // the OLD settings lands last and wins, so the cell disagrees with what
        // the user saved — including the enable -> disable -> enable case, where
        // the loser's client carries no proxy at all.
        if generation >= c.generation {
            // A client that has sent nothing has produced no evidence. Carrying
            // the old count across would report the previous proxy's silence
            // against the one the user just saved.
            *c = Cell {
                generation,
                state: built,
                unanswered: 0,
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::{plan, HostCaps, ProxyPlan};
    use crate::{ProxySettings, ProxyType};

    fn enabled(host: &str, port: u16) -> ProxySettings {
        ProxySettings {
            enabled: true,
            proxy_type: ProxyType::Http,
            host: host.to_string(),
            port,
            username: None,
            password: None,
        }
    }

    /// `Capability::Api` spells SOCKS5 as `socks5h`, and that is the scheme
    /// reqwest resolves eagerly. See `unresolvable_proxy_host_*` below.
    fn enabled_socks(host: &str, port: u16) -> ProxySettings {
        ProxySettings {
            proxy_type: ProxyType::Socks5,
            ..enabled(host, port)
        }
    }

    /// The real parser, not the stand-in `proxy.rs` tests use: an unparseable
    /// uppercase value must fall through to the lowercase one, exactly as
    /// reqwest 0.11.27's own detection would have. Getting this wrong leaves
    /// the user with no http proxy where they had a working one.
    #[test]
    fn the_real_parser_falls_through_from_an_unparseable_uppercase_value() {
        // `ftp://` is genuinely rejected by `into_proxy_scheme`, which knows
        // only http, https and socks5. A bare word would NOT do: reqwest
        // accepts `garbage` as `http://garbage`, so a test written with one
        // would pass while asserting something untrue about reqwest.
        let vars = [
            ("HTTP_PROXY", "ftp://nope:1"),
            ("http_proxy", "http://ok:1"),
        ]
        .map(|(k, v)| (k.to_string(), v.to_string()));

        let e = crate::proxy::system_proxy_from_env(&vars, |scheme, uri| match scheme {
            EnvScheme::Http => reqwest::Proxy::http(uri).ok(),
            EnvScheme::Https => reqwest::Proxy::https(uri).ok(),
        });
        assert!(e.http.is_some(), "the lowercase spelling must be used");

        let caps = HostCaps::assume_all_present();
        let d = format!(
            "{:?}",
            build_client_with(&ProxyPlan::Direct, &caps, || e).unwrap()
        );
        assert!(d.contains("Http(http://ok:1)"), "{d}");
    }

    /// Producing the captured environment parses URIs, and parsing a
    /// `socks5h://` one resolves its host — so it must not happen on a path
    /// that discards the result. `AppState::new` builds a client synchronously
    /// inside Tauri's `setup` closure, which is where an eager call would
    /// become a `getaddrinfo` stall at startup in the ordinary configuration:
    /// sidecar on, settings on, so the route is `Via` and the captured values
    /// are never looked at.
    ///
    /// Observable because the thunk is the seam: a real call flips the flag.
    #[test]
    fn a_proxied_build_never_produces_the_captured_environment() {
        let caps = HostCaps::assume_all_present();
        let asked = std::cell::Cell::new(false);
        let never = || {
            asked.set(true);
            CapturedProxies::default()
        };

        let p = plan(&enabled("127.0.0.1", 3128), &caps).unwrap();
        build_client_with(&p, &caps, never).expect("a valid plan builds");
        assert!(
            !asked.get(),
            "the captured environment was produced for a proxied plan, where it \
             is thrown away — that is a `getaddrinfo` on the startup thread for \
             nothing"
        );
    }

    /// And this proves the test above is not vacuous: the `Direct` arm does
    /// reach for it, so the flag is capable of being set.
    #[test]
    fn a_direct_build_does_produce_the_captured_environment() {
        let caps = HostCaps::assume_all_present();
        let asked = std::cell::Cell::new(false);
        let once = || {
            asked.set(true);
            CapturedProxies::default()
        };
        build_client_with(&ProxyPlan::Direct, &caps, once).unwrap();
        assert!(asked.get(), "the Direct route must consult the capture");
    }

    fn proxy_for(uri: &str) -> reqwest::Proxy {
        reqwest::Proxy::http(uri).expect("test proxy uri")
    }

    fn corporate() -> CapturedProxies {
        CapturedProxies {
            http: Some(proxy_for("http://corp:8080")),
            https: Some(reqwest::Proxy::https("http://corp:8443").unwrap()),
            no_proxy: Some("intranet.example".into()),
        }
    }

    /// The inverse of the startup scrub, and the regression it exists to
    /// prevent. A corporate user launches with SONE's proxy on, so startup
    /// removed their exported `http_proxy`; they then turn SONE's proxy off.
    /// `Direct` means their system's configuration applies — but reqwest's
    /// auto-detection now reads an environment we emptied, so without the
    /// captured values this client would egress direct, past the proxy their
    /// system requires.
    #[test]
    fn turning_the_proxy_off_restores_the_system_proxy_we_removed() {
        let caps = HostCaps::assume_all_present();
        let c = build_client_with(&ProxyPlan::Direct, &caps, corporate).unwrap();
        let d = format!("{c:?}");
        assert!(d.contains("Http(http://corp:8080)"), "{d}");
        assert!(d.contains("Https(http://corp:8443)"), "{d}");
        // The bypass list travels with them, or every intranet host that was
        // meant to go direct starts going through the proxy instead.
        assert!(d.contains("intranet.example"), "{d}");
    }

    /// Nothing was scrubbed — the ordinary case, and every launch with the
    /// proxy off. reqwest must be left to read the environment itself, so the
    /// client carries no proxy of ours.
    #[test]
    fn an_unscrubbed_direct_client_carries_no_proxy_of_our_own() {
        let caps = HostCaps::assume_all_present();
        let c = build_client_with(&ProxyPlan::Direct, &caps, CapturedProxies::default).unwrap();
        // reqwest's own `System(...)` entry, still doing its own detection —
        // and nothing we put there.
        let d = format!("{c:?}");
        assert!(d.contains("Proxy(System("), "{d}");
        assert!(!d.contains("Proxy(Http("), "{d}");
        assert!(!d.contains("Proxy(Https("), "{d}");
    }

    /// While SONE proxies, its own plan is the whole answer. Letting the
    /// captured configuration through here would add a second proxy the user
    /// did not ask this app to use, and reqwest matches proxies in order.
    #[test]
    fn a_proxied_client_never_also_carries_the_captured_system_proxy() {
        let caps = HostCaps::assume_all_present();
        let p = plan(&enabled("127.0.0.1", 3128), &caps).unwrap();
        let d = format!("{:?}", build_client_with(&p, &caps, corporate).unwrap());
        assert!(d.contains("All(http://127.0.0.1:3128)"), "{d}");
        assert!(
            !d.contains("corp"),
            "SONE's plan must be the only proxy: {d}"
        );
    }

    /// A malformed shell variable must not take the app down. Auto-detection
    /// would have ignored it, so skipping it is the faithful behaviour; the
    /// usable half is still restored.
    #[test]
    fn an_unusable_captured_value_is_skipped_rather_than_blocking() {
        let caps = HostCaps::assume_all_present();
        let vars = [
            ("http_proxy", "ftp://nope:1"),
            ("https_proxy", "http://corp:8443"),
        ]
        .map(|(k, v)| (k.to_string(), v.to_string()));
        let sys = crate::proxy::system_proxy_from_env(&vars, |scheme, uri| match scheme {
            EnvScheme::Http => reqwest::Proxy::http(uri).ok(),
            EnvScheme::Https => reqwest::Proxy::https(uri).ok(),
        });
        let c = build_client_with(&ProxyPlan::Direct, &caps, || sys)
            .expect("a malformed captured value must not block egress");
        let d = format!("{c:?}");
        assert!(d.contains("Https(http://corp:8443)"), "{d}");
        assert!(!d.contains("nope"), "{d}");
    }

    #[test]
    fn direct_plan_yields_a_usable_client() {
        let caps = HostCaps::assume_all_present();
        let h = ProxiedHttp::from_plan(&ProxyPlan::Direct, &caps);
        assert!(h.client().is_ok());
    }

    #[test]
    fn valid_proxy_plan_yields_a_usable_client() {
        let caps = HostCaps::assume_all_present();
        let p = plan(&enabled("127.0.0.1", 3128), &caps).unwrap();
        assert!(ProxiedHttp::from_plan(&p, &caps).client().is_ok());
    }

    #[test]
    fn credentials_travel_beside_the_uri_not_inside_it() {
        let caps = HostCaps::assume_all_present();
        let mut s = enabled("127.0.0.1", 3128);
        s.username = Some("bob".into());
        s.password = Some("hunter2".into());
        let p = plan(&s, &caps).unwrap();

        // This is the exact string `build_client` hands to `reqwest::Proxy::all`.
        // Asserting the whole URI, not just the absence of a password, is what
        // makes this fail if credentials ever get folded into it.
        let route = p.route(Capability::Api, &caps).unwrap();
        let Route::Via { uri, creds } = route else {
            panic!("an enabled proxy must not route as NoProxy");
        };
        assert_eq!(uri, "http://127.0.0.1:3128");
        assert!(creds.is_some(), "credentials must arrive beside the uri");

        // Only `Proxy::basic_auth` reunites them with that endpoint.
        assert!(build_client(&p, &caps).is_ok());
    }

    #[test]
    fn unresolvable_proxy_host_blocks_with_a_cause_instead_of_a_direct_client() {
        // reqwest resolves a socks5/socks5h proxy host when the client is
        // built, so this failure is invisible to plan() and must surface as a
        // BlockReason, never a proxy-less client. `.invalid` is reserved by
        // RFC 6761 and can never resolve, so the outcome does not depend on
        // which resolver (or none) the machine has.
        let caps = HostCaps::assume_all_present();
        let p = plan(&enabled_socks("no-such-host.invalid", 3128), &caps).unwrap();
        let err = ProxiedHttp::from_plan(&p, &caps).client().unwrap_err();
        assert!(!err.cause.is_empty());
        assert!(err.cause.contains("socks5h://no-such-host.invalid:3128"));
        // Name the failure, not just its existence: without reqwest's `socks`
        // feature `Proxy::all` still errors here, with "unknown proxy scheme",
        // and this test would stay green while real SOCKS5 support was gone.
        assert!(
            err.cause.contains("failed to lookup address"),
            "expected an eager resolution failure, got: {}",
            err.cause
        );
    }

    #[test]
    fn an_unresolvable_http_proxy_still_yields_a_fully_proxied_client() {
        // Asymmetry worth pinning: reqwest defers the name lookup for an
        // `http://` proxy, so the build succeeds. That is still fail-closed —
        // the client intercepts every request, so it fails at the proxy rather
        // than reaching the network directly.
        let caps = HostCaps::assume_all_present();
        let p = plan(&enabled("no-such-host.invalid", 3128), &caps).unwrap();
        let c = ProxiedHttp::from_plan(&p, &caps).client().unwrap();
        assert!(format!("{c:?}").contains("All(http://no-such-host.invalid:3128)"));
    }

    /// A client that is guaranteed unproxied, whatever the developer's shell
    /// exported. `ProxiedHttp::from_plan(Direct, ..)` would consult the
    /// captured environment, and a machine with `http_proxy` set would send
    /// these loopback requests somewhere else entirely.
    fn direct_cell() -> (ProxiedHttp, reqwest::Client) {
        let c = build_client_with(
            &ProxyPlan::Direct,
            &HostCaps::assume_all_present(),
            CapturedProxies::default,
        )
        .unwrap();
        (ProxiedHttp::wrap(Ok(c.clone())), c)
    }

    /// One connection, one 404, then gone. Enough to prove an origin answered.
    async fn origin_that_refuses_us() -> std::net::SocketAddr {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            if let Ok((mut sock, _)) = l.accept().await {
                let _ = sock.read(&mut [0u8; 2048]).await;
                let _ = sock
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                    )
                    .await;
                let _ = sock.shutdown().await;
            }
        });
        addr
    }

    /// A port with nothing behind it, so the connect is refused rather than
    /// hanging until a timeout the test would have to wait out.
    fn nothing_is_listening_here() -> std::net::SocketAddr {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap()
        // `l` drops here; the port is closed before anyone dials it.
    }

    /// The distinction the whole attribution rests on, measured against real
    /// reqwest errors rather than asserted from its documentation.
    ///
    /// A proxy whose name never resolves and a port with nothing behind it are
    /// both "no answer came back". A 404 is an answer, and reqwest hands it
    /// back as `Ok` — which is why an origin refusing SONE can never be read
    /// as a proxy that is not there.
    #[tokio::test]
    async fn only_a_request_that_got_no_answer_counts_as_a_transport_failure() {
        let caps = HostCaps::assume_all_present();
        let p = plan(&enabled("no-such-host.invalid", 3128), &caps).unwrap();
        let proxied = ProxiedHttp::from_plan(&p, &caps).client().unwrap();
        let e = proxied
            .get("https://auth.example.com/oauth2/device_authorization")
            .send()
            .await
            .unwrap_err();
        assert!(
            is_transport_failure(&e),
            "an http proxy that does not resolve must read as a transport failure: {e}"
        );

        let (_, direct) = direct_cell();
        let e = direct
            .get(format!("http://{}/", nothing_is_listening_here()))
            .send()
            .await
            .unwrap_err();
        assert!(is_transport_failure(&e), "a refused connect too: {e}");

        let addr = origin_that_refuses_us().await;
        let resp = direct
            .get(format!("http://{addr}/"))
            .send()
            .await
            .expect("a 404 is an answer, not an error");
        assert_eq!(resp.status(), 404);
    }

    /// One unanswered request, tagged with the generation its client came from.
    async fn one_unanswered(cell: &ProxiedHttp, c: &reqwest::Client) {
        let dead = nothing_is_listening_here();
        let (generation, _) = cell.client_at();
        assert!(
            cell.observe_at(generation, c.get(format!("http://{dead}/")).send().await)
                .is_err(),
            "a closed port must not answer"
        );
    }

    /// The asymmetry, which is the whole of the safety argument: raising the
    /// state takes two unanswered requests in a row, lowering it takes one
    /// answered request.
    ///
    /// One failure is not enough because the action this state offers removes
    /// containment. A two-second wifi drop mid-login would otherwise leave a
    /// standing "turn off your proxy" bar in front of a user whose proxy is
    /// fine — nothing clears the count but a request, and reading the status
    /// deliberately sends none.
    #[tokio::test]
    async fn two_in_a_row_raise_it_and_one_answer_undoes_it() {
        let (cell, c) = direct_cell();
        assert!(
            !cell.unreachable(),
            "a cell that has sent nothing has observed nothing"
        );

        one_unanswered(&cell, &c).await;
        assert!(
            !cell.unreachable(),
            "one blip must never put a disable-the-proxy button on screen"
        );

        one_unanswered(&cell, &c).await;
        assert!(cell.unreachable(), "still failing on the next attempt");

        let addr = origin_that_refuses_us().await;
        let (generation, _) = cell.client_at();
        let resp = cell
            .observe_at(generation, c.get(format!("http://{addr}/")).send().await)
            .expect("observe must hand the outcome straight back");
        assert_eq!(resp.status(), 404, "a refusal from the origin, not silence");
        assert!(
            !cell.unreachable(),
            "one answered request is the whole of the recovery"
        );
    }

    /// Reconfiguring drops the verdict with the client it was about. Without
    /// this the proxy a user just switched to would inherit the silence of the
    /// one they switched away from, and the banner would name the new host for
    /// the old host's failure.
    #[tokio::test]
    async fn a_reconfigured_cell_starts_with_no_verdict() {
        let caps = HostCaps::assume_all_present();
        let (cell, c) = direct_cell();
        one_unanswered(&cell, &c).await;
        one_unanswered(&cell, &c).await;
        assert!(cell.unreachable());

        cell.replace(&plan(&enabled("127.0.0.1", 3128), &caps).unwrap(), &caps)
            .expect("a valid plan builds");
        assert!(!cell.unreachable());
    }

    /// The race the generation tag exists to close, in both directions.
    ///
    /// A request in flight when the user saves new settings belongs to the
    /// client it started on. Counting its failure against the replacement
    /// would report a freshly saved, working proxy as unreachable *under its
    /// own name* — and the inverse, an old client's success clearing a count
    /// the new one earned, would hide a real outage.
    #[tokio::test]
    async fn an_observation_about_a_client_the_cell_has_replaced_is_dropped() {
        let caps = HostCaps::assume_all_present();
        let (cell, c) = direct_cell();
        let stale = cell.client_at().0;

        cell.replace(&plan(&enabled("127.0.0.1", 3128), &caps).unwrap(), &caps)
            .expect("a valid plan builds");

        let dead = nothing_is_listening_here();
        for _ in 0..2 {
            let _ = cell.observe_at(stale, c.get(format!("http://{dead}/")).send().await);
        }
        assert!(
            !cell.unreachable(),
            "the replaced client's silence must not be charged to its replacement"
        );

        let live = cell.client_at().0;
        for _ in 0..2 {
            let _ = cell.observe_at(live, c.get(format!("http://{dead}/")).send().await);
        }
        assert!(
            cell.unreachable(),
            "the live client's own silence does count"
        );

        let addr = origin_that_refuses_us().await;
        let _ = cell.observe_at(stale, c.get(format!("http://{addr}/")).send().await);
        assert!(
            cell.unreachable(),
            "and a stale success must not clear a live count"
        );
    }

    #[test]
    fn replace_swaps_the_cell_without_reconstructing_consumers() {
        let caps = HostCaps::assume_all_present();
        let h = ProxiedHttp::from_plan(&ProxyPlan::Direct, &caps);
        let clone = h.clone();
        let p = plan(&enabled_socks("no-such-host.invalid", 3128), &caps).unwrap();
        assert!(
            h.replace(&p, &caps).is_err(),
            "an unresolvable proxy must report its own build failure"
        );
        // The clone observes the new state: there is one cell, not two clients.
        assert!(clone.client().is_err());
    }

    #[test]
    fn a_poisoned_cell_neither_blocks_egress_nor_drops_the_proxy() {
        let caps = HostCaps::assume_all_present();
        let p = plan(&enabled("127.0.0.1", 3128), &caps).unwrap();
        let h = ProxiedHttp::from_plan(&p, &caps);

        // A std lock is only poisoned by a real panic, so stage one. The hook is
        // silenced across the join and restored before any assertion below, so a
        // genuine failure still prints.
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let poisoner = h.clone();
        let outcome = std::thread::spawn(move || {
            let _held = poisoner.cell.write().unwrap();
            panic!("deliberate: poisons the cell while the write lock is held");
        })
        .join();
        std::panic::set_hook(prev);

        assert!(
            outcome.is_err(),
            "the staged panic must actually have happened"
        );
        assert!(h.cell.read().is_err(), "the cell must now be poisoned");

        // Reading through the poison: an unrelated panic must not block egress,
        // and must not hand back a client that lost its proxy.
        let c = h.client().expect("a poisoned cell must not block egress");
        assert!(format!("{c:?}").contains("All(http://127.0.0.1:3128)"));

        // Writing through the poison: `replace` still lands, and a clone sees it.
        let observer = h.clone();
        let blocked = plan(&enabled_socks("no-such-host.invalid", 3128), &caps).unwrap();
        assert!(h.replace(&blocked, &caps).is_err());
        assert!(
            observer.client().is_err(),
            "replace must land through the poison, not be dropped"
        );
    }

    #[test]
    fn an_explicitly_blocked_cell_never_hands_out_a_client() {
        // Settings that do not form a plan at all must land here, not on
        // `ProxyPlan::Direct`: "we could not understand your proxy" must never
        // resolve to "so we went around it".
        let h = ProxiedHttp::blocked("proxy host must be ASCII");
        let err = h.client().unwrap_err();
        assert_eq!(err.cause, "proxy host must be ASCII");

        // And the same for a cell that starts usable and is then blocked.
        let caps = HostCaps::assume_all_present();
        let live = ProxiedHttp::from_plan(&ProxyPlan::Direct, &caps);
        let observer = live.clone();
        assert!(live.client().is_ok());
        live.block("proxy port must not be 0");
        assert_eq!(
            observer.client().unwrap_err().cause,
            "proxy port must not be 0",
            "block must land in the shared cell, not a private copy"
        );
    }

    /// The falsifying test for the generation guard. Note the direction: the
    /// SLOW build is the one that yields a real client (~17ms to stand up a
    /// connector), and the FAST one is the blocked plan (~0.3ms, because
    /// `Proxy::all` rejects `socks5h://…invalid` before any connector is built).
    /// So the stale winner under a broken implementation is a *usable* client
    /// built from settings the user already replaced.
    #[test]
    fn a_slow_older_replace_never_overwrites_the_newer_settings() {
        let caps = HostCaps::assume_all_present();

        for _ in 0..16 {
            let h = ProxiedHttp::from_plan(&ProxyPlan::Direct, &caps);
            let older = plan(&enabled("127.0.0.1", 3128), &caps).unwrap();
            let newer = plan(&enabled_socks("no-such-host.invalid", 3128), &caps).unwrap();

            let before = h.next.load(Ordering::SeqCst);
            let slow = h.clone();
            let t = std::thread::spawn(move || {
                slow.replace(&older, &caps).expect("the older plan builds");
            });

            // Pin the generation order without pinning the completion order:
            // spin only until the older caller has claimed its generation. It
            // is then ~17ms from storing, while this thread is ~0.3ms from it.
            while h.next.load(Ordering::SeqCst) == before {
                std::hint::spin_loop();
            }
            assert!(h.replace(&newer, &caps).is_err());
            t.join().unwrap();

            let err = h.client().unwrap_err();
            assert!(
                err.cause.contains("no-such-host.invalid"),
                "the newest settings must win even though their predecessor's \
                 build finished last; cell holds a client from the old ones"
            );
        }
    }

    /// The same rule with the race removed, so it cannot pass by luck — and in
    /// the direction that actually fails open. `next` and `store` are exactly
    /// what two interleaved `replace` calls use; only the interleaving is
    /// pinned. enable -> disable -> enable: if the `Direct` build lands last,
    /// the cell goes unproxied while the saved settings say enabled.
    #[test]
    fn the_newest_caller_wins_no_matter_which_build_finished_last() {
        let caps = HostCaps::assume_all_present();
        let h = ProxiedHttp::from_plan(&ProxyPlan::Direct, &caps);
        let proxied = plan(&enabled("127.0.0.1", 3128), &caps).unwrap();

        // Two callers claim in order; their builds complete in the opposite one.
        let disable = h.claim();
        let reenable = h.claim();
        h.store(reenable, build_client(&proxied, &caps));
        h.store(disable, build_client(&ProxyPlan::Direct, &caps));

        let c = h
            .client()
            .expect("a usable plan must still yield a usable client");
        assert!(
            format!("{c:?}").contains("All(http://127.0.0.1:3128)"),
            "a late `Direct` build must not strip the proxy the user re-enabled: {c:?}"
        );

        // And the reverse: a late proxied build must not resurrect a proxy the
        // user has since turned off.
        let enable = h.claim();
        let disable = h.claim();
        h.store(disable, build_client(&ProxyPlan::Direct, &caps));
        h.store(enable, build_client(&proxied, &caps));
        let c = h.client().unwrap();
        assert!(
            !format!("{c:?}").contains("All(http://127.0.0.1:3128)"),
            "a late proxied build must not outlive the settings that asked for it"
        );
    }

    /// The generation-taking entry points must honour the claim they are
    /// handed rather than taking a fresh one.
    ///
    /// This is what lets `set_proxy_settings` claim beside its write to disk
    /// instead of inside the `spawn_blocking` closure that builds the client.
    /// If `apply_at` quietly re-claimed, the cell's order would go back to
    /// being whichever build reached the blocking pool first — and a save that
    /// persisted "enabled" could leave a `Direct` client egressing.
    #[test]
    fn apply_at_honours_the_claim_it_was_given() {
        let caps = HostCaps::assume_all_present();
        let h = ProxiedHttp::from_plan(&ProxyPlan::Direct, &caps);
        let proxied = enabled("127.0.0.1", 3128);

        // Claimed in save order: the disable first, the re-enable second.
        let disable = h.claim();
        let reenable = h.claim();
        // Applied in the opposite order, as the blocking pool may well run them.
        h.apply_at(reenable, &proxied, &caps).unwrap();
        let mut off = proxied.clone();
        off.enabled = false;
        h.apply_at(disable, &off, &caps).unwrap();

        let c = h.client().expect("a usable plan yields a client");
        assert!(
            format!("{c:?}").contains("All(http://127.0.0.1:3128)"),
            "apply_at took a fresh generation instead of the one it was given,              so the older save won the cell: {c:?}"
        );
    }

    /// A smoke test, and labelled as one so it is not mistaken for the proof.
    ///
    /// The property — `block` runs inline on the Tauri runtime and must never
    /// wait on another writer's `getaddrinfo` — is carried by the structure:
    /// `replace` builds outside every lock, so there is nothing for `block` to
    /// queue behind. The structure is what to check in review.
    ///
    /// The timing here does not falsify a regression on its own. The `replace`
    /// it races is ~17ms against a 100ms threshold, so an implementation that
    /// did hold the lock across the build would still pass. Making it sharp
    /// needs a build that blocks for a controllable duration, which means
    /// injecting the builder; that is worth doing the day the structure
    /// changes, and until then this catches only a gross regression — a lock
    /// held across a real DNS timeout.
    #[test]
    fn block_does_not_visibly_queue_behind_a_slow_replace_smoke() {
        let caps = HostCaps::assume_all_present();
        let h = ProxiedHttp::from_plan(&ProxyPlan::Direct, &caps);
        let p = plan(&enabled("127.0.0.1", 3128), &caps).unwrap();

        let before = h.next.load(Ordering::SeqCst);
        let slow = h.clone();
        let t = std::thread::spawn(move || {
            slow.replace(&p, &caps).expect("a valid plan builds");
        });
        while h.next.load(Ordering::SeqCst) == before {
            std::hint::spin_loop();
        }

        let t0 = std::time::Instant::now();
        h.block("proxy port must not be 0");
        let waited = t0.elapsed();
        t.join().unwrap();

        assert!(
            waited < std::time::Duration::from_millis(100),
            "block waited {waited:?} — it is holding, or queueing behind, the \
             build lock. Note the converse does not hold: passing this is not \
             evidence that it is not."
        );
    }

    #[test]
    fn settings_that_do_not_form_a_plan_block_the_cell_instead_of_going_direct() {
        // This is the case `AppState::new` hits on a corrupt saved proxy. A
        // `ProxyPlan::Direct` fallback here would mean every request silently
        // leaves the machine unproxied.
        let caps = HostCaps::assume_all_present();
        for bad in [
            enabled("127.0.0.1", 0),
            enabled("proxy.local:3128", 3128),
            enabled("ho st", 3128),
            enabled("[::1]", 3128),
            enabled("", 3128),
            enabled("пример.рф", 3128),
        ] {
            assert!(
                crate::proxy::plan(&bad, &caps).is_err(),
                "{bad:?} was expected to be unplannable"
            );
            let err = match ProxiedHttp::from_settings(&bad, &caps).client() {
                Err(e) => e,
                Ok(c) => panic!("{bad:?} must block, but yielded a client: {c:?}"),
            };
            assert!(!err.cause.is_empty(), "a block must carry its cause");
        }

        // The legitimate direct case must survive that strictness.
        let mut off = enabled("127.0.0.1", 3128);
        off.enabled = false;
        assert!(
            ProxiedHttp::from_settings(&off, &caps).client().is_ok(),
            "a disabled proxy is Direct, not a block"
        );
    }

    #[test]
    fn applying_unplannable_settings_blocks_a_live_cell() {
        // The `set_proxy_settings` path: a cell that is serving traffic must go
        // blocked, not fall back to direct, when the new settings do not plan.
        let caps = HostCaps::assume_all_present();
        let h = ProxiedHttp::from_plan(&ProxyPlan::Direct, &caps);
        let observer = h.clone();
        assert!(h.client().is_ok());

        let reported = h
            .apply(&enabled("127.0.0.1", 0), &caps)
            .expect_err("apply must hand the caller the reason it blocked");
        assert!(reported.cause.contains("port"), "got: {}", reported.cause);
        let err = observer
            .client()
            .expect_err("unplannable settings must block the shared cell");
        assert!(err.cause.contains("port"), "got: {}", err.cause);

        // And a subsequent good save recovers it, through the same entry point.
        h.apply(&enabled("127.0.0.1", 3128), &caps)
            .expect("a usable proxy must report success");
        let c = observer
            .client()
            .expect("a valid save must unblock the cell");
        assert!(format!("{c:?}").contains("All(http://127.0.0.1:3128)"));
    }

    #[test]
    fn apply_reports_the_failures_plan_cannot_see() {
        // A SOCKS5 host resolves when the client is built, so `plan` says yes
        // and the build says no. `apply` must still hand that back: the save
        // path has nothing else to report to the user, and reading the cell
        // instead would report whatever a concurrent caller left there.
        let caps = HostCaps::assume_all_present();
        let h = ProxiedHttp::from_plan(&ProxyPlan::Direct, &caps);
        let s = enabled_socks("no-such-host.invalid", 3128);
        assert!(plan(&s, &caps).is_ok(), "this must fail at build, not plan");

        let err = h
            .apply(&s, &caps)
            .expect_err("an unbuildable plan must not report success");
        assert!(
            err.cause.contains("no-such-host.invalid"),
            "got: {}",
            err.cause
        );
        assert!(
            h.client().is_err(),
            "and the cell must be blocked, not direct"
        );
    }
}
