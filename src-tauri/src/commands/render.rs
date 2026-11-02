use std::path::Path;

use tauri::State;

use crate::render_mode::{self, ActiveTrial, EffectivePath, EnvPreset, RenderMode, Resolution};
use crate::AppState;
use crate::SoneError;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderStatus {
    pub mode: RenderMode,
    pub path: EffectivePath,
    pub env_override: bool,
    pub nvidia: bool,
    pub reason: String,
}

pub fn reason_for(status: &Resolution, mode: RenderMode) -> String {
    let reason = if status.env_override {
        "set by environment"
    } else if mode != RenderMode::Auto {
        "chosen in Settings"
    } else if status.nvidia && status.path == EffectivePath::Cpu {
        "NVIDIA detected"
    } else {
        "default"
    };
    reason.to_string()
}

fn config_dir(state: &AppState) -> Result<&Path, SoneError> {
    state
        .settings_path
        .parent()
        .ok_or_else(|| SoneError::Io("Could not resolve config dir".into()))
}

fn active_trial(state: &AppState) -> std::sync::MutexGuard<'_, Option<ActiveTrial>> {
    state
        .render_trial
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tauri::command]
pub fn get_render_status() -> RenderStatus {
    let (resolution, mode) = render_mode::launch_info()
        .map(|i| (i.resolution, i.mode))
        .unwrap_or_else(|| {
            let no_env = EnvPreset {
                dmabuf_disabled: false,
                compositing_disabled: false,
            };
            (
                render_mode::resolve(RenderMode::Auto, no_env, false),
                RenderMode::Auto,
            )
        });
    RenderStatus {
        mode,
        path: resolution.path,
        env_override: resolution.env_override,
        nvidia: resolution.nvidia,
        reason: reason_for(&resolution, mode),
    }
}

#[tauri::command]
pub fn set_render_mode(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    mode: String,
) -> Result<(), SoneError> {
    let mode = RenderMode::parse(&mode)
        .ok_or_else(|| SoneError::Parse(format!("invalid render mode: {mode}")))?;
    if active_trial(&state).is_some() {
        return Err(SoneError::Io(
            "A rendering mode trial is still running".into(),
        ));
    }
    let dir = config_dir(&state)?;
    let mut sidecar = render_mode::read_sidecar(dir);
    sidecar.pending = Some(mode);
    render_mode::write_sidecar(dir, &sidecar);
    render_mode::request_restart(&app);
    Ok(())
}

#[tauri::command]
pub fn get_render_trial(state: State<'_, AppState>) -> Option<ActiveTrial> {
    *active_trial(&state)
}

#[tauri::command]
pub fn confirm_render_mode(state: State<'_, AppState>) -> Result<(), SoneError> {
    let dir = config_dir(&state)?;
    let mut slot = active_trial(&state);
    let Some(trial) = *slot else {
        return Ok(());
    };
    let sidecar = render_mode::confirmed_sidecar(render_mode::read_sidecar(dir), &trial);
    if !render_mode::write_sidecar(dir, &sidecar) {
        return Err(SoneError::Io("Could not save the rendering mode".into()));
    }
    *slot = None;
    Ok(())
}

#[tauri::command]
pub fn revert_render_mode(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), SoneError> {
    revert_and_restart(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn get_render_reverted() -> Option<RenderMode> {
    render_mode::launch_info().and_then(|i| i.reverted_from)
}

/// Taking the trial out of state is what makes Keep, Revert and the timer
/// mutually exclusive: whichever gets it first decides. The sidecar still
/// records the trial, so the next launch reverts it and reports the revert.
pub(crate) fn revert_and_restart(app: &tauri::AppHandle, state: &AppState) {
    let Some(_) = active_trial(state).take() else {
        return;
    };
    render_mode::request_restart(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reason_text_follows_the_resolution() {
        use crate::render_mode::*;
        let r = Resolution {
            action: EnvAction::SetDisableDmabuf,
            path: EffectivePath::Cpu,
            env_override: false,
            nvidia: true,
        };
        assert_eq!(reason_for(&r, RenderMode::Auto), "NVIDIA detected");
        assert_eq!(
            reason_for(
                &Resolution {
                    env_override: true,
                    ..r
                },
                RenderMode::Auto
            ),
            "set by environment"
        );
        assert_eq!(reason_for(&r, RenderMode::Cpu), "chosen in Settings");
        assert_eq!(
            reason_for(
                &Resolution {
                    nvidia: false,
                    action: EnvAction::Leave,
                    path: EffectivePath::Gpu,
                    env_override: false
                },
                RenderMode::Auto
            ),
            "default"
        );
    }
}
