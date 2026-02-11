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
use tidal_api::{AuthTokens, DeviceCode, PaginatedTracks, StreamInfo, TidalAlbumDetail, TidalClient, TidalCredit, TidalLyrics, TidalPlaylist, TidalSearchResults, TidalTrack};


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
    is_pkce: bool,
}

pub struct AppState {
    audio_player: AudioPlayer,
    tidal_client: Mutex<TidalClient>,
    settings_path: PathBuf,
}

impl AppState {
    fn new() -> Self {
        // Get config dir
        let mut settings_path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        settings_path.push("tide-vibe");
        fs::create_dir_all(&settings_path).ok();
        settings_path.push("settings.json");

        Self {
            audio_player: AudioPlayer::new(),
            tidal_client: Mutex::new(TidalClient::new()),
            settings_path,
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
}

// ==================== Tidal Authentication ====================

#[tauri::command]
fn start_tidal_auth(state: State<AppState>) -> Result<DeviceCode, String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.start_device_auth()
}

#[tauri::command(rename_all = "camelCase")]
fn poll_tidal_auth(state: State<AppState>, device_code: String) -> Result<AuthTokens, String> {
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    let tokens = client.poll_for_token(&device_code)?;

    // Save tokens to settings
    let settings = Settings {
        auth_tokens: Some(tokens.clone()),
        volume: 1.0,
        last_track_id: None,
        is_pkce: false,
    };
    state.save_settings(&settings)?;

    Ok(tokens)
}

#[tauri::command]
fn load_saved_auth(state: State<AppState>) -> Result<Option<AuthTokens>, String> {
    println!("DEBUG: Loading saved auth from {:?}", state.settings_path);
    if let Some(settings) = state.load_settings() {
        println!("DEBUG: Settings loaded, auth_tokens present: {}, is_pkce: {}", settings.auth_tokens.is_some(), settings.is_pkce);
        if let Some(tokens) = settings.auth_tokens {
            // Restore tokens to client
            let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
            client.tokens = Some(tokens.clone());
            client.is_pkce = settings.is_pkce;
            println!("DEBUG: Tokens restored to client, user_id: {:?}, is_pkce: {}", tokens.user_id, settings.is_pkce);
            return Ok(Some(tokens));
        }
    } else {
        println!("DEBUG: No settings file found");
    }
    Ok(None)
}

#[tauri::command]
fn refresh_tidal_auth(state: State<AppState>) -> Result<AuthTokens, String> {
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    let new_tokens = client.refresh_token()?;

    // Save refreshed tokens to settings
    let mut settings = state.load_settings().unwrap_or(Settings {
        auth_tokens: None,
        volume: 1.0,
        last_track_id: None,
        is_pkce: client.is_pkce,
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

#[tauri::command]
fn start_pkce_auth() -> Result<PkceAuthParams, String> {
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
        "https://login.tidal.com/authorize?response_type=code&redirect_uri={}&client_id=REDACTED_CLIENT_ID_PKCE&lang=EN&appMode=android&client_unique_key={}&code_challenge={}&code_challenge_method=S256&restrict_signup=true",
        "https%3A%2F%2Ftidal.com%2Fandroid%2Flogin%2Fauth",
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
) -> Result<AuthTokens, String> {
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    let tokens = client.exchange_pkce_code(&code, &code_verifier, PKCE_REDIRECT_URI, &client_unique_key)?;

    // Save tokens and mark as PKCE session
    let mut settings = state.load_settings().unwrap_or(Settings {
        auth_tokens: None,
        volume: 1.0,
        last_track_id: None,
        is_pkce: false,
    });
    settings.auth_tokens = Some(tokens.clone());
    settings.is_pkce = true;
    state.save_settings(&settings)?;

    Ok(tokens)
}

#[tauri::command]
fn logout(state: State<AppState>) -> Result<(), String> {
    // Clear tokens
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.tokens = None;
    client.is_pkce = false;

    // Delete settings file
    fs::remove_file(&state.settings_path).ok();

    Ok(())
}

#[tauri::command]
fn get_session_user_id(state: State<AppState>) -> Result<u64, String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_session_info()
}

#[tauri::command(rename_all = "camelCase")]
fn get_user_profile(state: State<AppState>, user_id: u64) -> Result<(String, Option<String>), String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_user_profile(user_id)
}

// ==================== Tidal API Calls ====================

#[tauri::command(rename_all = "camelCase")]
fn get_user_playlists(state: State<AppState>, user_id: u64) -> Result<Vec<TidalPlaylist>, String> {
    println!("DEBUG: Getting playlists for user_id: {}", user_id);
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
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
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_playlist_tracks(&playlist_id)
}

#[tauri::command(rename_all = "camelCase")]
fn get_favorite_tracks(
    state: State<AppState>,
    user_id: u64,
    offset: u32,
    limit: u32,
) -> Result<PaginatedTracks, String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_favorite_tracks(user_id, offset, limit)
}

#[tauri::command(rename_all = "camelCase")]
fn is_track_favorited(state: State<AppState>, user_id: u64, track_id: u64) -> Result<bool, String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.is_track_favorited(user_id, track_id)
}

