use base64::Engine;
use rand::RngExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use tauri::State;

use crate::tidal_api::{AuthTokens, DeviceAuthResponse};
use crate::AppState;
use crate::Settings;
use crate::SoneError;

/// Check if the given credentials match the embedded defaults.
fn are_embedded_defaults(id: &str, secret: &str) -> bool {
    crate::embedded_config::has_stream_keys()
        && id == crate::embedded_config::stream_key_a()
        && secret == crate::embedded_config::stream_key_b()
}

/// Resolve credentials from saved settings, falling back to embedded defaults.
fn resolve_credentials(settings: &Settings) -> (String, String) {
    let id = if settings.client_id.is_empty() {
        crate::embedded_config::stream_key_a()
    } else {
        settings.client_id.clone()
    };
    let secret = if settings.client_secret.is_empty() {
        crate::embedded_config::stream_key_b()
    } else {
        settings.client_secret.clone()
    };
    (id, secret)
}

/// Extract a value for `key=<value>` from URL-encoded / form-data text.
fn extract_form_value(text: &str, key: &str) -> Option<String> {
    let pattern = format!("{}=", key);
    let start = text.find(&pattern)? + pattern.len();
    let rest = &text[start..];
    let end = rest
        .find(|c: char| c == '&' || c == '"' || c == '\'' || c.is_whitespace())
        .unwrap_or(rest.len());
    let value = &rest[..end];
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// Extract a value for `"key": "value"` from JSON-like text.
fn extract_json_value(text: &str, key: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let pat = format!("{q}{key}{q}", q = quote, key = key);
        if let Some(key_pos) = text.find(pat.as_str()) {
            let after_key = &text[key_pos + pat.len()..];
            let trimmed = after_key.trim_start();
            let trimmed = if let Some(rest) = trimmed
                .strip_prefix(':')
                .or_else(|| trimmed.strip_prefix('='))
            {
                rest.trim_start()
            } else {
                continue;
            };
            for vq in ['"', '\''] {
                if trimmed.starts_with(vq) {
                    if let Some(end) = trimmed[1..].find(vq) {
                        let value = &trimmed[1..1 + end];
                        if !value.is_empty() {
                            return Some(value.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ParsedTokens {
    client_id: Option<String>,
    client_secret: Option<String>,
    refresh_token: Option<String>,
    access_token: Option<String>,
}

const PKCE_REDIRECT_URI: &str = "https://tidal.com/android/login/auth";

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PkceAuthParams {
    authorize_url: String,
    code_verifier: String,
    client_unique_key: String,
}

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
pub async fn load_saved_auth(state: State<'_, AppState>) -> Result<Option<AuthTokens>, SoneError> {
    log::debug!("[load_saved_auth]: path={:?}", state.settings_path);
    if let Some(settings) = state.load_settings() {
        log::debug!(
            "[load_saved_auth]: auth_tokens present: {}, has_credentials: {}",
            settings.auth_tokens.is_some(),
            !settings.client_id.is_empty()
        );
        if let Some(ref tokens) = settings.auth_tokens {
            let (id, secret) = resolve_credentials(&settings);
            let mut client = state.tidal_client.lock().await;
            client.tokens = Some(tokens.clone());
            client.set_credentials(&id, &secret);
            // Fetch session info to populate country_code for search
            match client.get_session_info().await {
                Ok(_) => log::debug!("[load_saved_auth]: tokens restored, country_code: {}", client.country_code),
                Err(e) => log::debug!("[load_saved_auth]: tokens restored but session info failed (will use default country_code): {}", e),
            }
            return Ok(Some(tokens.clone()));
        }
    } else {
        log::debug!("[load_saved_auth]: no settings file found");
    }
    Ok(None)
}

/// Returns saved client credentials so the Login page can pre-fill the advanced view.
/// Only returns user-provided credentials, never embedded defaults.
#[tauri::command]
pub fn get_saved_credentials(state: State<'_, AppState>) -> Result<(String, String), SoneError> {
    log::debug!("[get_saved_credentials]");
    if let Some(settings) = state.load_settings() {
        Ok((settings.client_id, settings.client_secret))
    } else {
        Ok((String::new(), String::new()))
    }
}

/// Returns the embedded default credentials (for the simple login flow).
/// Returns empty strings if only placeholders are compiled in.
#[tauri::command]
pub fn get_default_credentials() -> Result<(String, String), SoneError> {
    log::debug!("[get_default_credentials]");
    if crate::embedded_config::has_stream_keys() {
        Ok((
            crate::embedded_config::stream_key_a(),
            crate::embedded_config::stream_key_b(),
        ))
    } else {
        Ok((String::new(), String::new()))
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn parse_token_data(raw_text: String) -> Result<ParsedTokens, SoneError> {
    let text = raw_text.trim();
    let form_id = extract_form_value(text, "client_id");
    let form_secret = extract_form_value(text, "client_secret");
    let form_refresh = extract_form_value(text, "refresh_token");
    let json_id = extract_json_value(text, "client_id");
    let json_secret = extract_json_value(text, "client_secret");
    let json_refresh = extract_json_value(text, "refresh_token");
    let json_access = extract_json_value(text, "access_token");

    let client_id = form_id.or(json_id);
    let client_secret = form_secret.or(json_secret);
    let refresh_token = form_refresh.or(json_refresh);
    let access_token = json_access;

    if client_id.is_none() && refresh_token.is_none() && access_token.is_none() {
        return Err(SoneError::Parse(
            "Could not find any credentials or tokens in the pasted text.".into(),
        ));
    }
    Ok(ParsedTokens {
        client_id,
        client_secret,
        refresh_token,
        access_token,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn import_session(
    state: State<'_, AppState>,
    client_id: String,
    client_secret: String,
    refresh_token: String,
    access_token: Option<String>,
) -> Result<AuthTokens, SoneError> {
    log::debug!(
        "[import_session]: client_id={}",
        &client_id[..client_id.len().min(8)]
    );
    if client_id.is_empty() || refresh_token.is_empty() {
        return Err(SoneError::NotConfigured(
            "Client ID and refresh token are required".into(),
        ));
    }
    let mut client = state.tidal_client.lock().await;
    client.set_credentials(&client_id, &client_secret);

    let final_tokens = if let Some(at) = access_token.filter(|s| !s.is_empty()) {
        let tokens = AuthTokens {
            access_token: at,
            refresh_token: refresh_token.clone(),
            expires_in: 86400,
            token_type: "Bearer".to_string(),
            user_id: None,
        };
        client.tokens = Some(tokens.clone());
        let user_id = client.get_session_info().await.ok();
        let tokens = AuthTokens { user_id, ..tokens };
        client.tokens = Some(tokens.clone());
        tokens
    } else {
        client.tokens = Some(AuthTokens {
            access_token: String::new(),
            refresh_token: refresh_token.clone(),
            expires_in: 0,
            token_type: "Bearer".to_string(),
            user_id: None,
        });
        client.refresh_token().await?
    };

    let mut settings = state.load_settings().unwrap_or(Settings {
        auth_tokens: None,
        volume: 1.0,
        last_track_id: None,
        client_id: String::new(),
        client_secret: String::new(),
        minimize_to_tray: false,
        volume_normalization: false,
        exclusive_mode: false,
        exclusive_device: None,
        bit_perfect: false,
    });
    settings.auth_tokens = Some(final_tokens.clone());
    // Only persist user-provided credentials, not embedded defaults
    if !are_embedded_defaults(&client_id, &client_secret) {
        settings.client_id = client_id;
        settings.client_secret = client_secret;
    }
    state.save_settings(&settings)?;
    Ok(final_tokens)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn start_device_auth(
    state: State<'_, AppState>,
    client_id: String,
    client_secret: String,
) -> Result<DeviceAuthResponse, SoneError> {
    log::debug!("[start_device_auth]");
    let mut client = state.tidal_client.lock().await;
    client.set_credentials(&client_id, &client_secret);
    client.start_device_auth().await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn poll_device_auth(
    state: State<'_, AppState>,
    device_code: String,
    client_id: String,
    client_secret: String,
) -> Result<Option<AuthTokens>, SoneError> {
    log::debug!("[poll_device_auth]");
    let mut client = state.tidal_client.lock().await;
    client.set_credentials(&client_id, &client_secret);

    match client.poll_device_token(&device_code).await? {
        Some(tokens) => {
            // Save tokens and credentials
            let mut settings = state.load_settings().unwrap_or(Settings {
                auth_tokens: None,
                volume: 1.0,
                last_track_id: None,
                client_id: String::new(),
                client_secret: String::new(),
                minimize_to_tray: false,
                volume_normalization: false,
                exclusive_mode: false,
                exclusive_device: None,
                bit_perfect: false,
            });
            settings.auth_tokens = Some(tokens.clone());
            // Only persist user-provided credentials, not embedded defaults
            if !are_embedded_defaults(&client_id, &client_secret) {
                settings.client_id = client_id;
                settings.client_secret = client_secret;
            }
            state.save_settings(&settings)?;

            Ok(Some(tokens))
        }
        None => Ok(None), // Still pending
    }
}

#[tauri::command]
pub async fn refresh_tidal_auth(state: State<'_, AppState>) -> Result<AuthTokens, SoneError> {
    log::debug!("[refresh_tidal_auth]");
    let mut client = state.tidal_client.lock().await;
    let new_tokens = client.refresh_token().await?;

    // Save refreshed tokens to settings
    let mut settings = state.load_settings().unwrap_or(Settings {
        auth_tokens: None,
        volume: 1.0,
        last_track_id: None,
        client_id: client.client_id.clone(),
        client_secret: client.client_secret.clone(),
        minimize_to_tray: false,
        volume_normalization: false,
        exclusive_mode: false,
        exclusive_device: None,
        bit_perfect: false,
    });
    settings.auth_tokens = Some(new_tokens.clone());
    state.save_settings(&settings)?;

    Ok(new_tokens)
}

#[tauri::command(rename_all = "camelCase")]
pub fn start_pkce_auth(client_id: String) -> Result<PkceAuthParams, SoneError> {
    log::debug!("[start_pkce_auth]");
    if client_id.is_empty() {
        return Err(SoneError::NotConfigured("Client ID is required".into()));
    }

    // Generate PKCE values
    let mut rng = rand::rng();
    let random_bytes: [u8; 32] = rng.random();
    let code_verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes);

    let mut hasher = Sha256::new();
    hasher.update(code_verifier.as_bytes());
    let code_challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hasher.finalize());

    let client_unique_key = format!("{:016x}", rng.random::<u64>());

    let authorize_url = format!(
        "https://login.tidal.com/authorize?response_type=code&redirect_uri={}&client_id={}&lang=EN&appMode=android&client_unique_key={}&code_challenge={}&code_challenge_method=S256&restrict_signup=true",
        "https%3A%2F%2Ftidal.com%2Fandroid%2Flogin%2Fauth",
        client_id,
        client_unique_key,
        code_challenge,
    );

    Ok(PkceAuthParams {
        authorize_url,
        code_verifier,
        client_unique_key,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn complete_pkce_auth(
    state: State<'_, AppState>,
    code: String,
    code_verifier: String,
    client_unique_key: String,
    client_id: String,
    client_secret: String,
) -> Result<AuthTokens, SoneError> {
    log::debug!("[complete_pkce_auth]");
    let mut client = state.tidal_client.lock().await;
    client.set_credentials(&client_id, &client_secret);
    let tokens = client
        .exchange_pkce_code(&code, &code_verifier, PKCE_REDIRECT_URI, &client_unique_key)
        .await?;

    // Save tokens and credentials
    let mut settings = state.load_settings().unwrap_or(Settings {
        auth_tokens: None,
        volume: 1.0,
        last_track_id: None,
        client_id: String::new(),
        client_secret: String::new(),
        minimize_to_tray: false,
        volume_normalization: false,
        exclusive_mode: false,
        exclusive_device: None,
        bit_perfect: false,
    });
    settings.auth_tokens = Some(tokens.clone());
    // Only persist user-provided credentials, not embedded defaults
    if !are_embedded_defaults(&client_id, &client_secret) {
        settings.client_id = client_id;
        settings.client_secret = client_secret;
    }
    state.save_settings(&settings)?;

    Ok(tokens)
}

#[tauri::command]
pub async fn logout(state: State<'_, AppState>) -> Result<(), SoneError> {
    log::debug!("[logout]");
    // Clear tokens but preserve credentials for next login
    let mut client = state.tidal_client.lock().await;
    client.tokens = None;

    // Save credentials but clear auth tokens
    if let Some(mut settings) = state.load_settings() {
        settings.auth_tokens = None;
        settings.last_track_id = None;
        state.save_settings(&settings).ok();
    } else {
        fs::remove_file(&state.settings_path).ok();
    }

    // Clear all cached data
    state.disk_cache.clear().await;

    Ok(())
}

#[tauri::command]
pub async fn get_session_user_id(state: State<'_, AppState>) -> Result<u64, SoneError> {
    log::debug!("[get_session_user_id]");
    let mut client = state.tidal_client.lock().await;
    client.get_session_info().await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_user_profile(
    state: State<'_, AppState>,
    user_id: u64,
) -> Result<(String, Option<String>), SoneError> {
    log::debug!("[get_user_profile]: user_id={}", user_id);
    let mut client = state.tidal_client.lock().await;
    client.get_user_profile(user_id).await
}
