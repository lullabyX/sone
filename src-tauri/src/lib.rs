mod audio;
mod tidal_api;

use audio::AudioPlayer;
use base64::Engine;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;
use std::time::{SystemTime, UNIX_EPOCH};
use tidal_api::{AuthTokens, DeviceAuthResponse, HomePageResponse, PaginatedTracks, StreamInfo, SuggestionsResponse, TidalAlbumDetail, TidalArtistDetail, TidalClient, TidalCredit, TidalLyrics, TidalPlaylist, TidalSearchResults, TidalTrack};


#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Settings {
    auth_tokens: Option<AuthTokens>,
    volume: f32,
    last_track_id: Option<u64>,
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    client_secret: String,
}

const CACHE_TTL_SECS: u64 = 12 * 60 * 60; // 12 hours

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct CacheMeta {
    #[serde(default)]
    home_page_ts: u64,
    #[serde(default)]
    favorite_artists_ts: u64,
}

pub struct AppState {
    audio_player: AudioPlayer,
    tidal_client: Mutex<TidalClient>,
    settings_path: PathBuf,
    cache_dir: PathBuf,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl AppState {
    fn new() -> Self {
        // Get config dir
        let mut config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        config_dir.push("tide-vibe");
        fs::create_dir_all(&config_dir).ok();

        let settings_path = config_dir.join("settings.json");
        let cache_dir = config_dir.join("cache");
        fs::create_dir_all(&cache_dir).ok();

        Self {
            audio_player: AudioPlayer::new(),
            tidal_client: Mutex::new(TidalClient::new()),
            settings_path,
            cache_dir,
        }
    }

    fn load_settings(&self) -> Option<Settings> {
        if let Ok(content) = fs::read_to_string(&self.settings_path) {
            serde_json::from_str(&content).ok()
        } else {
            None
        }
    }

    fn save_settings(&self, settings: &Settings) -> Result<(), String> {
        let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
        fs::write(&self.settings_path, json).map_err(|e| e.to_string())
    }

    // ---- Cache helpers ----

    fn load_cache_meta(&self) -> CacheMeta {
        let path = self.cache_dir.join("cache_meta.json");
        if let Ok(content) = fs::read_to_string(&path) {
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            CacheMeta::default()
        }
    }

    fn save_cache_meta(&self, meta: &CacheMeta) -> Result<(), String> {
        let path = self.cache_dir.join("cache_meta.json");
        let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| e.to_string())
    }

    fn read_cache_file(&self, name: &str) -> Option<String> {
        let path = self.cache_dir.join(name);
        fs::read_to_string(&path).ok()
    }

    fn write_cache_file(&self, name: &str, content: &str) -> Result<(), String> {
        let path = self.cache_dir.join(name);
        fs::write(&path, content).map_err(|e| e.to_string())
    }

    fn is_cache_fresh(&self, timestamp: u64) -> bool {
        let now = now_secs();
        now.saturating_sub(timestamp) < CACHE_TTL_SECS
    }
}

// ==================== Tidal Authentication ====================

#[tauri::command]
fn load_saved_auth(state: State<AppState>) -> Result<Option<AuthTokens>, String> {
    println!("DEBUG: Loading saved auth from {:?}", state.settings_path);
    if let Some(settings) = state.load_settings() {
        println!("DEBUG: Settings loaded, auth_tokens present: {}, has_credentials: {}", settings.auth_tokens.is_some(), !settings.client_id.is_empty());
        if let Some(tokens) = settings.auth_tokens {
            // Restore tokens and credentials to client
            let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
            client.tokens = Some(tokens.clone());
            client.set_credentials(&settings.client_id, &settings.client_secret);
            // Fetch session info to populate country_code for search
            match client.get_session_info() {
                Ok(_) => println!("DEBUG: Tokens restored, country_code: {}", client.country_code),
                Err(e) => println!("DEBUG: Tokens restored but session info failed (will use default country_code): {}", e),
            }
            return Ok(Some(tokens));
        }
    } else {
        println!("DEBUG: No settings file found");
    }
    Ok(None)
}

// ==================== Token Import (for web player client IDs) ====================

