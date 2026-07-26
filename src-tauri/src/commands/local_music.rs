use crate::local_music::{self, LocalTrack};
use crate::SoneError;
use serde::Deserialize;
use std::path::Path;
use tauri::Emitter;
use tauri::State;

use crate::AppState;

#[tauri::command(rename_all = "camelCase")]
pub async fn pick_local_folder(
    app_handle: tauri::AppHandle,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_dialog::FilePath;

    let (tx, rx) = std::sync::mpsc::channel::<Option<FilePath>>();
    app_handle.dialog().file().pick_folder(move |path| {
        tx.send(path).ok();
    });
    match rx.recv() {
        Ok(Some(path)) => Ok(Some(path.to_string())),
        Ok(None) => Ok(None),
        Err(_) => Ok(None),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn scan_local_folder(
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<Vec<LocalTrack>, String> {
    let total = {
        let path = path.clone();
        tokio::task::spawn_blocking(move || local_music::count_files(&path))
            .await
            .map_err(|e| format!("{e}"))?
    };

    app_handle
        .emit("local-music:scan-start", total)
        .ok();

    let path_scan = path.clone();
    let app_clone = app_handle.clone();
    let tracks = tokio::task::spawn_blocking(move || {
        local_music::scan_directory_with_progress(&path_scan, move |idx, file_path| {
            app_clone
                .emit(
                    "local-music:scan-progress",
                    serde_json::json!({ "index": idx, "path": file_path }),
                )
                .ok();
        })
    })
    .await
    .map_err(|e| format!("{e}"))??;

    app_handle
        .emit("local-music:scan-complete", tracks.len())
        .ok();

    Ok(tracks)
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_local_cover_art(path: String) -> Result<Option<String>, String> {
    local_music::read_cover_art(&path)
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_watched_folders(state: State<'_, AppState>) -> Result<Vec<String>, SoneError> {
    match state.load_settings() {
        Some(settings) => Ok(settings.local_music_folders),
        None => Ok(Vec::new()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetWatchedFoldersPayload {
    pub folders: Vec<String>,
}

#[tauri::command(rename_all = "camelCase")]
pub fn set_watched_folders(
    state: State<'_, AppState>,
    payload: SetWatchedFoldersPayload,
) -> Result<(), SoneError> {
    let mut settings = state.load_settings().unwrap_or_default();
    settings.local_music_folders = payload.folders;
    state.save_settings(&settings)?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn play_local_file(
    state: State<'_, AppState>,
    path: String,
    _file_id: u64,
) -> Result<(), SoneError> {
    log::debug!("[play_local_file] path={path}");
    if !Path::new(&path).exists() {
        return Err(SoneError::Audio(format!("File not found: {path}")));
    }
    let uri = format!("file://{}", encode_uri_path(&path));
    let player = state.audio_player.clone();
    tokio::task::spawn_blocking(move || {
        player.set_normalization_gain(1.0)?;
        player.play_url(&uri)
    })
    .await
    .map_err(|e| SoneError::Audio(e.to_string()))?
    .map_err(SoneError::Audio)?;
    log::debug!("[play_local_file] play_url returned Ok for {path}");
    Ok(())
}

fn encode_uri_path(path: &str) -> String {
    let mut result = String::with_capacity(path.len());
    for &byte in path.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'_' | b'.' | b'~' | b'/' => {
                result.push(byte as char);
            }
            _ => {
                result.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    result
}

#[tauri::command(rename_all = "camelCase")]
pub async fn set_next_local_file(
    state: State<'_, AppState>,
    path: String,
    file_id: u64,
    qid: String,
) -> Result<(), SoneError> {
    let uri = format!("file://{}", encode_uri_path(&path));
    state
        .audio_player
        .set_next_track(uri, 1.0, file_id, qid, f64::NAN, f64::NAN, false)
        .map_err(SoneError::Audio)?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn load_local_tracks(
    state: State<'_, AppState>,
) -> Result<Vec<LocalTrack>, SoneError> {
    let raw = match state.read_state_file("local-tracks.json") {
        Some(json) => json,
        None => return Ok(Vec::new()),
    };
    let cached: Vec<local_music::CachedTrack> =
        serde_json::from_str(&raw).map_err(|e| SoneError::Parse(e.to_string()))?;
    Ok(local_music::cached_to_locals(&cached))
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_local_tracks(
    state: State<'_, AppState>,
    tracks: Vec<LocalTrack>,
) -> Result<(), SoneError> {
    let watched = match state.load_settings() {
        Some(s) => s.local_music_folders,
        None => Vec::new(),
    };

    let cached: Vec<local_music::CachedTrack> = tracks
        .iter()
        .map(|t| {
            let mtime = Path::new(&t.file_path)
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|d| d.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            local_music::CachedTrack::from_local(t, mtime)
        })
        .collect();

    let json = serde_json::to_string(&cached)?;
    state.write_state_file("local-tracks.json", &json)?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn delta_scan(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<LocalTrack>, String> {
    let watched = match state.load_settings() {
        Some(s) => s.local_music_folders,
        None => return Ok(Vec::new()),
    };
    if watched.is_empty() {
        return Ok(Vec::new());
    }

    let previous_cache: Vec<local_music::CachedTrack> =
        match state.read_state_file("local-tracks.json") {
            Some(json) => {
                serde_json::from_str(&json).unwrap_or_default()
            }
            None => Vec::new(),
        };

    // Count total files for progress
    let total = {
        let watched_count = watched.clone();
        tokio::task::spawn_blocking(move || {
            watched_count
                .iter()
                .map(|f| local_music::count_files(f))
                .sum::<usize>()
        })
        .await
        .map_err(|e| format!("{e}"))?
    };

    app_handle
        .emit("local-music:scan-start", total)
        .ok();

    let path_copies: Vec<String> = watched.iter().cloned().collect();
    let app_clone = app_handle.clone();

    let (new_cache, _added, _removed) = tokio::task::spawn_blocking(move || {
        local_music::delta_scan(&path_copies, &previous_cache, move |idx, file_path| {
            app_clone
                .emit(
                    "local-music:scan-progress",
                    serde_json::json!({ "index": idx, "path": file_path }),
                )
                .ok();
        })
    })
    .await
    .map_err(|e| format!("{e}"))?;

    // Save updated cache
    let json =
        serde_json::to_string(&new_cache).map_err(|e| format!("{e}"))?;
    state
        .write_state_file("local-tracks.json", &json)
        .map_err(|e| format!("{e}"))?;

    let tracks: Vec<LocalTrack> = local_music::cached_to_locals(&new_cache);

    app_handle
        .emit("local-music:scan-complete", tracks.len())
        .ok();

    Ok(tracks)
}
