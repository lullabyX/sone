mod audio;
pub mod cache;
mod commands;
mod crypto;
mod discord;
mod embedded_config;
mod embedded_lastfm;
mod embedded_librefm;
mod error;
mod idle_inhibit;
pub mod logging;
pub mod mcp;
#[cfg(target_os = "linux")]
mod mpris;
mod pipeline_probe;
mod scrobble;
mod signal_path;
mod tidal_api;
#[cfg(target_os = "linux")]
mod tray;
mod tidal_report;
pub mod overlay;
mod http_util;

pub use error::SoneError;
pub use signal_path::{SignalPath, SignalPathTracker};

use audio::{AudioDevice, AudioPlayer};
use cache::DiskCache;
use crypto::Crypto;
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Listener, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
use tidal_api::{AuthTokens, TidalClient};
use tokio::sync::Mutex;

mod defaults {
    pub fn yes() -> bool { true }
    pub fn volume() -> f32 { 1.0 }
    pub fn mcp_enabled() -> bool { false }
    pub fn mcp_port() -> u16 { 5577 }
    pub fn overlay_enabled() -> bool { false }
    pub fn overlay_port() -> u16 { 5578 }
    pub fn overlay_host() -> String { "127.0.0.1".to_string() }
    pub fn max_quality() -> String { "HI_RES_LOSSLESS".to_string() }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct LastfmCredentials {
    pub session_key: String,
    pub username: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ListenBrainzCredentials {
    pub token: String,
    pub username: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ScrobbleSettings {
    pub lastfm: Option<LastfmCredentials>,
    pub librefm: Option<LastfmCredentials>,
    pub listenbrainz: Option<ListenBrainzCredentials>,
}

/// Tracks which embedded credential pair the saved tokens belong to,
/// so refresh-token requests use the matching client_id/secret.
/// Only relevant when the user has not provided custom credentials.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethod {
    LoginCode,
    Pkce,
}

impl Default for AuthMethod {
    fn default() -> Self {
        Self::LoginCode
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProxyType {
    Http,
    Socks5,
}

impl Default for ProxyType {
    fn default() -> Self {
        Self::Http
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ProxySettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub proxy_type: ProxyType,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Settings {
    pub auth_tokens: Option<AuthTokens>,
    #[serde(default = "defaults::volume")]
    pub volume: f32,
    pub last_track_id: Option<u64>,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    /// Which embedded credential pair to use for refresh when `client_id`
    /// is empty. Defaults to LoginCode for backward compatibility with
    /// existing installs.
    #[serde(default)]
    pub auth_method: AuthMethod,
    #[serde(default)]
    pub minimize_to_tray: bool,
    #[serde(default)]
    pub decorations: bool,
    /// One-shot flag: was the user migrated from native chrome to the
    /// custom React titlebar? `false` (or missing) on existing installs
    /// triggers a silent flip of `decorations` to `false` at startup.
    #[serde(default)]
    pub titlebar_migration_v1: bool,
    #[serde(default)]
    pub volume_normalization: bool,
    #[serde(default)]
    pub exclusive_mode: bool,
    #[serde(default)]
    pub exclusive_device: Option<String>,
    #[serde(default)]
    pub bit_perfect: bool,
    #[serde(default = "defaults::yes")]
    pub gapless: bool,
    #[serde(default = "defaults::max_quality")]
    pub max_quality: String,
    #[serde(default)]
    pub scrobble: ScrobbleSettings,
    #[serde(default)]
    pub proxy: ProxySettings,
    #[serde(default = "defaults::yes")]
    pub discord_rpc: bool,
    #[serde(default)]
    pub discord_status_text: String,
    /// How many times we've shown the "legacy sign-in" notice to users still
    /// on the device-code (LoginCode) auth method. Caps at 5; never resets.
    #[serde(default)]
    pub legacy_auth_notice_count: u8,
    #[serde(default = "defaults::mcp_enabled")]
    pub mcp_enabled: bool,
    #[serde(default = "defaults::mcp_port")]
    pub mcp_port: u16,
    /// Persistent UUID token for the MCP URL path. Empty string means
    /// "not yet generated" — bootstrap will populate and save on first run.
    #[serde(default)]
    pub mcp_token: String,
    #[serde(default = "defaults::overlay_enabled")]
    pub overlay_enabled: bool,
    #[serde(default = "defaults::overlay_port")]
    pub overlay_port: u16,
    #[serde(default = "defaults::overlay_host")]
    pub overlay_host: String,
    /// Report plays to TIDAL (Recently Played). On by default; disable in
    /// Settings → Scrobbling.
    #[serde(default = "defaults::yes")]
    pub report_plays: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auth_tokens: None,
            volume: 1.0,
            last_track_id: None,
            client_id: String::new(),
            client_secret: String::new(),
            auth_method: AuthMethod::default(),
            minimize_to_tray: false,
            decorations: false,
            titlebar_migration_v1: true,
            volume_normalization: false,
            exclusive_mode: false,
            exclusive_device: None,
            bit_perfect: false,
            gapless: true,
            max_quality: "HI_RES_LOSSLESS".to_string(),
            scrobble: Default::default(),
            proxy: Default::default(),
            discord_rpc: true,
            discord_status_text: String::new(),
            legacy_auth_notice_count: 0,
            mcp_enabled: false,
            mcp_port: 5577,
            mcp_token: String::new(),
            overlay_enabled: false,
            overlay_port: 5578,
            overlay_host: "127.0.0.1".to_string(),
            report_plays: true,
        }
    }
}

fn normalize_alsa_device_value(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

pub(crate) fn parse_alsa_device_cli_override<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut args = args.into_iter().peekable();

    while let Some(arg) = args.next() {
        let arg = arg.as_ref().to_string_lossy().into_owned();

        if arg == "--" {
            break;
        }

        if let Some(value) = arg.strip_prefix("--alsa-device=") {
            if let Some(value) = normalize_alsa_device_value(value.to_owned()) {
                return Some(value);
            }
            continue;
        }

        if arg == "--alsa-device" {
            if let Some(next) = args.next() {
                let value = next.as_ref().to_string_lossy().into_owned();
                if let Some(value) = normalize_alsa_device_value(value) {
                    return Some(value);
                }
            }
        }
    }

    None
}

pub(crate) fn read_alsa_device_env_override() -> Option<String> {
    std::env::var_os("SONE_ALSA_DEVICE")
        .and_then(|value| normalize_alsa_device_value(value.to_string_lossy().into_owned()))
}

pub(crate) fn resolve_alsa_device_override(
    cli: Option<String>,
    env: Option<String>,
    saved: Option<String>,
) -> Option<String> {
    cli.and_then(normalize_alsa_device_value)
        .or_else(|| env.and_then(normalize_alsa_device_value))
        .or_else(|| saved.and_then(normalize_alsa_device_value))
}

pub struct AppState {
    pub audio_player: Arc<AudioPlayer>,
    pub pipeline_probe: Arc<crate::pipeline_probe::PipelineProbe>,
    pub tidal_client: Mutex<TidalClient>,
    pub settings_path: PathBuf,
    pub cache_dir: PathBuf,
    pub disk_cache: DiskCache,
    pub crypto: Arc<Crypto>,
    pub minimize_to_tray: AtomicBool,
    pub decorations: AtomicBool,
    pub volume_normalization: AtomicBool,
    pub exclusive_mode: AtomicBool,
    pub bit_perfect: AtomicBool,
    pub gapless: AtomicBool,
    pub max_quality: std::sync::Mutex<String>,
    pub alsa_device_override: Option<String>,
    pub exclusive_device: std::sync::Mutex<Option<String>>,
    pub cached_audio_devices: std::sync::Mutex<Option<Vec<AudioDevice>>>,
    /// Current track's selected replay gain (dB) stored as f64 bits. NAN = no data.
    /// Album or track gain depending on playback context.
    pub last_replay_gain: AtomicU64,
    /// Current track's selected peak amplitude (linear) stored as f64 bits. NAN = no data.
    /// Album or track peak depending on playback context.
    pub last_peak_amplitude: AtomicU64,
    #[cfg(target_os = "linux")]
    pub mpris: mpris::MprisHandle,
    pub scrobble_manager: scrobble::ScrobbleManager,
    pub tidal_reporter: tidal_report::TidalReporter,
    pub discord: discord::DiscordHandle,
    pub idle_inhibitor: Mutex<idle_inhibit::IdleInhibitor>,
    pub mcp_state: crate::mcp::McpStateRef,
    pub mcp_handle: Mutex<Option<crate::mcp::McpHandle>>,
    pub overlay_state: crate::overlay::OverlayStateRef,
    pub overlay_handle: Mutex<Option<crate::overlay::OverlayHandle>>,
    pub signal_path: Arc<SignalPathTracker>,
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Write refreshed tokens back into the stored settings. Called from every
/// refresh, including the automatic one after a 401 — without it the stored
/// access token stays stale and each launch burns a 401 before the first
/// request succeeds.
fn persist_auth_tokens(path: &Path, crypto: &Crypto, tokens: &AuthTokens) {
    let mut settings = fs::read(path)
        .ok()
        .and_then(|data| crypto.decrypt(&data).ok())
        .and_then(|plain| serde_json::from_slice::<Settings>(&plain).ok())
        .unwrap_or_default();
    settings.auth_tokens = Some(tokens.clone());

    let write = || -> Result<(), SoneError> {
        let json = serde_json::to_string_pretty(&settings)?;
        let encrypted = crypto.encrypt(json.as_bytes())?;
        fs::write(path, encrypted)?;
        Ok(())
    };
    if let Err(e) = write() {
        log::warn!("Failed to persist refreshed auth tokens: {e}");
    }
}

impl AppState {
    fn new(app_handle: tauri::AppHandle) -> Self {
        // Get config dir
        let mut config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        config_dir.push("sone");
        fs::create_dir_all(&config_dir).ok();

        let settings_path = config_dir.join("settings.json");
        let cache_dir = config_dir.join("cache");
        fs::create_dir_all(&cache_dir).ok();

        // Initialize encryption
        let crypto = match Crypto::new(&config_dir) {
            Ok(c) => Arc::new(c),
            Err(e) => {
                log::error!("Failed to initialize crypto: {e}. Data-at-rest encryption disabled.");
                panic!("Crypto initialization failed: {e}");
            }
        };

        let disk_cache = DiskCache::new(&cache_dir, crypto.clone());

        // Load preferences from saved settings (decrypt if needed)
        let mut saved = fs::read(&settings_path)
            .ok()
            .and_then(|data| crypto.decrypt(&data).ok())
            .and_then(|plain| String::from_utf8(plain).ok())
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok());

        // One-shot custom-titlebar migration: existing installs had
        // `decorations: true` (native GTK chrome); silent-flip to false so
        // the custom React titlebar is shown by default. The toggle in
        // Settings remains as an escape hatch.
        if let Some(ref mut s) = saved {
            if !s.titlebar_migration_v1 {
                log::info!("[migration] custom-titlebar v1: flipping decorations to false");
                s.decorations = false;
                s.titlebar_migration_v1 = true;
                if let Ok(json) = serde_json::to_string_pretty(s) {
                    if let Ok(encrypted) = crypto.encrypt(json.as_bytes()) {
                        if let Err(e) = fs::write(&settings_path, encrypted) {
                            log::warn!("[migration] failed to persist titlebar_migration_v1: {e}");
                        }
                    }
                }
            }
        }

        // Eager migration: if settings exist but aren't encrypted, re-save encrypted
        if settings_path.exists() {
            if let Ok(raw) = fs::read(&settings_path) {
                if !crypto::is_encrypted(&raw) {
                    if let Some(ref settings) = saved {
                        if let Ok(json) = serde_json::to_string_pretty(settings) {
                            if let Ok(encrypted) = crypto.encrypt(json.as_bytes()) {
                                if let Err(e) = fs::write(&settings_path, encrypted) {
                                    log::warn!("Failed to migrate settings to encrypted: {e}");
                                } else {
                                    log::info!("Migrated settings.json to encrypted format");
                                }
                            }
                        }
                    }
                }
            }
        }

        let minimize_to_tray = saved.as_ref().map(|s| s.minimize_to_tray).unwrap_or(false);
        let decorations = saved.as_ref().map(|s| s.decorations).unwrap_or(false);
        let volume_normalization = saved
            .as_ref()
            .map(|s| s.volume_normalization)
            .unwrap_or(false);
        let exclusive_mode = saved.as_ref().map(|s| s.exclusive_mode).unwrap_or(false);
        let bit_perfect = saved.as_ref().map(|s| s.bit_perfect).unwrap_or(false);
        let gapless = saved.as_ref().map(|s| s.gapless).unwrap_or(true);
        let cli_alsa_device = parse_alsa_device_cli_override(std::env::args_os());
        let env_alsa_device = read_alsa_device_env_override();
        let saved_exclusive_device = saved.as_ref().and_then(|s| s.exclusive_device.clone());
        let alsa_device_override =
            resolve_alsa_device_override(cli_alsa_device, env_alsa_device, None);
        let exclusive_device = alsa_device_override.clone().or(saved_exclusive_device);
        let max_quality = saved
            .as_ref()
            .map(|s| s.max_quality.clone())
            .unwrap_or_else(defaults::max_quality);

        let proxy_settings = saved.as_ref().map(|s| s.proxy.clone()).unwrap_or_default();
        let scrobble_http_client = crate::tidal_api::build_http_client(&proxy_settings)
            .unwrap_or_else(|_| {
                reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(30))
                    .build()
                    .unwrap()
            });
        let scrobble_manager = scrobble::ScrobbleManager::new(
            app_handle.clone(),
            crypto.clone(),
            &config_dir,
            scrobble_http_client.clone(),
        );

        let report_plays = saved.as_ref().map(|s| s.report_plays).unwrap_or(true);
        let tidal_reporter = tidal_report::TidalReporter::new(
            app_handle.clone(),
            crypto.clone(),
            &config_dir,
            scrobble_http_client,
            report_plays,
        );

        let discord_rpc_enabled = saved.as_ref().map(|s| s.discord_rpc).unwrap_or(true);
        let discord_status_text = saved
            .as_ref()
            .map(|s| s.discord_status_text.clone())
            .unwrap_or_default();
        let discord_handle = discord::DiscordHandle::new();
        discord_handle.send(discord::DiscordCommand::SetStatusText {
            text: discord_status_text,
        });
        if discord_rpc_enabled {
            discord_handle.send(discord::DiscordCommand::Connect);
        }

        let signal_path = Arc::new(SignalPathTracker::new(app_handle.clone()));
        signal_path.set_audio_modes(exclusive_mode, bit_perfect);
        signal_path.set_normalization_enabled(volume_normalization);

        let audio_player = Arc::new(AudioPlayer::new(
            app_handle.clone(),
            Arc::clone(&signal_path),
        ));
        let pipeline_probe = Arc::new(crate::pipeline_probe::PipelineProbe::new(
            Arc::clone(&signal_path),
            Arc::clone(&audio_player),
        ));

        let mut tidal_client = TidalClient::new(&proxy_settings);
        tidal_client.set_token_persist({
            let settings_path = settings_path.clone();
            let crypto = Arc::clone(&crypto);
            Arc::new(move |tokens: &AuthTokens| {
                persist_auth_tokens(&settings_path, &crypto, tokens);
            })
        });

        Self {
            audio_player,
            pipeline_probe,
            tidal_client: Mutex::new(tidal_client),
            settings_path,
            cache_dir,
            disk_cache,
            crypto,
            minimize_to_tray: AtomicBool::new(minimize_to_tray),
            decorations: AtomicBool::new(decorations),
            volume_normalization: AtomicBool::new(volume_normalization),
            exclusive_mode: AtomicBool::new(exclusive_mode),
            bit_perfect: AtomicBool::new(bit_perfect),
            gapless: AtomicBool::new(gapless),
            max_quality: std::sync::Mutex::new(max_quality),
            alsa_device_override,
            exclusive_device: std::sync::Mutex::new(exclusive_device),
            cached_audio_devices: std::sync::Mutex::new(None),
            last_replay_gain: AtomicU64::new(f64::NAN.to_bits()),
            last_peak_amplitude: AtomicU64::new(f64::NAN.to_bits()),
            #[cfg(target_os = "linux")]
            mpris: mpris::MprisHandle::new(app_handle),
            scrobble_manager,
            tidal_reporter,
            discord: discord_handle,
            idle_inhibitor: Mutex::new(idle_inhibit::IdleInhibitor::new()),
            mcp_state: crate::mcp::new_state(),
            mcp_handle: Mutex::new(None),
            overlay_state: {
                let (s, _rx, _theme_rx) = crate::overlay::new_state();
                s
            },
            overlay_handle: Mutex::new(None),
            signal_path,
        }
    }

    pub fn load_settings(&self) -> Option<Settings> {
        let data = fs::read(&self.settings_path).ok()?;
        let plain = self.crypto.decrypt(&data).ok()?;
        let text = String::from_utf8(plain).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<(), SoneError> {
        let json = serde_json::to_string_pretty(settings)?;
        let encrypted = self.crypto.encrypt(json.as_bytes())?;
        fs::write(&self.settings_path, encrypted)?;
        Ok(())
    }

    // ---- Persistent state (not cache — survives restarts) ----

    pub fn read_state_file(&self, name: &str) -> Option<String> {
        let path = self.cache_dir.join(name);
        let data = match fs::read(&path) {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            Err(e) => {
                log::warn!("Failed to read state file {name}: {e}");
                return None;
            }
        };
        let plain = match self.crypto.decrypt(&data) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("Failed to decrypt state file {name}: {e}");
                return None;
            }
        };
        match String::from_utf8(plain) {
            Ok(s) => Some(s),
            Err(e) => {
                log::warn!("State file {name} contains invalid UTF-8: {e}");
                None
            }
        }
    }

    pub fn write_state_file(&self, name: &str, content: &str) -> Result<(), SoneError> {
        let path = self.cache_dir.join(name);
        let encrypted = self.crypto.encrypt(content.as_bytes())?;
        fs::write(&path, encrypted)?;
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::{parse_alsa_device_cli_override, resolve_alsa_device_override};

    #[test]
    fn resolve_alsa_device_override_prefers_cli_over_env_and_saved() {
        let resolved = resolve_alsa_device_override(
            Some("hw:CARD=cli,DEV=0".to_string()),
            Some("hw:CARD=env,DEV=0".to_string()),
            Some("hw:CARD=saved,DEV=0".to_string()),
        );

        assert_eq!(resolved.as_deref(), Some("hw:CARD=cli,DEV=0"));
    }

    #[test]
    fn resolve_alsa_device_override_trims_and_ignores_empty_values() {
        let resolved = resolve_alsa_device_override(
            Some("   ".to_string()),
            Some("  hw:CARD=env,DEV=0  ".to_string()),
            Some("  hw:CARD=saved,DEV=0  ".to_string()),
        );

        assert_eq!(resolved.as_deref(), Some("hw:CARD=env,DEV=0"));
    }

    #[test]
    fn parse_alsa_device_cli_override_supports_long_option_value() {
        let args = ["sone", "--alsa-device", "  hw:CARD=cli,DEV=0  "];

        let parsed = parse_alsa_device_cli_override(args);

        assert_eq!(parsed.as_deref(), Some("hw:CARD=cli,DEV=0"));
    }

    #[test]
    fn parse_alsa_device_cli_override_ignores_empty_values() {
        let args = [
            "sone",
            "--alsa-device",
            "   ",
            "--alsa-device=hw:CARD=cli,DEV=0",
        ];

        let parsed = parse_alsa_device_cli_override(args);

        assert_eq!(parsed.as_deref(), Some("hw:CARD=cli,DEV=0"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // File logger setup. Must happen before Tauri builds so early log
    // calls from setup hooks are captured. Reads only the logging toggle
    // sidecar file — Settings struct is encrypted and loaded later via
    // AppState.
    let sone_dir = dirs::config_dir()
        .map(|d| d.join("sone"))
        .unwrap_or_else(|| std::path::PathBuf::from("./.sone"));
    let logging_toggle_path = sone_dir.join("logging.toggle");
    let logging_enabled = crate::logging::read_logging_preference(&logging_toggle_path);
    let _logger_handle = crate::logging::init_logging(sone_dir.join("logs"), logging_enabled);
    // Bind to a named local (not `let _ = ...`) so the handle lives until
    // the end of `run()`. flexi_logger flushes the log file on drop, so
    // the handle must outlive the Tauri event loop.
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::SIZE,
                )
                .build(),
        )
        .setup(|app| {
            // Single-instance: focus existing window if launched again
            app.handle()
                .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }))?;
            // Deep link: register tidal:// scheme handler
            app.handle().plugin(tauri_plugin_deep_link::init())?;
            #[cfg(target_os = "linux")]
            if let Err(e) = app.deep_link().register_all() {
                log::warn!("Deep link registration failed: {e}");
            }

            app.manage(AppState::new(app.handle().clone()));

            // Start MCP server in background (if enabled). ensure_mcp_started
            // holds the mcp_handle lock across the start to stay race-free.
            {
                let handle_for_mcp = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    crate::mcp::ensure_mcp_started(&handle_for_mcp).await;
                });
            }

            // Start Overlay server in background (if enabled).
            {
                let handle_for_overlay = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    crate::overlay::ensure_overlay_started(&handle_for_overlay).await;
                });
            }

            // Apply saved audio mode to audio thread
            {
                let state = app.state::<AppState>();
                let excl = state
                    .exclusive_mode
                    .load(std::sync::atomic::Ordering::Relaxed);
                let bp = state.bit_perfect.load(std::sync::atomic::Ordering::Relaxed);
                let dev = state.exclusive_device.lock().unwrap().clone();
                if excl || bp {
                    state.audio_player.set_exclusive_mode(excl, dev).ok();
                }
                if bp {
                    state.audio_player.set_bit_perfect(true).ok();
                }
                let _ = state
                    .audio_player
                    .set_gapless(state.gapless.load(std::sync::atomic::Ordering::Relaxed));
            }

            // Pre-warm audio device cache in background (GStreamer probe is slow)
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let override_device = {
                        let state = handle.state::<AppState>();
                        state.alsa_device_override.clone()
                    };
                    let devices =
                        crate::audio::list_alsa_devices_with_override(override_device.as_deref());
                    let state = handle.state::<AppState>();
                    *state.cached_audio_devices.lock().unwrap() = Some(devices);
                });
            }

            // Initialize scrobble providers from saved credentials
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<AppState>();
                    if let Some(settings) = state.load_settings() {
                        let http_client = crate::tidal_api::build_http_client(&settings.proxy)
                            .unwrap_or_else(|_| {
                                reqwest::Client::builder()
                                    .timeout(std::time::Duration::from_secs(30))
                                    .build()
                                    .unwrap()
                            });

                        // Last.fm
                        if let Some(ref creds) = settings.scrobble.lastfm {
                            if crate::embedded_lastfm::has_stream_keys() {
                                let provider = crate::scrobble::lastfm::AudioscrobblerProvider::new(
                                    "lastfm",
                                    "https://ws.audioscrobbler.com/2.0/",
                                    "https://www.last.fm/api/auth/",
                                    crate::embedded_lastfm::stream_key_a(),
                                    crate::embedded_lastfm::stream_key_b(),
                                    http_client.clone(),
                                );
                                provider
                                    .set_session(creds.session_key.clone(), creds.username.clone())
                                    .await;
                                state
                                    .scrobble_manager
                                    .add_provider(Box::new(provider))
                                    .await;
                                log::info!("Last.fm scrobbling enabled for {}", creds.username);
                            }
                        }

                        // Libre.fm
                        if let Some(ref creds) = settings.scrobble.librefm {
                            if crate::embedded_librefm::has_stream_keys() {
                                let provider = crate::scrobble::lastfm::AudioscrobblerProvider::new(
                                    "librefm",
                                    crate::scrobble::librefm::LIBREFM_API_URL,
                                    "https://libre.fm/api/auth/",
                                    crate::embedded_librefm::stream_key_a(),
                                    crate::embedded_librefm::stream_key_b(),
                                    http_client.clone(),
                                );
                                provider
                                    .set_session(creds.session_key.clone(), creds.username.clone())
                                    .await;
                                state
                                    .scrobble_manager
                                    .add_provider(Box::new(provider))
                                    .await;
                                log::info!("Libre.fm scrobbling enabled for {}", creds.username);
                            }
                        }

                        // ListenBrainz
                        if let Some(ref creds) = settings.scrobble.listenbrainz {
                            let provider = crate::scrobble::listenbrainz::ListenBrainzProvider::new(
                                http_client.clone(),
                            );
                            provider
                                .set_token(creds.token.clone(), creds.username.clone())
                                .await;
                            state
                                .scrobble_manager
                                .add_provider(Box::new(provider))
                                .await;
                            log::info!("ListenBrainz scrobbling enabled for {}", creds.username);
                        }
                    }

                    // Drain retry queues in background
                    state.scrobble_manager.drain_queue().await;
                    state.tidal_reporter.drain_queue().await;
                });
            }

            // Scrobble on track-finished (backend listener)
            {
                let handle = app.handle().clone();
                app.listen("track-finished", move |_| {
                    let handle = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = handle.state::<AppState>();
                        state.scrobble_manager.try_scrobble_finished().await;
                        state.tidal_reporter.try_finish().await;
                    });
                });
            }

            // Scrobble outgoing track AND store rg/peak on gapless track-advanced
            // (this listener has AppState, which the audio worker does not).
            {
                let handle = app.handle().clone();
                app.listen("track-advanced", move |event| {
                    // Store this track's replay gain / peak so a live volume-normalization
                    // toggle is correct. Absent (null/NaN) → store NaN (→ unity gain).
                    // Payload: { trackId, qid, replayGain, peakAmplitude }.
                    let (rg, peak) = serde_json::from_str::<serde_json::Value>(event.payload())
                        .ok()
                        .map(|v| {
                            (
                                v.get("replayGain")
                                    .and_then(|x| x.as_f64())
                                    .unwrap_or(f64::NAN),
                                v.get("peakAmplitude")
                                    .and_then(|x| x.as_f64())
                                    .unwrap_or(f64::NAN),
                            )
                        })
                        .unwrap_or((f64::NAN, f64::NAN));
                    let st = handle.state::<AppState>();
                    st.last_replay_gain
                        .store(rg.to_bits(), std::sync::atomic::Ordering::Relaxed);
                    st.last_peak_amplitude
                        .store(peak.to_bits(), std::sync::atomic::Ordering::Relaxed);

                    let handle = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = handle.state::<AppState>();
                        state.scrobble_manager.try_scrobble_finished().await;
                        state.tidal_reporter.try_finish().await;
                    });
                });
            }

            if let Some(window) = app.get_webview_window("main") {
                let state = app.state::<AppState>();
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
                    use webkit2gtk::{SettingsExt, WebViewExt};
                    window
                        .with_webview(|webview| {
                            let wv = webview.inner();
                            if let Some(settings) = wv.settings() {
                                // Use OnDemand (default) — Always can cause severe lag
                                // on dual-GPU systems (NVIDIA + iGPU) with WebKitGTK
                                settings.set_hardware_acceleration_policy(
                                    webkit2gtk::HardwareAccelerationPolicy::OnDemand,
                                );
                                settings.set_enable_webgl(true);
                                settings.set_enable_smooth_scrolling(true);
                            }
                        })
                        .ok();
                }

                // tauri.conf.json sets decorations: false, so the window is
                // born without GTK CSD. Only re-enable native chrome if the
                // user has explicitly opted in via the escape-hatch toggle.
                let decorations = state.decorations.load(Ordering::Relaxed);

                if decorations {
                    window.set_decorations(true).ok();
                }

                let _ = window.show();
            }

            // System tray icon (ksni — native D-Bus StatusNotifierItem)
            #[cfg(target_os = "linux")]
            tray::setup(app);

            // Global media key shortcuts (non-fatal)
            if let Err(e) = app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, shortcut, event| {
                        if event.state() != ShortcutState::Pressed {
                            return;
                        }
                        match shortcut.key {
                            Code::MediaPlayPause => {
                                app.emit("tray:toggle-play", ()).ok();
                            }
                            Code::MediaTrackNext => {
                                app.emit("tray:next-track", ()).ok();
                            }
                            Code::MediaTrackPrevious => {
                                app.emit("tray:prev-track", ()).ok();
                            }
                            _ => {}
                        };
                    })
                    .build(),
            ) {
                log::warn!("Failed to initialize global shortcut plugin: {e}");
            } else {
                let shortcuts = [
                    ("MediaPlayPause", Code::MediaPlayPause),
                    ("MediaTrackNext", Code::MediaTrackNext),
                    ("MediaTrackPrevious", Code::MediaTrackPrevious),
                ];
                for (name, code) in shortcuts {
                    if let Err(e) = app.global_shortcut().register(Shortcut::new(None, code)) {
                        log::warn!("Failed to register global {name} shortcut: {e}");
                    }
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "main" {
                    let app = window.app_handle();
                    let state = app.state::<AppState>();
                    if state.minimize_to_tray.load(Ordering::Relaxed) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                } else if window.label() == "miniplayer" {
                    let _ = window.app_handle().emit_to("main", "miniplayer-closed", ());
                }
            }
            tauri::WindowEvent::Destroyed => {
                if window.label() == "miniplayer" {
                    let _ = window.app_handle().emit_to("main", "miniplayer-closed", ());
                } else if window.label() == "pkce-login" {
                    commands::auth::on_pkce_window_closed(window.app_handle());
                }
            }
            #[cfg(target_os = "linux")]
            tauri::WindowEvent::Focused(true) => {
                if window.label() == "miniplayer" {
                    if let Some(ww) = window.app_handle().get_webview_window("miniplayer") {
                        let _ = ww.with_webview(|webview| {
                            use gtk::prelude::WidgetExt;
                            let wv: webkit2gtk::WebView = webview.inner();
                            if let Some(toplevel) = wv.toplevel() {
                                if let Some(gdk_win) = toplevel.window() {
                                    gdk_win.set_shadow_width(12, 12, 12, 12);
                                }
                            }
                        });
                    }
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            // auth
            commands::auth::greet,
            commands::auth::load_saved_auth,
            commands::auth::get_saved_credentials,
            commands::auth::get_default_credentials,
            commands::auth::parse_token_data,
            commands::auth::import_session,
            commands::auth::start_device_auth,
            commands::auth::poll_device_auth,
            commands::auth::refresh_tidal_auth,
            commands::auth::start_pkce_auth,
            commands::auth::complete_pkce_auth,
            commands::auth::has_pkce_defaults,
            commands::auth::start_pkce_login_window,
            commands::auth::start_pkce_browser_login,
            commands::auth::complete_pkce_browser_login,
            commands::auth::logout,
            commands::auth::consume_legacy_auth_notice,
            commands::auth::get_session_user_id,
            commands::auth::get_user_profile,
            // profile
            commands::profile::get_profile,
            commands::profile::update_profile_meta,
            commands::profile::update_profile_bio,
            commands::profile::update_profile_links,
            commands::profile::upload_profile_picture,
            commands::profile::delete_profile_picture,
            // library
            commands::library::get_user_playlists,
            commands::library::get_all_playlists,
            commands::library::get_playlist_tracks,
            commands::library::get_playlist_tracks_page,
            commands::library::get_favorite_playlists,
            commands::library::get_favorite_albums,
            commands::library::create_playlist,
            commands::library::update_playlist,
            commands::library::add_track_to_playlist,
            commands::library::remove_track_from_playlist,
            commands::library::delete_playlist,
            commands::library::get_favorite_tracks,
            commands::library::get_favorite_track_ids,
            commands::library::is_track_favorited,
            commands::library::add_favorite_track,
            commands::library::remove_favorite_track,
            commands::library::get_favorite_video_ids,
            commands::library::get_favorite_videos,
            commands::library::add_favorite_video,
            commands::library::remove_favorite_video,
            commands::library::get_favorite_album_ids,
            commands::library::is_album_favorited,
            commands::library::add_favorite_album,
            commands::library::remove_favorite_album,
            commands::library::get_favorite_playlist_uuids,
            commands::library::add_favorite_playlist,
            commands::library::remove_favorite_playlist,
            commands::library::add_tracks_to_playlist,
            commands::library::get_favorite_artist_ids,
            commands::library::get_all_favorite_ids,
            commands::library::add_favorite_artist,
            commands::library::remove_favorite_artist,
            commands::library::add_favorite_mix,
            commands::library::remove_favorite_mix,
            commands::library::get_favorite_mix_ids,
            commands::library::get_favorite_mixes,
            commands::library::get_favorite_artists,
            commands::library::get_playlist_folders,
            commands::library::get_all_flattened_playlists,
            commands::library::create_playlist_folder,
            commands::library::rename_playlist_folder,
            commands::library::delete_playlist_folder,
            commands::library::move_playlist_to_folder,
            commands::library::get_playlist_recommendations,
            // pages
            commands::pages::get_album_detail,
            commands::pages::get_album_page,
            commands::pages::get_album_tracks,
            commands::pages::get_home_page,
            commands::pages::refresh_home_page,
            commands::pages::get_home_page_more,
            commands::pages::get_page_section,
            commands::pages::get_mix_items,
            commands::pages::get_artist_detail,
            commands::pages::get_artist_top_tracks,
            commands::pages::get_artist_albums,
            commands::pages::get_artist_bio,
            commands::pages::get_artist_page,
            commands::pages::get_artist_top_tracks_all,
            commands::pages::get_artist_view_all,
            commands::pages::debug_home_page_raw,
            // search
            commands::search::search_tidal,
            commands::search::get_suggestions,
            // metadata
            commands::metadata::get_stream_url,
            commands::metadata::get_playlist_details,
            commands::metadata::get_track,
            commands::metadata::get_track_lyrics,
            commands::metadata::get_track_credits,
            // playback
            commands::playback::play_tidal_track,
            commands::playback::set_next_track,
            commands::playback::clear_next_track,
            commands::playback::get_stream_info,
            commands::playback::get_video_stream_info,
            commands::playback::get_video_metadata,
            commands::playback::pause_track,
            commands::playback::resume_track,
            commands::playback::stop_track,
            commands::playback::set_volume,
            commands::playback::get_playback_position,
            commands::playback::seek_track,
            commands::playback::is_track_finished,
            commands::playback::save_playback_queue,
            commands::playback::load_playback_queue,
            commands::playback::update_mpris_metadata,
            commands::playback::update_mpris_playback_status,
            commands::playback::update_mpris_shuffle,
            commands::playback::update_mpris_loop_status,
            commands::playback::update_mpris_fullscreen,
            // scrobble
            commands::scrobble::notify_track_started,
            commands::scrobble::notify_track_paused,
            commands::scrobble::notify_track_resumed,
            commands::scrobble::notify_track_seeked,
            commands::scrobble::notify_track_stopped,
            commands::scrobble::get_scrobble_status,
            commands::scrobble::get_scrobble_queue_size,
            commands::scrobble::connect_listenbrainz,
            commands::scrobble::connect_lastfm,
            commands::scrobble::connect_librefm,
            commands::scrobble::complete_audioscrobbler_auth,
            commands::scrobble::disconnect_provider,
            // utility
            commands::utility::get_image_bytes,
            commands::utility::get_cache_stats,
            commands::utility::clear_disk_cache,
            commands::utility::get_minimize_to_tray,
            commands::utility::set_minimize_to_tray,
            commands::utility::get_enable_logging,
            commands::utility::set_enable_logging,
            commands::utility::open_log_folder,
            commands::utility::get_decorations,
            commands::utility::set_decorations,
            commands::utility::get_volume_normalization,
            commands::utility::set_volume_normalization,
            commands::utility::update_tray_tooltip,
            commands::utility::get_exclusive_mode,
            commands::utility::set_exclusive_mode,
            commands::utility::get_bit_perfect,
            commands::utility::set_bit_perfect,
            commands::utility::get_gapless,
            commands::utility::get_gapless_supported,
            commands::utility::set_gapless,
            commands::utility::get_max_quality,
            commands::utility::set_max_quality,
            commands::utility::get_exclusive_device,
            commands::utility::set_exclusive_device,
            commands::utility::list_audio_devices,
            commands::utility::refresh_audio_devices,
            commands::utility::get_discord_rpc,
            commands::utility::set_discord_rpc,
            commands::utility::get_report_plays,
            commands::utility::set_report_plays,
            commands::utility::get_discord_status_text,
            commands::utility::set_discord_status_text,
            commands::utility::get_proxy_settings,
            commands::utility::set_proxy_settings,
            commands::utility::test_proxy_connection,
            commands::utility::inhibit_idle,
            commands::utility::uninhibit_idle,
            // mcp
            commands::mcp::mcp_get_connection_info,
            commands::mcp::mcp_publish_state,
            commands::mcp::mcp_set_enabled,
            commands::mcp::mcp_regenerate_token,
            // overlay
            commands::overlay::overlay_get_connection_info,
            commands::overlay::overlay_publish_state,
            commands::overlay::overlay_set_enabled,
            commands::overlay::overlay_set_port,
            commands::overlay::overlay_set_host,
            commands::overlay::overlay_publish_theme,
            commands::utility::get_signal_path,
            commands::utility::refresh_signal_path,
            // updates
            commands::updates::check_for_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                state
                    .discord
                    .send(crate::discord::DiscordCommand::Disconnect);
                tauri::async_runtime::block_on(async {
                    state.idle_inhibitor.lock().await.uninhibit().await;
                    state.scrobble_manager.flush().await;
                    state.tidal_reporter.flush().await;
                });
            }
        });
}

#[cfg(test)]
mod settings_tests {
    use super::Settings;

    // Play reporting ships on. Existing configs predate the field, so the serde
    // default is what governs upgrades — not just Settings::default().
    #[test]
    fn report_plays_defaults_on() {
        assert!(Settings::default().report_plays);
        let upgraded: Settings = serde_json::from_str("{}").unwrap();
        assert!(upgraded.report_plays);
    }
}
