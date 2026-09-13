use std::sync::atomic::Ordering;
use tauri::{Manager, State};

use super::playback::compute_norm_gain;
use crate::audio::AudioDevice;
use crate::cache::{CacheResult, CacheTier};
use crate::AppState;
use crate::SignalPath;
use crate::SoneError;

/// Open the SONE log directory (`~/.config/sone/logs`) in the system file
/// manager, creating it if it does not exist yet.
#[tauri::command]
pub fn open_log_folder() -> Result<(), String> {
    let dir = dirs::config_dir()
        .map(|d| d.join("sone").join("logs"))
        .ok_or_else(|| "could not resolve config directory".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::process::Command::new("xdg-open")
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to launch file manager: {e}"))
}

#[tauri::command]
pub fn get_signal_path(state: State<'_, AppState>) -> SignalPath {
    state.signal_path.snapshot()
}

#[tauri::command]
pub fn refresh_signal_path(state: State<'_, AppState>) -> SignalPath {
    state.pipeline_probe.refresh();
    state.signal_path.snapshot()
}

#[tauri::command]
pub async fn update_tray_tooltip(app: tauri::AppHandle, text: String) -> Result<String, SoneError> {
    #[cfg(target_os = "linux")]
    if let Some(tray_handle) = app.try_state::<crate::tray::TrayHandle>() {
        tray_handle.inner().update_tooltip(text).await;
        return Ok("updated".into());
    }
    Ok("tray not available".into())
}

#[tauri::command]
pub async fn get_image_bytes(
    state: State<'_, AppState>,
    url: String,
) -> Result<tauri::ipc::Response, SoneError> {
    log::debug!("[get_image_bytes]: url={}", url);

    match state.disk_cache.get(&url, CacheTier::Image).await {
        CacheResult::Fresh(bytes) | CacheResult::Stale(bytes) => {
            log::debug!("[get_image_bytes]: cache hit ({} bytes)", bytes.len());
            Ok(tauri::ipc::Response::new(bytes))
        }
        CacheResult::Miss => {
            let http_client = state.tidal_client.lock().await.raw_client().clone();
            let res = http_client.get(&url).send().await?;
            let bytes = res.bytes().await?.to_vec();

            state
                .disk_cache
                .put(&url, &bytes, CacheTier::Image, &["image"])
                .await
                .ok();
            log::debug!(
                "[get_image_bytes]: fetched and cached {} bytes",
                bytes.len()
            );

            Ok(tauri::ipc::Response::new(bytes))
        }
    }
}

#[tauri::command]
pub async fn get_cache_stats(
    state: State<'_, AppState>,
) -> Result<crate::cache::CacheStats, SoneError> {
    Ok(state.disk_cache.stats().await)
}

#[tauri::command]
pub async fn clear_disk_cache(state: State<'_, AppState>) -> Result<(), SoneError> {
    log::info!("[clear_disk_cache]: user-initiated cache clear");
    state.disk_cache.clear().await;
    Ok(())
}

#[tauri::command]
pub fn get_decorations(state: State<'_, AppState>) -> bool {
    state.decorations.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_decorations(
    window: tauri::Window,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), SoneError> {
    state.decorations.store(enabled, Ordering::Relaxed);
    window.set_decorations(enabled).map_err(SoneError::from)?;
    let mut settings = state.load_settings().unwrap_or_default();
    settings.decorations = enabled;
    state.save_settings(&settings)?;
    Ok(())
}

#[tauri::command]
pub fn get_minimize_to_tray(state: State<'_, AppState>) -> bool {
    state.minimize_to_tray.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_minimize_to_tray(state: State<'_, AppState>, enabled: bool) -> Result<(), SoneError> {
    state.minimize_to_tray.store(enabled, Ordering::Relaxed);
    let mut settings = state.load_settings().unwrap_or_default();
    settings.minimize_to_tray = enabled;
    state.save_settings(&settings)?;
    Ok(())
}

#[tauri::command]
pub fn get_volume_normalization(state: State<'_, AppState>) -> bool {
    state.volume_normalization.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_volume_normalization(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), SoneError> {
    state.volume_normalization.store(enabled, Ordering::Relaxed);

    // Immediately apply/reset normalization on the current track
    let norm_gain = if enabled {
        let rg = f64::from_bits(state.last_replay_gain.load(Ordering::Relaxed));
        let peak = f64::from_bits(state.last_peak_amplitude.load(Ordering::Relaxed));
        let rg_opt = if rg.is_finite() { Some(rg) } else { None };
        let peak_opt = if peak.is_finite() { Some(peak) } else { None };
        compute_norm_gain(rg_opt, peak_opt)
    } else {
        1.0
    };
    state
        .audio_player
        .set_normalization_gain(norm_gain)
        .map_err(SoneError::Audio)?;
    state.signal_path.set_normalization_enabled(enabled);
    let mut settings = state.load_settings().unwrap_or_default();
    settings.volume_normalization = enabled;
    state.save_settings(&settings)?;
    Ok(())
}

#[tauri::command]
pub fn get_exclusive_mode(state: State<'_, AppState>) -> bool {
    state.exclusive_mode.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_exclusive_mode(state: State<'_, AppState>, enabled: bool) -> Result<(), SoneError> {
    state.exclusive_mode.store(enabled, Ordering::Relaxed);

    if !enabled {
        state.bit_perfect.store(false, Ordering::Relaxed);
        state
            .audio_player
            .set_bit_perfect(false)
            .map_err(SoneError::Audio)?;
    }

    let device = state.exclusive_device.lock().unwrap().clone();
    state
        .audio_player
        .set_exclusive_mode(enabled, device)
        .map_err(SoneError::Audio)?;

    let mut settings = state.load_settings().unwrap_or_default();
    settings.exclusive_mode = enabled;
    if !enabled {
        settings.bit_perfect = false;
    }
    state.save_settings(&settings)?;

    // When leaving exclusive mode, the audio thread tears down the DirectAlsa
    // backend and frees the `hw:` device. If the user opted in, nudge
    // PipeWire/WirePlumber to re-acquire ("reload") that freed device so the
    // desktop mixer can use it again without manual intervention.
    if !enabled && state.reclaim_device.load(Ordering::Relaxed) {
        let dev = state.exclusive_device.lock().unwrap().clone();
        reclaim_output_device(dev);
    }
    Ok(())
}

#[tauri::command]
pub fn get_bit_perfect(state: State<'_, AppState>) -> bool {
    state.bit_perfect.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_bit_perfect(state: State<'_, AppState>, enabled: bool) -> Result<(), SoneError> {
    state.bit_perfect.store(enabled, Ordering::Relaxed);

    if enabled && !state.exclusive_mode.load(Ordering::Relaxed) {
        state.exclusive_mode.store(true, Ordering::Relaxed);
        let device = state.exclusive_device.lock().unwrap().clone();
        state
            .audio_player
            .set_exclusive_mode(true, device)
            .map_err(SoneError::Audio)?;
    }

    state
        .audio_player
        .set_bit_perfect(enabled)
        .map_err(SoneError::Audio)?;

    let mut settings = state.load_settings().unwrap_or_default();
    settings.bit_perfect = enabled;
    if enabled {
        settings.exclusive_mode = true;
    }
    state.save_settings(&settings)?;
    Ok(())
}

#[tauri::command]
pub fn get_gapless(state: State<'_, AppState>) -> bool {
    state.gapless.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn get_gapless_supported() -> bool {
    crate::audio::gapless_supported()
}

#[tauri::command]
pub fn set_gapless(state: State<'_, AppState>, enabled: bool) -> Result<(), SoneError> {
    state.gapless.store(enabled, Ordering::Relaxed);
    state
        .audio_player
        .set_gapless(enabled)
        .map_err(SoneError::Audio)?;
    let mut settings = state.load_settings().unwrap_or_default();
    settings.gapless = enabled;
    state.save_settings(&settings)?;
    Ok(())
}

#[tauri::command]
pub fn get_max_quality(state: State<'_, AppState>) -> String {
    state.max_quality.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_max_quality(state: State<'_, AppState>, quality: String) -> Result<(), SoneError> {
    if !matches!(quality.as_str(), "HI_RES_LOSSLESS" | "LOSSLESS" | "HIGH") {
        return Err(SoneError::Parse(format!("invalid max_quality: {quality}")));
    }
    *state.max_quality.lock().unwrap() = quality.clone();
    let mut settings = state.load_settings().unwrap_or_default();
    settings.max_quality = quality;
    state.save_settings(&settings)?;
    Ok(())
}

#[tauri::command]
pub fn get_exclusive_device(state: State<'_, AppState>) -> Option<String> {
    state.exclusive_device.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_exclusive_device(state: State<'_, AppState>, device: String) -> Result<(), SoneError> {
    *state.exclusive_device.lock().unwrap() = Some(device.clone());

    let enabled = state.exclusive_mode.load(Ordering::Relaxed);
    state
        .audio_player
        .set_exclusive_mode(enabled, Some(device.clone()))
        .map_err(SoneError::Audio)?;
    let mut settings = state.load_settings().unwrap_or_default();
    settings.exclusive_device = Some(device);
    state.save_settings(&settings)?;
    Ok(())
}

#[tauri::command]
pub fn get_reclaim_device(state: State<'_, AppState>) -> bool {
    state.reclaim_device.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_reclaim_device(state: State<'_, AppState>, enabled: bool) -> Result<(), SoneError> {
    state.reclaim_device.store(enabled, Ordering::Relaxed);
    let mut settings = state.load_settings().unwrap_or_default();
    settings.reclaim_device = enabled;
    state.save_settings(&settings)?;
    Ok(())
}

/// Whether the "Reclaim device" feature is applicable on this system.
///
/// The reclaim nudge is specific to PipeWire/WirePlumber: it cycles a sink's
/// suspend state so WirePlumber re-opens the ALSA node it released while SONE
/// held the device exclusively. On plain PulseAudio (or when `pactl` is
/// missing) this does not meaningfully "reload" the hardware, so we hide the
/// toggle. Detection reuses `pactl info`'s "Server Name" field.
#[tauri::command]
pub fn get_reclaim_supported() -> bool {
    let out = match std::process::Command::new("pactl")
        .env("LC_ALL", "C")
        .arg("info")
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return false,
    };
    let stdout = match String::from_utf8(out.stdout) {
        Ok(s) => s,
        Err(_) => return false,
    };
    // "Server Name: PulseAudio (on PipeWire x.y.z)" on PipeWire systems.
    stdout
        .lines()
        .filter_map(|l| l.strip_prefix("Server Name:"))
        .any(|v| v.contains("PipeWire"))
}

/// Notify PipeWire/WirePlumber to recreate ("reload") the output device after
/// SONE has released the exclusive ALSA `hw:` handle.
///
/// Background: when SONE releases an exclusively-held device, WirePlumber can
/// fail to recreate the ALSA node for that card (observed: "Failed to create
/// ALSA node ...: Object activation aborted: PipeWire proxy destroyed"). The
/// PipeWire *sink* for the card then goes **missing entirely** — it is not just
/// suspended — so nudging sinks (`suspend-sink`) does nothing because there is
/// no sink to nudge. The reliable recovery, matching the manual workaround, is
/// to cycle the *card profile* (`set-card-profile <card> off` then back to its
/// output profile), which forces WirePlumber to rebuild the node. If the sink
/// still does not reappear, restart WirePlumber as a last resort.
///
/// `device` is SONE's exclusive ALSA device string (e.g. `hw:CARD=TP35,DEV=0`);
/// we map its ALSA card name to the matching PipeWire `alsa_card.*` and cycle
/// only that card. If we cannot resolve it, we fall back to cycling every ALSA
/// card that currently has no sink. Runs detached with a short delay so the
/// ALSA fd is fully closed before PipeWire re-probes. Best-effort: failures are
/// logged and swallowed.
pub fn reclaim_output_device(device: Option<String>) {
    std::thread::spawn(move || {
        // Let the just-torn-down ALSA writer thread fully close the device fd
        // before PipeWire tries to re-open it.
        std::thread::sleep(std::time::Duration::from_millis(500));

        let run = |args: &[&str]| -> Option<String> {
            let out = std::process::Command::new("pactl")
                .env("LC_ALL", "C")
                .args(args)
                .output()
                .ok()?;
            if !out.status.success() {
                return None;
            }
            String::from_utf8(out.stdout).ok()
        };

        // ── Resolve the target PipeWire card(s) ──────────────────────────
        // `pactl list short cards`: "<index>\t<card_name>\t<driver>..."
        let short_cards = run(&["list", "short", "cards"]).unwrap_or_default();
        let all_cards: Vec<String> = short_cards
            .lines()
            .filter_map(|l| l.split('\t').nth(1))
            .map(|s| s.to_string())
            .collect();

        // Map SONE's exclusive ALSA device -> ALSA card name (e.g. "TP35"),
        // then find the PipeWire card whose name contains it. PipeWire card
        // names look like `alsa_card.usb-..._TP35_Pro_...`.
        let alsa_card = device
            .as_deref()
            .and_then(crate::pipeline_probe::parse_alsa_card_from_device);
        let target_cards: Vec<String> = match alsa_card.as_deref() {
            Some(name) if !name.is_empty() => {
                let matched: Vec<String> = all_cards
                    .iter()
                    .filter(|c| c.contains(name))
                    .cloned()
                    .collect();
                if matched.is_empty() {
                    all_cards.clone()
                } else {
                    matched
                }
            }
            _ => all_cards.clone(),
        };

        if target_cards.is_empty() {
            log::warn!("[audio] reclaim: no PipeWire cards found; nothing to reclaim");
            return;
        }

        // Which sink names exist right now, so we can tell if a card is missing
        // its sink and whether the cycle restored it.
        let sinks_now = || -> String { run(&["list", "short", "sinks"]).unwrap_or_default() };

        for card in &target_cards {
            // Pick the card's best output profile from `pactl list cards`.
            // We restore to a concrete profile rather than leaving it "off".
            let profile = card_output_profile(&run, card)
                .unwrap_or_else(|| "output:analog-stereo".to_string());

            log::info!("[audio] reclaim: cycling profile of card '{card}' -> off -> {profile}");
            let _ = run(&["set-card-profile", card, "off"]);
            std::thread::sleep(std::time::Duration::from_millis(700));
            let _ = run(&["set-card-profile", card, &profile]);
            std::thread::sleep(std::time::Duration::from_millis(700));
        }

        // Verify a sink now exists for the target card; if not, restart the
        // session manager as a last resort (matches the manual workaround).
        let restored = {
            let sinks = sinks_now();
            match alsa_card.as_deref() {
                Some(name) if !name.is_empty() => sinks.contains(name),
                // No specific card: treat "any sink present" as success.
                _ => !sinks.trim().is_empty(),
            }
        };

        if restored {
            log::info!("[audio] reclaim: output device restored via profile cycle");
        } else {
            log::warn!(
                "[audio] reclaim: profile cycle did not restore sink; restarting wireplumber"
            );
            let _ = std::process::Command::new("systemctl")
                .args(["--user", "restart", "wireplumber"])
                .status();
        }
    });
}

/// Read `pactl list cards` and return the best *output* profile for `card`.
///
/// Prefers a currently-available profile that provides output sinks, ranked by
/// the priority PipeWire reports. Falls back to the card's "Active Profile" if
/// it is an output profile. Profile lines look like:
///   `output:analog-stereo: Analog Stereo Output (sinks: 1, sources: 0, priority: 6500, available: yes)`
fn card_output_profile<F>(run: &F, card: &str) -> Option<String>
where
    F: Fn(&[&str]) -> Option<String>,
{
    let out = run(&["list", "cards"])?;
    let mut in_target = false;
    let mut in_profiles = false;
    let mut best: Option<(i64, String)> = None;
    let mut active_profile: Option<String> = None;

    for raw in out.lines() {
        let line = raw.trim();

        if let Some(name) = line.strip_prefix("Name:").map(str::trim) {
            in_target = name == card;
            in_profiles = false;
            continue;
        }
        if !in_target {
            continue;
        }
        if line.starts_with("Profiles:") {
            in_profiles = true;
            continue;
        }
        if let Some(active) = line.strip_prefix("Active Profile:").map(str::trim) {
            active_profile = Some(active.to_string());
            in_profiles = false;
            continue;
        }

        if in_profiles {
            // e.g. "output:analog-stereo: ... (sinks: 1, ... priority: 6500, available: yes)"
            if let Some((id, meta)) = line.split_once(':') {
                let id = id.trim();
                if !id.starts_with("output:") {
                    continue;
                }
                // Require at least one sink and availability != no.
                let has_sink = meta.contains("sinks: ") && !meta.contains("sinks: 0");
                let unavailable = meta.contains("available: no");
                if !has_sink || unavailable {
                    continue;
                }
                let priority = meta
                    .split("priority:")
                    .nth(1)
                    .and_then(|s| s.split(|c: char| !c.is_ascii_digit()).find(|t| !t.is_empty()))
                    .and_then(|n| n.parse::<i64>().ok())
                    .unwrap_or(0);
                if best.as_ref().map(|(p, _)| priority > *p).unwrap_or(true) {
                    best = Some((priority, id.to_string()));
                }
            }
        }
    }

    best.map(|(_, id)| id).or_else(|| {
        active_profile.filter(|p| p.starts_with("output:") && p != "off")
    })
}

#[tauri::command]
pub fn list_audio_devices(state: State<'_, AppState>) -> Result<Vec<AudioDevice>, SoneError> {
    // Return cached devices if available (avoids slow GStreamer DeviceMonitor probe)
    let cached = state.cached_audio_devices.lock().unwrap().clone();
    if let Some(devices) = cached {
        return Ok(devices);
    }

    // First call: probe directly (not via audio thread) and cache
    let devices = crate::audio::list_alsa_devices().map_err(SoneError::Audio)?;
    *state.cached_audio_devices.lock().unwrap() = Some(devices.clone());
    Ok(devices)
}

#[tauri::command]
pub fn get_discord_rpc(state: State<'_, AppState>) -> bool {
    state
        .load_settings()
        .map(|s| s.discord_rpc)
        .unwrap_or(false)
}

#[tauri::command]
pub fn set_discord_rpc(state: State<'_, AppState>, enabled: bool) -> Result<(), SoneError> {
    if enabled {
        state
            .discord
            .send(crate::discord::DiscordCommand::Connect);
    } else {
        state
            .discord
            .send(crate::discord::DiscordCommand::Disconnect);
    }
    let mut settings = state.load_settings().unwrap_or_default();
    settings.discord_rpc = enabled;
    state.save_settings(&settings)?;
    Ok(())
}

#[tauri::command]
pub fn get_report_plays(state: State<'_, AppState>) -> bool {
    state.load_settings().map(|s| s.report_plays).unwrap_or(true)
}

#[tauri::command]
pub async fn set_report_plays(state: State<'_, AppState>, enabled: bool) -> Result<(), SoneError> {
    // Persist first: if the write fails the caller sees an error and the
    // in-memory state still matches disk. Reversing this order can silently
    // discard a user's opt-out.
    let mut settings = state.load_settings().unwrap_or_default();
    settings.report_plays = enabled;
    state.save_settings(&settings)?;

    state.tidal_reporter.set_enabled(enabled);
    if enabled {
        // Flush any offline backlog now that reporting is on.
        state.tidal_reporter.drain_queue().await;
    } else {
        // Drop the in-flight session: every lifecycle hook is gated on
        // `enabled`, so an orphaned session would keep accruing wall-clock time
        // and get reported on the next enable.
        state.tidal_reporter.clear_session().await;
    }
    Ok(())
}

#[tauri::command]
pub fn get_discord_status_text(state: State<'_, AppState>) -> String {
    state
        .load_settings()
        .map(|s| s.discord_status_text)
        .unwrap_or_default()
}

#[tauri::command]
pub fn set_discord_status_text(state: State<'_, AppState>, text: String) -> Result<(), SoneError> {
    state
        .discord
        .send(crate::discord::DiscordCommand::SetStatusText { text: text.clone() });

    let mut settings = state.load_settings().unwrap_or_default();
    settings.discord_status_text = text;
    state.save_settings(&settings)?;
    Ok(())
}

#[tauri::command]
pub fn get_proxy_settings(state: State<'_, AppState>) -> crate::ProxySettings {
    state
        .load_settings()
        .map(|s| s.proxy)
        .unwrap_or_default()
}

#[tauri::command]
pub async fn set_proxy_settings(
    state: State<'_, AppState>,
    settings: crate::ProxySettings,
) -> Result<(), SoneError> {
    // Rebuild the HTTP client with new proxy config
    {
        let mut client = state.tidal_client.lock().await;
        client.rebuild_client(&settings);
    }

    // Also rebuild scrobble provider HTTP clients
    let new_client = {
        let client = state.tidal_client.lock().await;
        client.raw_client().clone()
    };
    state
        .scrobble_manager
        .update_http_client(new_client.clone())
        .await;
    state.tidal_reporter.update_http_client(new_client);

    // Save to disk
    let mut app_settings = state.load_settings().unwrap_or_default();
    app_settings.proxy = settings;
    state.save_settings(&app_settings)?;
    Ok(())
}

#[tauri::command]
pub async fn inhibit_idle(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), SoneError> {
    state.idle_inhibitor.lock().await.inhibit(&window).await;
    Ok(())
}

#[tauri::command]
pub async fn uninhibit_idle(state: State<'_, AppState>) -> Result<(), SoneError> {
    state.idle_inhibitor.lock().await.uninhibit().await;
    Ok(())
}

#[tauri::command]
pub async fn test_proxy_connection(
    settings: crate::ProxySettings,
) -> Result<String, String> {
    let client = crate::tidal_api::build_http_client(&settings)
        .map_err(|e| format!("Failed to create client: {e}"))?;

    match client
        .get("https://api.tidal.com/v1/ping")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() || status.as_u16() == 404 || status.as_u16() == 401 {
                Ok("Connection successful".to_string())
            } else {
                Ok(format!("Tidal responded with status {status}"))
            }
        }
        Err(e) => Err(format!("Connection failed: {e}")),
    }
}

fn logging_toggle_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("sone").join("logging.toggle"))
}

#[tauri::command]
pub fn get_enable_logging() -> bool {
    let Some(path) = logging_toggle_path() else {
        return true;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return true;
    };
    match text.trim() {
        "false" => false,
        _ => true,
    }
}

#[tauri::command]
pub fn set_enable_logging(enabled: bool) -> Result<(), SoneError> {
    let Some(path) = logging_toggle_path() else {
        return Err(SoneError::Io("Could not resolve config dir".into()));
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| SoneError::Io(format!("Failed to create config dir: {e}")))?;
    }
    let body = if enabled { "true" } else { "false" };
    std::fs::write(&path, body)
        .map_err(|e| SoneError::Io(format!("Failed to write logging toggle: {e}")))?;
    Ok(())
}
