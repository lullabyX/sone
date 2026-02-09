mod audio;
mod tidal_api;

use audio::AudioPlayer;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;
use tidal_api::{AuthTokens, DeviceCode, PaginatedTracks, TidalAlbumDetail, TidalClient, TidalPlaylist, TidalTrack};


#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Settings {
    auth_tokens: Option<AuthTokens>,
    volume: f32,
    last_track_id: Option<u64>,
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
    };
    state.save_settings(&settings)?;

    Ok(tokens)
}

#[tauri::command]
fn load_saved_auth(state: State<AppState>) -> Result<Option<AuthTokens>, String> {
    println!("DEBUG: Loading saved auth from {:?}", state.settings_path);
    if let Some(settings) = state.load_settings() {
        println!("DEBUG: Settings loaded, auth_tokens present: {}", settings.auth_tokens.is_some());
        if let Some(tokens) = settings.auth_tokens {
            // Restore tokens to client
            let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
            client.tokens = Some(tokens.clone());
            println!("DEBUG: Tokens restored to client, user_id: {:?}", tokens.user_id);
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
    });
    settings.auth_tokens = Some(new_tokens.clone());
    state.save_settings(&settings)?;

    Ok(new_tokens)
}

#[tauri::command]
fn logout(state: State<AppState>) -> Result<(), String> {
    // Clear tokens
    let mut client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.tokens = None;

    // Delete settings file
    fs::remove_file(&state.settings_path).ok();

    Ok(())
}

#[tauri::command]
fn get_session_user_id(state: State<AppState>) -> Result<u64, String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_session_info()
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
fn get_stream_url(state: State<AppState>, track_id: u64, quality: String) -> Result<String, String> {
    let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
    client.get_stream_url(track_id, &quality)
}

// ==================== Audio Playback ====================

#[tauri::command(rename_all = "camelCase")]
fn play_tidal_track(state: State<AppState>, track_id: u64) -> Result<(), String> {
    // Get stream URL
    let stream_url = {
        let client = state.tidal_client.lock().map_err(|e| e.to_string())?;
        client.get_stream_url(track_id, "LOSSLESS")?
    };

    println!("DEBUG: Fetching stream from URL: {}", stream_url);
    
    // Fetch audio file
    let response = reqwest::blocking::get(&stream_url)
        .map_err(|e| format!("Failed to fetch stream from '{}': {}", stream_url, e))?;

    let bytes = response
        .bytes()
        .map_err(|e| format!("Failed to read stream: {}", e))?;

    // Play audio
    state.audio_player.play(bytes.to_vec())?;

    // Save last played track
    if let Some(mut settings) = state.load_settings() {
        settings.last_track_id = Some(track_id);
        state.save_settings(&settings).ok();
    }

    Ok(())
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
        .invoke_handler(tauri::generate_handler![
            greet,
            start_tidal_auth,
            poll_tidal_auth,
            load_saved_auth,
            refresh_tidal_auth,
            logout,
            get_session_user_id,
            get_user_playlists,
            get_playlist_tracks,
            get_favorite_tracks,
            get_album_detail,
            get_album_tracks,
            get_stream_url,
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
