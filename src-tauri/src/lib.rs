mod audio;
pub mod cache;
mod commands;
mod error;
mod tidal_api;

pub use error::SoneError;

use audio::AudioPlayer;
use cache::DiskCache;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Mutex;
use tauri::Manager;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use std::time::{SystemTime, UNIX_EPOCH};
use tidal_api::{AuthTokens, TidalClient};


#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Settings {
    pub auth_tokens: Option<AuthTokens>,
    pub volume: f32,
    pub last_track_id: Option<u64>,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    #[serde(default)]
    pub minimize_to_tray: bool,
    #[serde(default)]
    pub volume_normalization: bool,
}

pub struct AppState {
    pub audio_player: AudioPlayer,
    pub tidal_client: Mutex<TidalClient>,
    pub settings_path: PathBuf,
    pub cache_dir: PathBuf,
    pub disk_cache: DiskCache,
    pub minimize_to_tray: AtomicBool,
    pub volume_normalization: AtomicBool,
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

impl AppState {
    fn new(app_handle: tauri::AppHandle) -> Self {
        // Get config dir
        let mut config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        config_dir.push("tide-vibe");
        fs::create_dir_all(&config_dir).ok();

        let settings_path = config_dir.join("settings.json");
        let cache_dir = config_dir.join("cache");
        fs::create_dir_all(&cache_dir).ok();

        let disk_cache = DiskCache::new(cache_dir.join("v2"));

        // Load preferences from saved settings
        let saved = fs::read_to_string(&settings_path)
            .ok()
            .and_then(|c| serde_json::from_str::<Settings>(&c).ok());
        let minimize_to_tray = saved.as_ref().map(|s| s.minimize_to_tray).unwrap_or(false);
        let volume_normalization = saved.as_ref().map(|s| s.volume_normalization).unwrap_or(false);

        Self {
            audio_player: AudioPlayer::new(app_handle),
            tidal_client: Mutex::new(TidalClient::new()),
            settings_path,
            cache_dir,
            disk_cache,
            minimize_to_tray: AtomicBool::new(minimize_to_tray),
            volume_normalization: AtomicBool::new(volume_normalization),
        }
    }

