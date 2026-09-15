//! The URI strings the real `plan()` -> `route()` produces, asserted from
//! outside the crate.
//!
//! Strings only: nothing here builds a GStreamer element or moves a byte, so it
//! cannot show what a source does with these values — `audio.rs`'s own tests
//! cover the hook that applies them, and the port-80 case is settled by manual
//! test 1's strace rather than by any assertion. (An earlier draft did build an
//! element and set `proxy` by hand, which proved only that GStreamer honours a
//! property.)
//!
//! What it adds over the unit tests beside `route()` is the boundary it runs
//! at: `plan`, `route`, `Capability`, `HostCaps` and `Route` have to stay
//! reachable, and the right shape, to a consumer outside the crate.

use tauri_app_lib::proxy::{plan, Capability, HostCaps, Route};
use tauri_app_lib::{ProxySettings, ProxyType};

fn settings(port: u16, creds: bool) -> ProxySettings {
    ProxySettings {
        enabled: true,
        proxy_type: ProxyType::Http,
        host: "127.0.0.1".into(),
        port,
        username: creds.then(|| "bob".to_string()),
        password: creds.then(|| "hunter2".to_string()),
    }
}

#[test]
fn credentials_never_reach_the_uri() {
    let caps = HostCaps::assume_all_present();
    let route = plan(&settings(19190, true), &caps)
        .expect("these settings form a plan")
        .route(Capability::Dash, &caps)
        .expect("this tier is proxyable with these capabilities");

    match route {
        Route::Via { uri, creds } => {
            assert_eq!(uri, "http://127.0.0.1:19190");
            assert!(!uri.contains('@'));
            assert!(!uri.contains("hunter2"));
            assert!(creds.is_some(), "they travel beside the uri, not inside it");
        }
        Route::NoProxy => panic!("an enabled, usable proxy must not yield NoProxy"),
    }
}

#[test]
fn a_proxy_on_port_80_keeps_its_port() {
    // The defect this stage exists to fix: `Url::set_port` nulled a port equal
    // to the scheme default, the port vanished from the string, and libcurl
    // then dialled its own default of 1080.
    //
    // This asserts the string only. That the port survives into a real element
    // is proven by manual test 1's strace -- `souphttpsrc` normalizes `:80`
    // back out of its readback while still connecting to 80, so no property
    // assertion can prove it.
    let caps = HostCaps::assume_all_present();
    let route = plan(&settings(80, false), &caps)
        .expect("plan")
        .route(Capability::Lossy, &caps)
        .expect("route");
    match route {
        Route::Via { uri, .. } => {
            assert_eq!(uri, "http://127.0.0.1:80");
        }
        Route::NoProxy => panic!("expected a proxied route"),
    }
}

#[test]
fn socks5_audio_is_proxied_rather_than_silently_direct() {
    // What the original contributor's PR dropped: its uri builder only ever
    // emitted `http://`, so with SOCKS5 selected every audio segment went out
    // on the real address.
    let caps = HostCaps::assume_all_present();
    let mut s = settings(1080, false);
    s.proxy_type = ProxyType::Socks5;
    let route = plan(&s, &caps)
        .expect("plan")
        .route(Capability::Lossy, &caps)
        .expect("unauthenticated socks5 audio is routable");
    match route {
        // `assert_eq!`, not `starts_with("socks5")`: that also accepts
        // `socks5h`, which is the wrong scheme here — gio implements socks5
        // only, and socks5h reaches "NO GProxy IMPL" at runtime.
        Route::Via { uri, .. } => assert_eq!(uri, "socks5://127.0.0.1:1080"),
        Route::NoProxy => panic!("socks5 audio must not fall back to direct"),
    }
}