/// Extract a value for `key=<value>` from URL-encoded / form-data text.
fn extract_form_value(text: &str, key: &str) -> Option<String> {
    let pattern = format!("{}=", key);
    let start = text.find(&pattern)? + pattern.len();
    let rest = &text[start..];
    let end = rest
        .find(|c: char| c == '&' || c == '"' || c == '\'' || c.is_whitespace())
        .unwrap_or(rest.len());
    let value = &rest[..end];
    if value.is_empty() { None } else { Some(value.to_string()) }
}

/// Extract a value for `"key": "value"` from JSON-like text.
fn extract_json_value(text: &str, key: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let pat = format!("{q}{key}{q}", q = quote, key = key);
        if let Some(key_pos) = text.find(pat.as_str()) {
            let after_key = &text[key_pos + pat.len()..];
            let trimmed = after_key.trim_start();
            let trimmed = if trimmed.starts_with(':') {
                trimmed[1..].trim_start()
            } else if trimmed.starts_with('=') {
                trimmed[1..].trim_start()
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
struct ParsedTokens {
    client_id: Option<String>,
    client_secret: Option<String>,
    refresh_token: Option<String>,
    access_token: Option<String>,
}

#[tauri::command(rename_all = "camelCase")]
fn parse_token_data(raw_text: String) -> Result<ParsedTokens, String> {
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
        return Err("Could not find any credentials or tokens in the pasted text.".to_string());
    }
    Ok(ParsedTokens { client_id, client_secret, refresh_token, access_token })
}

#[tauri::command(rename_all = "camelCase")]
fn import_session(
    state: State<AppState>,
    client_id: String,
    client_secret: String,
    refresh_token: String,
    access_token: Option<String>,
) -> Result<AuthTokens, String> {
    println!("DEBUG [import_session]: client_id={}", &client_id[..client_id.len().min(8)]);
    if client_id.is_empty() || refresh_token.is_empty() {
        return Err("Client ID and refresh token are required".to_string());
    }
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
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
        let user_id = client.get_session_info().ok();
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
        client.refresh_token()?
    };

    let mut settings = state.load_settings().unwrap_or(Settings {
        auth_tokens: None,
        volume: 1.0,
        last_track_id: None,
        client_id: String::new(),
        client_secret: String::new(),
    });
    settings.auth_tokens = Some(final_tokens.clone());
    settings.client_id = client_id;
    settings.client_secret = client_secret;
    state.save_settings(&settings)?;
    Ok(final_tokens)
}

// ==================== Device Code Auth ====================

#[tauri::command(rename_all = "camelCase")]
fn start_device_auth(
    state: State<AppState>,
    client_id: String,
    client_secret: String,
) -> Result<DeviceAuthResponse, String> {
    println!("DEBUG [start_device_auth]");
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.set_credentials(&client_id, &client_secret);
    client.start_device_auth()
}

#[tauri::command(rename_all = "camelCase")]
fn poll_device_auth(
    state: State<AppState>,
    device_code: String,
    client_id: String,
    client_secret: String,
) -> Result<Option<AuthTokens>, String> {
    println!("DEBUG [poll_device_auth]");
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.set_credentials(&client_id, &client_secret);

    match client.poll_device_token(&device_code)? {
        Some(tokens) => {
            // Save tokens and credentials
            let mut settings = state.load_settings().unwrap_or(Settings {
                auth_tokens: None,
                volume: 1.0,
                last_track_id: None,
                client_id: String::new(),
                client_secret: String::new(),
            });
            settings.auth_tokens = Some(tokens.clone());
            settings.client_id = client_id;
            settings.client_secret = client_secret;
            state.save_settings(&settings)?;

            Ok(Some(tokens))
        }
        None => Ok(None), // Still pending
    }
}

/// Returns saved client credentials so the Login page can pre-fill them.
#[tauri::command]
fn get_saved_credentials(state: State<AppState>) -> Result<(String, String), String> {
    println!("DEBUG [get_saved_credentials]");
    if let Some(settings) = state.load_settings() {
        Ok((settings.client_id, settings.client_secret))
    } else {
        Ok((String::new(), String::new()))
    }
}

#[tauri::command]
fn refresh_tidal_auth(state: State<AppState>) -> Result<AuthTokens, String> {
    println!("DEBUG [refresh_tidal_auth]");
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    let new_tokens = client.refresh_token()?;

    // Save refreshed tokens to settings
    let mut settings = state.load_settings().unwrap_or(Settings {
        auth_tokens: None,
        volume: 1.0,
        last_track_id: None,
        client_id: client.client_id.clone(),
        client_secret: client.client_secret.clone(),
    });
    settings.auth_tokens = Some(new_tokens.clone());
    state.save_settings(&settings)?;

    Ok(new_tokens)
}

const PKCE_REDIRECT_URI: &str = "https://tidal.com/android/login/auth";

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PkceAuthParams {
    authorize_url: String,
    code_verifier: String,
    client_unique_key: String,
}

#[tauri::command(rename_all = "camelCase")]
fn start_pkce_auth(client_id: String) -> Result<PkceAuthParams, String> {
    println!("DEBUG [start_pkce_auth]");
    if client_id.is_empty() {
        return Err("Client ID is required".to_string());
    }

    // Generate PKCE values
    let mut rng = rand::rng();
    let random_bytes: [u8; 32] = rng.random();
    let code_verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(random_bytes);

    let mut hasher = Sha256::new();
    hasher.update(code_verifier.as_bytes());
    let code_challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(hasher.finalize());

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
fn complete_pkce_auth(
    state: State<AppState>,
    code: String,
    code_verifier: String,
    client_unique_key: String,
    client_id: String,
    client_secret: String,
) -> Result<AuthTokens, String> {
    println!("DEBUG [complete_pkce_auth]");
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.set_credentials(&client_id, &client_secret);
    let tokens = client.exchange_pkce_code(&code, &code_verifier, PKCE_REDIRECT_URI, &client_unique_key)?;

    // Save tokens and credentials
    let mut settings = state.load_settings().unwrap_or(Settings {
        auth_tokens: None,
        volume: 1.0,
        last_track_id: None,
        client_id: String::new(),
        client_secret: String::new(),
    });
    settings.auth_tokens = Some(tokens.clone());
    settings.client_id = client_id;
    settings.client_secret = client_secret;
    state.save_settings(&settings)?;

    Ok(tokens)
}

#[tauri::command]
fn logout(state: State<AppState>) -> Result<(), String> {
    println!("DEBUG [logout]");
    // Clear tokens but preserve credentials for next login
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
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
    if let Ok(entries) = fs::read_dir(&state.cache_dir) {
        for entry in entries.flatten() {
            fs::remove_file(entry.path()).ok();
        }
    }

    Ok(())
}

#[tauri::command]
fn get_session_user_id(state: State<AppState>) -> Result<u64, String> {
    println!("DEBUG [get_session_user_id]");
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_session_info()
}

#[tauri::command(rename_all = "camelCase")]
fn get_user_profile(state: State<AppState>, user_id: u64) -> Result<(String, Option<String>), String> {
    println!("DEBUG [get_user_profile]: user_id={}", user_id);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_user_profile(user_id)
}

// ==================== Tidal API Calls ====================

#[tauri::command(rename_all = "camelCase")]
fn get_user_playlists(state: State<AppState>, user_id: u64) -> Result<Vec<TidalPlaylist>, String> {
    println!("DEBUG: Getting playlists for user_id: {}", user_id);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    let result = client.get_user_playlists(user_id);
    match &result {
        Ok(playlists) => println!("DEBUG: Got {} playlists", playlists.len()),
        Err(e) => {
            println!("DEBUG: Failed to get playlists: {}", e);
        }
    }
    result
}

#[tauri::command(rename_all = "camelCase")]
fn get_playlist_tracks(
    state: State<AppState>,
    playlist_id: String,
) -> Result<Vec<TidalTrack>, String> {
    println!("DEBUG [get_playlist_tracks]: playlist_id={}", playlist_id);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_playlist_tracks(&playlist_id)
}

#[tauri::command(rename_all = "camelCase")]
fn get_favorite_playlists(state: State<AppState>, user_id: u64) -> Result<Vec<TidalPlaylist>, String> {
    println!("DEBUG [get_favorite_playlists]: user_id={}", user_id);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_favorite_playlists(user_id)
}

#[tauri::command(rename_all = "camelCase")]
fn get_favorite_albums(state: State<AppState>, user_id: u64, limit: u32) -> Result<Vec<TidalAlbumDetail>, String> {
    println!("DEBUG [get_favorite_albums]: user_id={}, limit={}", user_id, limit);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_favorite_albums(user_id, limit)
}

#[tauri::command(rename_all = "camelCase")]
fn create_playlist(
    state: State<AppState>,
    user_id: u64,
    title: String,
    description: String,
) -> Result<TidalPlaylist, String> {
    println!("DEBUG [create_playlist]: user_id={}, title={}", user_id, title);
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.create_playlist(user_id, &title, &description)
}

#[tauri::command(rename_all = "camelCase")]
fn add_track_to_playlist(
    state: State<AppState>,
    playlist_id: String,
    track_id: u64,
) -> Result<(), String> {
    println!("DEBUG [add_track_to_playlist]: playlist_id={}, track_id={}", playlist_id, track_id);
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.add_track_to_playlist(&playlist_id, track_id)
}

#[tauri::command(rename_all = "camelCase")]
fn remove_track_from_playlist(
    state: State<AppState>,
    playlist_id: String,
    index: u32,
) -> Result<(), String> {
    println!("DEBUG [remove_track_from_playlist]: playlist_id={}, index={}", playlist_id, index);
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.remove_track_from_playlist(&playlist_id, index)
}

#[tauri::command(rename_all = "camelCase")]
fn get_favorite_tracks(
    state: State<AppState>,
    user_id: u64,
    offset: u32,
    limit: u32,
) -> Result<PaginatedTracks, String> {
    println!("DEBUG [get_favorite_tracks]: user_id={}, offset={}, limit={}", user_id, offset, limit);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_favorite_tracks(user_id, offset, limit)
}

#[tauri::command(rename_all = "camelCase")]
fn get_favorite_track_ids(state: State<AppState>, user_id: u64) -> Result<Vec<u64>, String> {
    println!("DEBUG [get_favorite_track_ids]: user_id={}", user_id);
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_favorite_track_ids(user_id)
}

#[tauri::command(rename_all = "camelCase")]
fn is_track_favorited(state: State<AppState>, user_id: u64, track_id: u64) -> Result<bool, String> {
    println!("DEBUG [is_track_favorited]: user_id={}, track_id={}", user_id, track_id);
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.is_track_favorited(user_id, track_id)
}

#[tauri::command(rename_all = "camelCase")]
fn add_favorite_track(state: State<AppState>, user_id: u64, track_id: u64) -> Result<(), String> {
    println!("DEBUG [add_favorite_track]: user_id={}, track_id={}", user_id, track_id);
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.add_favorite_track(user_id, track_id)
}

#[tauri::command(rename_all = "camelCase")]
fn remove_favorite_track(state: State<AppState>, user_id: u64, track_id: u64) -> Result<(), String> {
    println!("DEBUG [remove_favorite_track]: user_id={}, track_id={}", user_id, track_id);
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.remove_favorite_track(user_id, track_id)
}

#[tauri::command(rename_all = "camelCase")]
fn is_album_favorited(state: State<AppState>, user_id: u64, album_id: u64) -> Result<bool, String> {
    println!("DEBUG [is_album_favorited]: user_id={}, album_id={}", user_id, album_id);
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.is_album_favorited(user_id, album_id)
}

#[tauri::command(rename_all = "camelCase")]
fn add_favorite_album(state: State<AppState>, user_id: u64, album_id: u64) -> Result<(), String> {
    println!("DEBUG [add_favorite_album]: user_id={}, album_id={}", user_id, album_id);
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.add_favorite_album(user_id, album_id)
}

#[tauri::command(rename_all = "camelCase")]
fn remove_favorite_album(state: State<AppState>, user_id: u64, album_id: u64) -> Result<(), String> {
    println!("DEBUG [remove_favorite_album]: user_id={}, album_id={}", user_id, album_id);
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.remove_favorite_album(user_id, album_id)
}

#[tauri::command(rename_all = "camelCase")]
fn add_favorite_playlist(state: State<AppState>, user_id: u64, playlist_uuid: String) -> Result<(), String> {
    println!("DEBUG [add_favorite_playlist]: user_id={}, playlist_uuid={}", user_id, playlist_uuid);
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.add_favorite_playlist(user_id, &playlist_uuid)
}

#[tauri::command(rename_all = "camelCase")]
fn remove_favorite_playlist(state: State<AppState>, user_id: u64, playlist_uuid: String) -> Result<(), String> {
    println!("DEBUG [remove_favorite_playlist]: user_id={}, playlist_uuid={}", user_id, playlist_uuid);
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.remove_favorite_playlist(user_id, &playlist_uuid)
}

#[tauri::command(rename_all = "camelCase")]
fn add_tracks_to_playlist(state: State<AppState>, playlist_id: String, track_ids: Vec<u64>) -> Result<(), String> {
    println!("DEBUG [add_tracks_to_playlist]: playlist_id={}, count={}", playlist_id, track_ids.len());
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.add_tracks_to_playlist(&playlist_id, &track_ids)
}

#[tauri::command(rename_all = "camelCase")]
fn get_album_detail(state: State<AppState>, album_id: u64) -> Result<TidalAlbumDetail, String> {
    println!("DEBUG [get_album_detail]: album_id={}", album_id);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_album_detail(album_id)
}

#[tauri::command(rename_all = "camelCase")]
fn get_album_tracks(
    state: State<AppState>,
    album_id: u64,
    offset: u32,
    limit: u32,
) -> Result<PaginatedTracks, String> {
    println!("DEBUG [get_album_tracks]: album_id={}, offset={}, limit={}", album_id, offset, limit);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_album_tracks(album_id, offset, limit)
}

#[tauri::command(rename_all = "camelCase")]
fn get_stream_url(state: State<AppState>, track_id: u64, quality: String) -> Result<StreamInfo, String> {
    println!("DEBUG [get_stream_url]: track_id={}, quality={}", track_id, quality);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_stream_url(track_id, &quality)
}

// ==================== Search ====================

#[tauri::command(rename_all = "camelCase")]
fn search_tidal(state: State<AppState>, query: String, limit: u32) -> Result<TidalSearchResults, String> {
    println!("DEBUG [search_tidal]: query=\"{}\", limit={}", query, limit);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.search(&query, limit)
}

#[tauri::command(rename_all = "camelCase")]
fn get_suggestions(state: State<AppState>, query: String, limit: u32) -> SuggestionsResponse {
    println!("DEBUG [get_suggestions]: query=\"{}\", limit={}", query, limit);
    if let Ok(mut client) = state.tidal_client.lock() {
        client.get_suggestions(&query, limit)
    } else {
        SuggestionsResponse { text_suggestions: vec![], direct_hits: vec![] }
    }
}

// ==================== Home Page & Pages API ====================

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HomePageCached {
    home: HomePageResponse,
    is_stale: bool,
}

#[tauri::command]
fn get_home_page(state: State<AppState>) -> Result<HomePageCached, String> {
    println!("DEBUG [get_home_page]");
    let meta = state.load_cache_meta();

    // Try to serve from cache first
    if meta.home_page_ts > 0 {
        if let Some(cached) = state.read_cache_file("home_page.json") {
            if let Ok(home) = serde_json::from_str::<HomePageResponse>(&cached) {
                let is_stale = !state.is_cache_fresh(meta.home_page_ts);
                return Ok(HomePageCached { home, is_stale });
            }
        }
    }

    // No valid cache — fetch fresh
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    let home = client.get_home_page()?;

    // Cache the result
    if let Ok(json) = serde_json::to_string(&home) {
        state.write_cache_file("home_page.json", &json).ok();
        let mut meta = state.load_cache_meta();
        meta.home_page_ts = now_secs();
        state.save_cache_meta(&meta).ok();
    }

    Ok(HomePageCached { home, is_stale: false })
}

#[tauri::command]
fn refresh_home_page(state: State<AppState>) -> Result<HomePageResponse, String> {
    println!("DEBUG [refresh_home_page]");
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    let home = client.get_home_page()?;

    // Update cache
    if let Ok(json) = serde_json::to_string(&home) {
        state.write_cache_file("home_page.json", &json).ok();
        let mut meta = state.load_cache_meta();
        meta.home_page_ts = now_secs();
        state.save_cache_meta(&meta).ok();
    }

    Ok(home)
}

#[tauri::command(rename_all = "camelCase")]
fn get_favorite_artists(state: State<AppState>, user_id: u64, limit: u32) -> Result<Vec<TidalArtistDetail>, String> {
    println!("DEBUG [get_favorite_artists]: user_id={}, limit={}", user_id, limit);
    let meta = state.load_cache_meta();

    // Try cache
    if state.is_cache_fresh(meta.favorite_artists_ts) {
        if let Some(cached) = state.read_cache_file("favorite_artists.json") {
            if let Ok(artists) = serde_json::from_str::<Vec<TidalArtistDetail>>(&cached) {
                return Ok(artists);
            }
        }
    }

    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    let artists = client.get_favorite_artists(user_id, limit)?;

    // Cache
    if let Ok(json) = serde_json::to_string(&artists) {
        state.write_cache_file("favorite_artists.json", &json).ok();
        let mut meta = state.load_cache_meta();
        meta.favorite_artists_ts = now_secs();
        state.save_cache_meta(&meta).ok();
    }

    Ok(artists)
}

#[tauri::command(rename_all = "camelCase")]
fn get_page_section(state: State<AppState>, api_path: String) -> Result<HomePageResponse, String> {
    println!("DEBUG [get_page_section]: api_path={}", api_path);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_page(&api_path)
}

#[tauri::command(rename_all = "camelCase")]
fn get_mix_items(state: State<AppState>, mix_id: String) -> Result<Vec<TidalTrack>, String> {
    println!("DEBUG [get_mix_items]: mix_id={}", mix_id);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_mix_items(&mix_id)
}

#[tauri::command(rename_all = "camelCase")]
fn get_artist_detail(state: State<AppState>, artist_id: u64) -> Result<TidalArtistDetail, String> {
    println!("DEBUG [get_artist_detail]: artist_id={}", artist_id);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_artist_detail(artist_id)
}

#[tauri::command(rename_all = "camelCase")]
fn get_artist_top_tracks(state: State<AppState>, artist_id: u64, limit: u32) -> Result<Vec<TidalTrack>, String> {
    println!("DEBUG [get_artist_top_tracks]: artist_id={}, limit={}", artist_id, limit);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_artist_top_tracks(artist_id, limit)
}

#[tauri::command(rename_all = "camelCase")]
fn get_artist_albums(state: State<AppState>, artist_id: u64, limit: u32) -> Result<Vec<TidalAlbumDetail>, String> {
    println!("DEBUG [get_artist_albums]: artist_id={}, limit={}", artist_id, limit);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_artist_albums(artist_id, limit)
}

#[tauri::command(rename_all = "camelCase")]
fn get_artist_bio(state: State<AppState>, artist_id: u64) -> Result<String, String> {
    println!("DEBUG [get_artist_bio]: artist_id={}", artist_id);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_artist_bio(artist_id)
}

/// Debug command: returns the raw JSON structure of multiple page endpoints
/// so we can see what format Tidal is using and what sections are available.
#[tauri::command]
fn debug_home_page_raw(state: State<AppState>) -> Result<String, String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    let tokens = client.tokens.as_ref().ok_or("Not authenticated")?;

    let http = reqwest::blocking::Client::new();
    let mut summary = String::new();

    let endpoints = [
        "pages/home",
        "pages/for_you",
        "pages/my_collection_recently_played",
        "pages/my_collection_my_mixes",
        "pages/explore",
        "pages/suggested_new_tracks_for_you",
        "pages/suggested_new_albums_for_you",
        "pages/show/essential_album",
    ];

    for endpoint in &endpoints {
        summary.push_str(&format!("=== {} ===\n", endpoint));

        let response = http
            .get(format!("https://api.tidal.com/v1/{}", endpoint))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", "US"), ("deviceType", "BROWSER"), ("locale", "en_US")])
            .send();

        match response {
            Ok(resp) => {
                let status = resp.status();
                if !status.is_success() {
                    summary.push_str(&format!("  ERROR: status {}\n\n", status));
                    continue;
                }
                let body = resp.text().unwrap_or_default();
                let json: serde_json::Value = match serde_json::from_str(&body) {
                    Ok(j) => j,
                    Err(e) => { summary.push_str(&format!("  PARSE ERROR: {}\n\n", e)); continue; }
                };

                summary.push_str(&format!("  Top-level keys: {:?}\n",
                    json.as_object().map(|o| o.keys().collect::<Vec<_>>()).unwrap_or_default()));

                // V1
                if let Some(rows) = json.get("rows").and_then(|r| r.as_array()) {
                    summary.push_str(&format!("  FORMAT: V1 (rows), {} rows\n", rows.len()));
                    for (i, row) in rows.iter().enumerate() {
                        if let Some(modules) = row.get("modules").and_then(|m| m.as_array()) {
                            for module in modules {
                                let mtype = module.get("type").and_then(|t| t.as_str()).unwrap_or("?");
                                let title = module.get("title").and_then(|t| t.as_str()).unwrap_or("(no title)");
                                let item_count = module.get("pagedList")
                                    .and_then(|pl| pl.get("items"))
                                    .and_then(|i| i.as_array())
                                    .map(|a| a.len())
                                    .or_else(|| module.get("highlights").and_then(|h| h.as_array()).map(|a| a.len()))
                                    .unwrap_or(0);
                                let has_more = module.get("showMore").is_some();
                                summary.push_str(&format!("    Row {}: type={:<30} title=\"{}\" items={} more={}\n",
                                    i, mtype, title, item_count, has_more));
                            }
                        }
                    }
                }

                // V2
                if let Some(items) = json.get("items").and_then(|i| i.as_array()) {
                    summary.push_str(&format!("  FORMAT: V2 (items), {} sections\n", items.len()));
                    for (i, item) in items.iter().enumerate() {
                        let stype = item.get("type").and_then(|t| t.as_str()).unwrap_or("?");
                        let title = item.get("title")
                            .and_then(|t| t.as_str())
                            .or_else(|| item.get("titleTextInfo").and_then(|ti| ti.get("text")).and_then(|t| t.as_str()))
                            .unwrap_or("(no title)");
                        let item_count = item.get("items").and_then(|i| i.as_array()).map(|a| a.len()).unwrap_or(0);
                        let has_view_all = item.get("viewAll").is_some() || item.get("showMore").is_some();
                        let first_type = item.get("items").and_then(|i| i.as_array())
                            .and_then(|a| a.first()).and_then(|f| f.get("type")).and_then(|t| t.as_str()).unwrap_or("?");
                        summary.push_str(&format!("    Sec {}: type={:<35} title=\"{}\" items={} first={} more={}\n",
                            i, stype, title, item_count, first_type, has_view_all));
                    }
                }
            }
            Err(e) => {
                summary.push_str(&format!("  FETCH ERROR: {}\n", e));
            }
        }
        summary.push('\n');
    }

    Ok(summary)
}

// ==================== Track Metadata (Lyrics, Credits, Radio) ====================

#[tauri::command(rename_all = "camelCase")]
fn get_track_lyrics(state: State<AppState>, track_id: u64) -> Result<TidalLyrics, String> {
    println!("DEBUG [get_track_lyrics]: track_id={}", track_id);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_track_lyrics(track_id)
}

#[tauri::command(rename_all = "camelCase")]
fn get_track_credits(state: State<AppState>, track_id: u64) -> Result<Vec<TidalCredit>, String> {
    println!("DEBUG [get_track_credits]: track_id={}", track_id);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_track_credits(track_id)
}

#[tauri::command(rename_all = "camelCase")]
fn get_track_radio(state: State<AppState>, track_id: u64, limit: u32) -> Result<Vec<TidalTrack>, String> {
    println!("DEBUG [get_track_radio]: track_id={}, limit={}", track_id, limit);
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_track_radio(track_id, limit)
}

// ==================== Audio Playback ====================

#[tauri::command(rename_all = "camelCase")]
fn play_tidal_track(state: State<AppState>, track_id: u64) -> Result<StreamInfo, String> {
    // Try quality tiers from highest to lowest.
    // Without client_secret, skip Hi-Res (those credentials typically return
    // encrypted DASH streams that require Widevine). With a secret, the
    // confidential PKCE credentials may return unencrypted Hi-Res BTS streams.
    let stream_info = {
        let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
        let has_secret = !client.client_secret.is_empty();

        if has_secret {
            client.get_stream_url(track_id, "HI_RES_LOSSLESS")
                .or_else(|_| client.get_stream_url(track_id, "HI_RES"))
                .or_else(|_| client.get_stream_url(track_id, "LOSSLESS"))
                .or_else(|_| client.get_stream_url(track_id, "HIGH"))?
        } else {
            client.get_stream_url(track_id, "LOSSLESS")
                .or_else(|_| client.get_stream_url(track_id, "HIGH"))?
        }
    };

    println!(
        "DEBUG: Playing track {} — quality={:?}, bitDepth={:?}, sampleRate={:?}, codec={:?}, dash={}",
        track_id, stream_info.audio_quality, stream_info.bit_depth, stream_info.sample_rate,
        stream_info.codec, stream_info.manifest.is_some()
    );

    let uri = if let Some(ref mpd) = stream_info.manifest {
        // DASH: pass MPD manifest as a data URI for GStreamer's dashdemux.
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(mpd.as_bytes());
        format!("data:application/dash+xml;base64,{}", b64)
    } else {
        // BTS: direct URL.
        stream_info.url.clone()
    };

    state.audio_player.play_url(&uri)?;

    // Save last played track
    if let Some(mut settings) = state.load_settings() {
        settings.last_track_id = Some(track_id);
        state.save_settings(&settings).ok();
    }

    Ok(stream_info)
}

#[tauri::command]
fn pause_track(state: State<AppState>) -> Result<(), String> {
    println!("DEBUG [pause_track]");
    state.audio_player.pause()
}

#[tauri::command]
fn resume_track(state: State<AppState>) -> Result<(), String> {
    println!("DEBUG [resume_track]");
    state.audio_player.resume()
}

#[tauri::command]
fn stop_track(state: State<AppState>) -> Result<(), String> {
    println!("DEBUG [stop_track]");
    state.audio_player.stop()
}

#[tauri::command]
fn set_volume(state: State<AppState>, level: f32) -> Result<(), String> {
    state.audio_player.set_volume(level)?;

    // Save volume to settings
    if let Some(mut settings) = state.load_settings() {
        settings.volume = level;
        state.save_settings(&settings).ok();
    }

    Ok(())
}

#[tauri::command]
fn get_playback_position(state: State<AppState>) -> Result<f32, String> {
    state.audio_player.get_position()
}

#[tauri::command(rename_all = "camelCase")]
fn seek_track(state: State<AppState>, position_secs: f32) -> Result<(), String> {
    println!("DEBUG [seek_track]: position_secs={:.1}", position_secs);
    state.audio_player.seek(position_secs)
}

#[tauri::command]
fn is_track_finished(state: State<AppState>) -> Result<bool, String> {
    state.audio_player.is_finished()
}

#[tauri::command]
async fn get_image_bytes(url: String) -> Result<Vec<u8>, String> {
    println!("DEBUG [get_image_bytes]: url={}", url);
    let res = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    Ok(bytes.to_vec())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new();

    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            greet,
            load_saved_auth,
            get_saved_credentials,
            parse_token_data,
            import_session,
            start_device_auth,
            poll_device_auth,
            refresh_tidal_auth,
            start_pkce_auth,
            complete_pkce_auth,
            logout,
            get_session_user_id,
            get_user_profile,
            get_user_playlists,
            get_playlist_tracks,
            get_favorite_playlists,
            get_favorite_albums,
            create_playlist,
            add_track_to_playlist,
            remove_track_from_playlist,
            get_favorite_tracks,
            get_favorite_track_ids,
            is_track_favorited,
            add_favorite_track,
            remove_favorite_track,
            is_album_favorited,
            add_favorite_album,
            remove_favorite_album,
            add_favorite_playlist,
            remove_favorite_playlist,
            add_tracks_to_playlist,
            get_album_detail,
            get_album_tracks,
            get_stream_url,
            search_tidal,
            get_suggestions,
            get_track_lyrics,
            get_track_credits,
            get_track_radio,
            get_home_page,
            refresh_home_page,
            get_favorite_artists,
            get_page_section,
            get_mix_items,
            get_artist_detail,
            get_artist_top_tracks,
            get_artist_albums,
            get_artist_bio,
            debug_home_page_raw,
            get_image_bytes,
            play_tidal_track,
            pause_track,
            resume_track,
            stop_track,
            set_volume,
            get_playback_position,
            seek_track,
            is_track_finished
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