    pub fn load_settings(&self) -> Option<Settings> {
        if let Ok(content) = fs::read_to_string(&self.settings_path) {
            serde_json::from_str(&content).ok()
        } else {
            None
        }
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<(), SoneError> {
        let json = serde_json::to_string_pretty(settings)?;
        fs::write(&self.settings_path, json)?;
        Ok(())
    }

    // ---- Persistent state (not cache — survives restarts) ----

    pub fn read_state_file(&self, name: &str) -> Option<String> {
        let path = self.cache_dir.join(name);
        fs::read_to_string(&path).ok()
    }

    pub fn write_state_file(&self, name: &str, content: &str) -> Result<(), SoneError> {
        let path = self.cache_dir.join(name);
        fs::write(&path, content)?;
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            app.manage(AppState::new(app.handle().clone()));

            if let Some(window) = app.get_webview_window("main") {
                // Set window icon at runtime (needed for dev mode taskbar icon)
                let icon_bytes = include_bytes!("../icons/icon.png");
                if let Ok(image) = image::load_from_memory(icon_bytes) {
                    let rgba = image.to_rgba8();
                    let (width, height) = rgba.dimensions();
                    let icon = tauri::image::Image::new(rgba.as_raw(), width, height);
                    let _ = window.set_icon(icon);
                }

                // WebKitGTK rendering settings for Linux
                #[cfg(target_os = "linux")]
                {
                    use webkit2gtk::{WebViewExt, SettingsExt};
                    window.with_webview(|webview| {
                        let wv = webview.inner();
                        if let Some(settings) = wv.settings() {
                            // Use OnDemand (default) — Always can cause severe lag
                            // on dual-GPU systems (NVIDIA + iGPU) with WebKitGTK
                            settings.set_hardware_acceleration_policy(
                                webkit2gtk::HardwareAccelerationPolicy::OnDemand
                            );
                            settings.set_enable_webgl(true);
                            settings.set_enable_smooth_scrolling(true);
                        }
                    }).ok();
                }
            }

            // System tray icon
            let show_item = MenuItemBuilder::with_id("show", "Show").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&quit_item)
                .build()?;

            let icon_bytes = include_bytes!("../icons/icon.png");
            let tray_icon = if let Ok(image) = image::load_from_memory(icon_bytes) {
                let rgba = image.to_rgba8();
                let (width, height) = rgba.dimensions();
                let icon = tauri::image::Image::new(rgba.as_raw(), width, height);
                TrayIconBuilder::new()
                    .icon(icon)
                    .menu(&menu)
                    .tooltip("Sone")
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .build(app)?
            } else {
                TrayIconBuilder::new()
                    .menu(&menu)
                    .tooltip("Sone")
                    .build(app)?
            };
            // Keep tray icon alive
            app.manage(tray_icon);

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let state = app.state::<AppState>();
                if state.minimize_to_tray.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // auth
            commands::auth::greet,
            commands::auth::load_saved_auth,
            commands::auth::get_saved_credentials,
            commands::auth::parse_token_data,
            commands::auth::import_session,
            commands::auth::start_device_auth,
            commands::auth::poll_device_auth,
            commands::auth::refresh_tidal_auth,
            commands::auth::start_pkce_auth,
            commands::auth::complete_pkce_auth,
            commands::auth::logout,
            commands::auth::get_session_user_id,
            commands::auth::get_user_profile,
            // library
            commands::library::get_user_playlists,
            commands::library::get_playlist_tracks,
            commands::library::get_playlist_tracks_page,
            commands::library::get_favorite_playlists,
            commands::library::get_favorite_albums,
            commands::library::create_playlist,
            commands::library::add_track_to_playlist,
            commands::library::remove_track_from_playlist,
            commands::library::get_favorite_tracks,
            commands::library::get_favorite_track_ids,
            commands::library::is_track_favorited,
            commands::library::add_favorite_track,
            commands::library::remove_favorite_track,
            commands::library::is_album_favorited,
            commands::library::add_favorite_album,
            commands::library::remove_favorite_album,
            commands::library::add_favorite_playlist,
            commands::library::remove_favorite_playlist,
            commands::library::add_tracks_to_playlist,
            commands::library::get_favorite_artists,
            // pages
            commands::pages::get_album_detail,
            commands::pages::get_album_tracks,
            commands::pages::get_home_page,
            commands::pages::refresh_home_page,
            commands::pages::get_page_section,
            commands::pages::get_mix_items,
            commands::pages::get_artist_detail,
            commands::pages::get_artist_top_tracks,
            commands::pages::get_artist_albums,
            commands::pages::get_artist_bio,
            commands::pages::debug_home_page_raw,
            // search
            commands::search::search_tidal,
            commands::search::get_suggestions,
            // metadata
            commands::metadata::get_stream_url,
            commands::metadata::get_track_lyrics,
            commands::metadata::get_track_credits,
            commands::metadata::get_track_radio,
            // playback
            commands::playback::play_tidal_track,
            commands::playback::pause_track,
            commands::playback::resume_track,
            commands::playback::stop_track,
            commands::playback::set_volume,
            commands::playback::get_playback_position,
            commands::playback::seek_track,
            commands::playback::is_track_finished,
            commands::playback::save_playback_queue,
            commands::playback::load_playback_queue,
            // utility
            commands::utility::get_image_bytes,
            commands::utility::get_cache_stats,
            commands::utility::clear_disk_cache,
            commands::utility::get_minimize_to_tray,
            commands::utility::set_minimize_to_tray,
            commands::utility::get_volume_normalization,
            commands::utility::set_volume_normalization,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
