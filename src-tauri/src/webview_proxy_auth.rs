use tauri::Manager;

use crate::{AppState, ProxySettings, ProxyType};

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WebviewProxyAuthAction {
    Ignore,
    Supply,
    Cancel,
}

#[cfg(target_os = "linux")]
fn webview_proxy_auth_action(
    settings: &ProxySettings,
    challenge_host: Option<&str>,
    challenge_port: u32,
    is_for_proxy: bool,
    is_retry: bool,
) -> WebviewProxyAuthAction {
    if !is_for_proxy
        || !settings.enabled
        || settings.proxy_type != ProxyType::Http
        || settings
            .username
            .as_deref()
            .map(str::trim)
            .filter(|username| !username.is_empty())
            .is_none()
    {
        return WebviewProxyAuthAction::Ignore;
    }

    let host_matches = challenge_host
        .is_some_and(|host| host.eq_ignore_ascii_case(settings.host.trim()));
    let port_matches = challenge_port == u32::from(settings.port);

    if !host_matches || !port_matches {
        return WebviewProxyAuthAction::Ignore;
    }

    if is_retry {
        WebviewProxyAuthAction::Cancel
    } else {
        WebviewProxyAuthAction::Supply
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn install(app: &tauri::AppHandle) {
    use webkit2gtk::glib::translate::{ToGlibPtr, ToGlibPtrMut};
    use webkit2gtk::{
        AuthenticationRequestExt, Credential, CredentialPersistence, WebViewExt,
    };

    let Some(window) = app.get_webview_window("main") else {
        log::warn!("[proxy] main webview unavailable; proxy auth handler not installed");
        return;
    };

    let app_handle = app.clone();
    if let Err(e) = window.with_webview(move |webview| {
        let wv: webkit2gtk::WebView = webview.inner();
        let app_handle = app_handle.clone();

        wv.connect_authenticate(move |_wv, request| {
            let state = app_handle.state::<AppState>();
            let Some(settings) = state.load_settings().map(|s| s.proxy) else {
                return false;
            };

            let challenge_host = request.host();
            let challenge_port = request.port();

            match webview_proxy_auth_action(
                &settings,
                challenge_host.as_deref(),
                challenge_port,
                request.is_for_proxy(),
                request.is_retry(),
            ) {
                WebviewProxyAuthAction::Ignore => false,
                WebviewProxyAuthAction::Cancel => {
                    log::warn!(
                        "[proxy] stored credentials rejected by WebKit proxy {}:{}",
                        challenge_host.as_deref().unwrap_or("<unknown>"),
                        challenge_port
                    );
                    request.cancel();
                    true
                }
                WebviewProxyAuthAction::Supply => {
                    let username = settings
                        .username
                        .as_deref()
                        .map(str::trim)
                        .expect("Supply requires a non-empty proxy username");
                    let password = settings.password.as_deref().unwrap_or_default();

                    let mut credential =
                        Credential::new(username, password, CredentialPersistence::ForSession);

                    // webkit2gtk 2.0.2 exposes the authenticate signal and Credential
                    // wrapper but not the safe authentication_request_authenticate()
                    // method, so call the underlying WebKit API directly.
                    unsafe {
                        webkit2gtk::ffi::webkit_authentication_request_authenticate(
                            request.to_glib_none().0,
                            credential.to_glib_none_mut().0,
                        );
                    }

                    log::debug!(
                        "[proxy] supplied stored credentials to WebKit proxy {}:{}",
                        challenge_host.as_deref().unwrap_or("<unknown>"),
                        challenge_port
                    );
                    true
                }
            }
        });
    }) {
        log::warn!("[proxy] failed to install WebKit proxy auth handler: {e}");
    }
}

#[cfg(all(test, target_os = "linux"))]
mod webview_proxy_auth_tests {
    use super::{
        webview_proxy_auth_action, ProxySettings, ProxyType, WebviewProxyAuthAction,
    };

    fn settings() -> ProxySettings {
        ProxySettings {
            enabled: true,
            proxy_type: ProxyType::Http,
            host: "proxy.example".into(),
            port: 8080,
            username: Some("alice".into()),
            password: Some("secret".into()),
        }
    }

    #[test]
    fn matching_proxy_challenge_uses_saved_credentials() {
        assert_eq!(
            webview_proxy_auth_action(
                &settings(),
                Some("PROXY.EXAMPLE"),
                8080,
                true,
                false
            ),
            WebviewProxyAuthAction::Supply
        );
    }

    #[test]
    fn origin_auth_is_never_given_proxy_credentials() {
        assert_eq!(
            webview_proxy_auth_action(
                &settings(),
                Some("proxy.example"),
                8080,
                false,
                false
            ),
            WebviewProxyAuthAction::Ignore
        );
    }

    #[test]
    fn different_proxy_host_or_port_is_ignored() {
        assert_eq!(
            webview_proxy_auth_action(
                &settings(),
                Some("other.example"),
                8080,
                true,
                false
            ),
            WebviewProxyAuthAction::Ignore
        );
        assert_eq!(
            webview_proxy_auth_action(
                &settings(),
                Some("proxy.example"),
                3128,
                true,
                false
            ),
            WebviewProxyAuthAction::Ignore
        );
    }

    #[test]
    fn retry_for_matching_proxy_is_cancelled() {
        assert_eq!(
            webview_proxy_auth_action(
                &settings(),
                Some("proxy.example"),
                8080,
                true,
                true
            ),
            WebviewProxyAuthAction::Cancel
        );
    }

    #[test]
    fn disabled_socks_or_missing_username_is_ignored() {
        let mut s = settings();
        s.enabled = false;
        assert_eq!(
            webview_proxy_auth_action(&s, Some("proxy.example"), 8080, true, false),
            WebviewProxyAuthAction::Ignore
        );

        let mut s = settings();
        s.proxy_type = ProxyType::Socks5;
        assert_eq!(
            webview_proxy_auth_action(&s, Some("proxy.example"), 8080, true, false),
            WebviewProxyAuthAction::Ignore
        );

        let mut s = settings();
        s.username = Some("   ".into());
        assert_eq!(
            webview_proxy_auth_action(&s, Some("proxy.example"), 8080, true, false),
            WebviewProxyAuthAction::Ignore
        );
    }
}
