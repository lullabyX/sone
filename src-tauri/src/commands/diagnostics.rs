use tauri::State;
use crate::AppState;

/// Renderer-to-log bridge. The packaged webview has no visible console, so a
/// JS error at boot is otherwise silent; the frontend forwards uncaught
/// errors and rejections here for the app log (see tools/cast_drive.py
/// methodology in AGENTS.md 5.3).
#[tauri::command]
pub async fn log_frontend_error(state: State<'_, AppState>, message: String) -> Result<(), ()> {
    let _ = state;
    log::error!("[frontend-error] {}", message.replace('\n', " | "));
    Ok(())
}

/// Which performance-hooks were compiled into the running instance. The
/// renderer calls this at boot and conditionally loads the profiler module,
/// so the shipped app pays nothing unless SONE_PERF_MONITOR=1.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfFlags {
    pub monitor: bool,
    pub hw_accel: String,
    pub smooth_scroll: String,
}

#[tauri::command]
pub fn get_perf_flags() -> PerfFlags {
    let hw_accel = std::env::var("SONE_HWACCEL")
        .ok()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "demand".to_string());
    let smooth_scroll = std::env::var("SONE_SMOOTH_SCROLL")
        .ok()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "on".to_string());
    let monitor = std::env::var("SONE_PERF_MONITOR")
        .ok()
        .map(|s| s.trim().to_ascii_lowercase())
        .map(|s| !matches!(s.as_str(), "" | "0" | "off" | "false" | "no"))
        .unwrap_or(false);
    PerfFlags {
        monitor,
        hw_accel,
        smooth_scroll,
    }
}

/// INFO-level perf telemetry channel. The renderer FPS/long-task monitor
/// posts periodic summaries here so A/B runs can be scored straight from
/// the app log (`grep '\[perf\]' ~/.config/sone/logs/sone_r*.log`). Keep
/// this at INFO, not error: a dropped sample is not a failure.
#[tauri::command]
pub async fn log_perf_sample(state: State<'_, AppState>, message: String) -> Result<(), ()> {
    let _ = state;
    log::info!("[perf] {}", message);
    Ok(())
}