#[tauri::command(rename_all = "camelCase")]
fn add_favorite_track(state: State<AppState>, user_id: u64, track_id: u64) -> Result<(), String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.add_favorite_track(user_id, track_id)
}

#[tauri::command(rename_all = "camelCase")]
fn remove_favorite_track(state: State<AppState>, user_id: u64, track_id: u64) -> Result<(), String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.remove_favorite_track(user_id, track_id)
}

#[tauri::command(rename_all = "camelCase")]
fn is_album_favorited(state: State<AppState>, user_id: u64, album_id: u64) -> Result<bool, String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.is_album_favorited(user_id, album_id)
}

#[tauri::command(rename_all = "camelCase")]
fn add_favorite_album(state: State<AppState>, user_id: u64, album_id: u64) -> Result<(), String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.add_favorite_album(user_id, album_id)
}

#[tauri::command(rename_all = "camelCase")]
fn remove_favorite_album(state: State<AppState>, user_id: u64, album_id: u64) -> Result<(), String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.remove_favorite_album(user_id, album_id)
}

#[tauri::command(rename_all = "camelCase")]
fn get_album_detail(state: State<AppState>, album_id: u64) -> Result<TidalAlbumDetail, String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_album_detail(album_id)
}

#[tauri::command(rename_all = "camelCase")]
fn get_album_tracks(
    state: State<AppState>,
    album_id: u64,
    offset: u32,
    limit: u32,
) -> Result<PaginatedTracks, String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_album_tracks(album_id, offset, limit)
}

#[tauri::command(rename_all = "camelCase")]
fn get_stream_url(state: State<AppState>, track_id: u64, quality: String) -> Result<StreamInfo, String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_stream_url(track_id, &quality)
}

// ==================== Search ====================

#[tauri::command(rename_all = "camelCase")]
fn search_tidal(state: State<AppState>, query: String, limit: u32) -> Result<TidalSearchResults, String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.search(&query, limit)
}

// ==================== Track Metadata (Lyrics, Credits, Radio) ====================

#[tauri::command(rename_all = "camelCase")]
fn get_track_lyrics(state: State<AppState>, track_id: u64) -> Result<TidalLyrics, String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_track_lyrics(track_id)
}

#[tauri::command(rename_all = "camelCase")]
fn get_track_credits(state: State<AppState>, track_id: u64) -> Result<Vec<TidalCredit>, String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_track_credits(track_id)
}

#[tauri::command(rename_all = "camelCase")]
fn get_track_radio(state: State<AppState>, track_id: u64, limit: u32) -> Result<Vec<TidalTrack>, String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_track_radio(track_id, limit)
}

// ==================== Audio Playback ====================

#[tauri::command(rename_all = "camelCase")]
fn play_tidal_track(state: State<AppState>, track_id: u64) -> Result<StreamInfo, String> {
    // Try quality tiers from highest to lowest.
    let stream_info = {
        let client = state.tidal_client.lock().map_err(|e| e.to_string())?;

        client.get_stream_url(track_id, "HI_RES_LOSSLESS")
            .or_else(|_| client.get_stream_url(track_id, "HI_RES"))
            .or_else(|_| client.get_stream_url(track_id, "LOSSLESS"))
            .or_else(|_| client.get_stream_url(track_id, "HIGH"))?
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
    state.audio_player.pause()
}

#[tauri::command]
fn resume_track(state: State<AppState>) -> Result<(), String> {
    state.audio_player.resume()
}

#[tauri::command]
fn stop_track(state: State<AppState>) -> Result<(), String> {
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
    state.audio_player.seek(position_secs)
}

#[tauri::command]
fn is_track_finished(state: State<AppState>) -> Result<bool, String> {
    state.audio_player.is_finished()
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
            start_tidal_auth,
            poll_tidal_auth,
            load_saved_auth,
            refresh_tidal_auth,
            start_pkce_auth,
            complete_pkce_auth,
            logout,
            get_session_user_id,
            get_user_profile,
            get_user_playlists,
            get_playlist_tracks,
            get_favorite_tracks,
            is_track_favorited,
            add_favorite_track,
            remove_favorite_track,
            is_album_favorited,
            add_favorite_album,
            remove_favorite_album,
            get_album_detail,
            get_album_tracks,
            get_stream_url,
            search_tidal,
            get_track_lyrics,
            get_track_credits,
            get_track_radio,
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
