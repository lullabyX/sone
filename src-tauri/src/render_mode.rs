use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RenderMode {
    #[default]
    Auto,
    Gpu,
    Cpu,
}

impl RenderMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "auto" => Some(Self::Auto),
            "gpu" => Some(Self::Gpu),
            "cpu" => Some(Self::Cpu),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Gpu => "gpu",
            Self::Cpu => "cpu",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EffectivePath {
    Gpu,
    Cpu,
}

impl EffectivePath {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "gpu" => Some(Self::Gpu),
            "cpu" => Some(Self::Cpu),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Gpu => "gpu",
            Self::Cpu => "cpu",
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Sidecar {
    pub mode: RenderMode,
    pub pending: Option<RenderMode>,
    pub trial: Option<RenderMode>,
    pub revert: Option<RenderMode>,
    pub last: Option<EffectivePath>,
}

/// Plaintext because `main.rs` must read it before GTK starts, long before the
/// encrypted settings can be decrypted.
pub fn sidecar_path(config_dir: &Path) -> PathBuf {
    config_dir.join("render.mode")
}

pub fn parse_sidecar(body: &str) -> Sidecar {
    let mut s = Sidecar::default();
    for line in body.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "mode" => {
                if let Some(m) = RenderMode::parse(value) {
                    s.mode = m;
                }
            }
            "pending" => s.pending = RenderMode::parse(value),
            "trial" => s.trial = RenderMode::parse(value),
            "revert" => s.revert = RenderMode::parse(value),
            "last" => s.last = EffectivePath::parse(value),
            _ => {}
        }
    }
    s
}

pub fn serialize_sidecar(s: &Sidecar) -> String {
    let mut body = format!("mode={}\n", s.mode.as_str());
    for (key, value) in [
        ("pending", s.pending),
        ("trial", s.trial),
        ("revert", s.revert),
    ] {
        if let Some(m) = value {
            body.push_str(&format!("{key}={}\n", m.as_str()));
        }
    }
    if let Some(p) = s.last {
        body.push_str(&format!("last={}\n", p.as_str()));
    }
    body
}

pub fn read_sidecar(config_dir: &Path) -> Sidecar {
    std::fs::read_to_string(sidecar_path(config_dir))
        .map(|body| parse_sidecar(&body))
        .unwrap_or_default()
}

pub fn write_sidecar(config_dir: &Path, s: &Sidecar) -> bool {
    match write_sidecar_file(&sidecar_path(config_dir), &serialize_sidecar(s)) {
        Ok(()) => true,
        Err(e) => {
            log::warn!("[render] could not write mode sidecar: {e}");
            false
        }
    }
}

/// `OpenOptions::mode` applies only on create, so the permissions are set again
/// to tighten a file left behind under a looser umask.
fn write_sidecar_file(path: &Path, body: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(body.as_bytes())?;
    f.set_permissions(std::fs::Permissions::from_mode(0o600))
}

/// Whether each variable was present at launch, whatever its value.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct EnvPreset {
    pub dmabuf_disabled: bool,
    pub compositing_disabled: bool,
}

pub fn env_preset(env: &[(OsString, OsString)]) -> EnvPreset {
    let has = |name: &str| env.iter().any(|(k, _)| k == name);
    EnvPreset {
        dmabuf_disabled: has("WEBKIT_DISABLE_DMABUF_RENDERER"),
        compositing_disabled: has("WEBKIT_DISABLE_COMPOSITING_MODE"),
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EnvAction {
    Leave,
    SetDisableDmabuf,
    RemoveBoth,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Resolution {
    pub action: EnvAction,
    pub path: EffectivePath,
    pub env_override: bool,
    pub nvidia: bool,
}

pub fn resolve(mode: RenderMode, env: EnvPreset, nvidia: bool) -> Resolution {
    let (action, path, env_override) = match mode {
        RenderMode::Auto if env.dmabuf_disabled || env.compositing_disabled => {
            (EnvAction::Leave, EffectivePath::Cpu, true)
        }
        RenderMode::Auto if nvidia => (EnvAction::SetDisableDmabuf, EffectivePath::Cpu, false),
        RenderMode::Auto => (EnvAction::Leave, EffectivePath::Gpu, false),
        RenderMode::Gpu => (EnvAction::RemoveBoth, EffectivePath::Gpu, false),
        RenderMode::Cpu => (EnvAction::SetDisableDmabuf, EffectivePath::Cpu, false),
    };
    Resolution {
        action,
        path,
        env_override,
        nvidia,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Trial {
    pub mode: RenderMode,
    pub revert_to: RenderMode,
    pub unprompted: bool,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct LaunchPlan {
    pub apply: RenderMode,
    pub trial: Option<Trial>,
    pub reverted_from: Option<RenderMode>,
    pub sidecar_after: Sidecar,
}

/// A trial still recorded at launch means the previous run never confirmed it,
/// so it is treated as failed and rolled back.
pub fn plan_launch(
    before: Sidecar,
    resolve_path: impl Fn(RenderMode) -> EffectivePath,
) -> LaunchPlan {
    let mut after = before.clone();

    if let Some(tried) = before.trial {
        let apply = before.revert.unwrap_or(before.mode);
        after.mode = apply;
        after.trial = None;
        after.revert = None;
        after.last = Some(resolve_path(apply));
        return LaunchPlan {
            apply,
            trial: None,
            reverted_from: Some(tried),
            sidecar_after: after,
        };
    }

    if let Some(pending) = before.pending {
        after.pending = None;
        after.trial = Some(pending);
        after.revert = Some(before.mode);
        after.last = Some(resolve_path(pending));
        let trial = Trial {
            mode: pending,
            revert_to: before.mode,
            unprompted: false,
        };
        return LaunchPlan {
            apply: pending,
            trial: Some(trial),
            reverted_from: None,
            sidecar_after: after,
        };
    }

    let path = resolve_path(before.mode);
    let changed = match before.last {
        Some(last) => last != path,
        None => path == EffectivePath::Gpu,
    };
    let trial = changed.then(|| {
        let revert_to = match path {
            EffectivePath::Gpu => RenderMode::Cpu,
            EffectivePath::Cpu => RenderMode::Gpu,
        };
        after.trial = Some(before.mode);
        after.revert = Some(revert_to);
        Trial {
            mode: before.mode,
            revert_to,
            unprompted: true,
        }
    });
    after.last = Some(path);
    LaunchPlan {
        apply: before.mode,
        trial,
        reverted_from: None,
        sidecar_after: after,
    }
}

pub fn nvidia_from(modules: &str, dev_nvidia0_exists: bool) -> bool {
    dev_nvidia0_exists
        || modules.lines().any(|line| {
            line.split_whitespace()
                .next()
                .is_some_and(|name| name == "nvidia" || name.starts_with("nvidia_"))
        })
}

pub fn nvidia_present() -> bool {
    let modules = std::fs::read_to_string("/proc/modules").unwrap_or_default();
    nvidia_from(&modules, Path::new("/dev/nvidia0").exists())
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct LaunchInfo {
    pub resolution: Resolution,
    pub trial: Option<Trial>,
    pub reverted_from: Option<RenderMode>,
    pub mode: RenderMode,
}

static LAUNCH_INFO: OnceLock<LaunchInfo> = OnceLock::new();
static LAUNCH_ENV: OnceLock<Vec<(OsString, OsString)>> = OnceLock::new();

pub fn remember_launch(info: LaunchInfo) {
    let _ = LAUNCH_INFO.set(info);
}

pub fn launch_info() -> Option<LaunchInfo> {
    LAUNCH_INFO.get().copied()
}

pub fn remember_launch_env(env: Vec<(OsString, OsString)>) {
    let _ = LAUNCH_ENV.set(env);
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTrial {
    pub mode: RenderMode,
    pub revert_to: RenderMode,
    pub unprompted: bool,
    pub deadline_ms: u64,
}

pub fn confirmed_sidecar(before: Sidecar, trial: &ActiveTrial) -> Sidecar {
    Sidecar {
        mode: trial.mode,
        pending: None,
        trial: None,
        revert: None,
        ..before
    }
}

static PRIMARY_LOCK: OnceLock<std::fs::File> = OnceLock::new();
static RESTART_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Held for the process lifetime, so a second launch that is about to hand off
/// to the running instance never consumes or rolls back that instance's trial.
pub fn claim_primary(config_dir: &Path) -> bool {
    let _ = std::fs::create_dir_all(config_dir);
    match try_lock_file(&config_dir.join("render.lock")) {
        Some(file) => PRIMARY_LOCK.set(file).is_ok(),
        None => false,
    }
}

fn try_lock_file(path: &Path) -> Option<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::io::AsRawFd;

    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)
        .ok()?;
    // SAFETY: the fd is owned by `file`, which outlives the call.
    let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
    locked.then_some(file)
}

pub fn request_restart(app: &tauri::AppHandle) {
    RESTART_REQUESTED.store(true, Ordering::SeqCst);
    app.exit(0);
}

pub fn restart_requested() -> bool {
    RESTART_REQUESTED.load(Ordering::SeqCst)
}

fn relaunch_binary(snapshot: &[(OsString, OsString)], current_exe: PathBuf) -> PathBuf {
    snapshot
        .iter()
        .find(|(k, v)| k == "APPIMAGE" && !v.is_empty())
        .map(|(_, v)| PathBuf::from(v))
        .unwrap_or(current_exe)
}

/// Replaces this process in place, so the relaunch keeps its PID, sandbox and
/// AppImage mount, and runs with the launch environment rather than the one
/// `main` edited. Returns only if the exec failed.
pub fn exec_relaunch() {
    use std::os::unix::process::CommandExt;

    let env: Vec<(OsString, OsString)> = LAUNCH_ENV
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::vars_os().collect());
    let current_exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            log::error!("[render] could not resolve current executable: {e}");
            return;
        }
    };
    let binary = relaunch_binary(&env, current_exe);
    let mut command = std::process::Command::new(&binary);
    command
        .args(std::env::args_os().skip(1))
        .env_clear()
        .envs(env);
    log::logger().flush();
    let err = command.exec();
    log::error!("[render] relaunch of {} failed: {err}", binary.display());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn garbage_sidecar_reads_as_defaults() {
        assert_eq!(
            parse_sidecar("mode=banana\nwhat=ever\n\n=\n"),
            Sidecar::default()
        );
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_sidecar(dir.path()), Sidecar::default());
    }

    #[test]
    fn sidecar_roundtrips() {
        let s = Sidecar {
            mode: RenderMode::Gpu,
            pending: Some(RenderMode::Cpu),
            trial: None,
            revert: None,
            last: Some(EffectivePath::Gpu),
        };
        assert_eq!(parse_sidecar(&serialize_sidecar(&s)), s);
        let dir = tempfile::tempdir().unwrap();
        assert!(write_sidecar(dir.path(), &s));
        assert_eq!(read_sidecar(dir.path()), s);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(sidecar_path(dir.path()))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn a_failed_sidecar_write_reports_false() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!write_sidecar(
            &dir.path().join("missing"),
            &Sidecar::default()
        ));
    }

    #[test]
    fn auto_respects_env_then_nvidia() {
        let none = EnvPreset {
            dmabuf_disabled: false,
            compositing_disabled: false,
        };
        assert_eq!(
            resolve(RenderMode::Auto, none, false),
            Resolution {
                action: EnvAction::Leave,
                path: EffectivePath::Gpu,
                env_override: false,
                nvidia: false
            }
        );
        assert_eq!(
            resolve(RenderMode::Auto, none, true).action,
            EnvAction::SetDisableDmabuf
        );
        let comp = EnvPreset {
            dmabuf_disabled: false,
            compositing_disabled: true,
        };
        let r = resolve(RenderMode::Auto, comp, false);
        assert_eq!(
            (r.action, r.path, r.env_override),
            (EnvAction::Leave, EffectivePath::Cpu, true)
        );
    }

    #[test]
    fn explicit_gpu_removes_both_vars() {
        let both = EnvPreset {
            dmabuf_disabled: true,
            compositing_disabled: true,
        };
        let r = resolve(RenderMode::Gpu, both, true);
        assert_eq!(
            (r.action, r.path, r.env_override),
            (EnvAction::RemoveBoth, EffectivePath::Gpu, false)
        );
    }

    #[test]
    fn explicit_cpu_sets_disable() {
        let none = EnvPreset {
            dmabuf_disabled: false,
            compositing_disabled: false,
        };
        assert_eq!(
            resolve(RenderMode::Cpu, none, false).action,
            EnvAction::SetDisableDmabuf
        );
    }

    #[test]
    fn a_pending_choice_starts_a_prompted_trial() {
        let before = Sidecar {
            mode: RenderMode::Auto,
            pending: Some(RenderMode::Gpu),
            last: Some(EffectivePath::Cpu),
            ..Default::default()
        };
        let p = plan_launch(before, |_| EffectivePath::Gpu);
        assert_eq!(p.apply, RenderMode::Gpu);
        assert_eq!(
            p.trial,
            Some(Trial {
                mode: RenderMode::Gpu,
                revert_to: RenderMode::Auto,
                unprompted: false
            })
        );
        assert_eq!(
            p.sidecar_after,
            Sidecar {
                mode: RenderMode::Auto,
                pending: None,
                trial: Some(RenderMode::Gpu),
                revert: Some(RenderMode::Auto),
                last: Some(EffectivePath::Gpu)
            }
        );
    }

    #[test]
    fn a_leftover_trial_reverts_and_clears() {
        let before = Sidecar {
            mode: RenderMode::Auto,
            trial: Some(RenderMode::Gpu),
            revert: Some(RenderMode::Auto),
            last: Some(EffectivePath::Gpu),
            ..Default::default()
        };
        let p = plan_launch(before, |_| EffectivePath::Cpu);
        assert_eq!(p.apply, RenderMode::Auto);
        assert_eq!(p.trial, None);
        assert_eq!(p.reverted_from, Some(RenderMode::Gpu));
        assert_eq!(p.sidecar_after.trial, None);
        assert_eq!(p.sidecar_after.last, Some(EffectivePath::Cpu));
    }

    #[test]
    fn a_path_change_without_a_choice_starts_an_unprompted_trial() {
        let before = Sidecar {
            mode: RenderMode::Auto,
            last: Some(EffectivePath::Cpu),
            ..Default::default()
        };
        let p = plan_launch(before, |_| EffectivePath::Gpu);
        assert_eq!(
            p.trial,
            Some(Trial {
                mode: RenderMode::Auto,
                revert_to: RenderMode::Cpu,
                unprompted: true
            })
        );
        assert_eq!(p.sidecar_after.revert, Some(RenderMode::Cpu));
    }

    #[test]
    fn first_launch_on_cpu_is_quiet_and_on_gpu_is_a_trial() {
        assert_eq!(
            plan_launch(Sidecar::default(), |_| EffectivePath::Cpu).trial,
            None
        );
        assert!(
            plan_launch(Sidecar::default(), |_| EffectivePath::Gpu)
                .trial
                .unwrap()
                .unprompted
        );
    }

    #[test]
    fn nvidia_detection_reads_modules_or_device_node() {
        assert!(nvidia_from("nvidia_drm 1 0 - Live 0x0\n", false));
        assert!(nvidia_from("nvidia 1 0 - Live 0x0\n", false));
        assert!(!nvidia_from("nvidiafb 1 0\ni915 1 0\n", false));
        assert!(nvidia_from("", true));
    }

    #[test]
    fn the_lock_is_exclusive_while_held() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("render.lock");
        let first = try_lock_file(&path).expect("first lock");
        assert!(try_lock_file(&path).is_none());
        drop(first);
        assert!(try_lock_file(&path).is_some());
    }

    #[test]
    fn claim_primary_creates_a_missing_config_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("sone");
        assert!(claim_primary(&dir));
        assert!(dir.join("render.lock").exists());
    }

    #[test]
    fn relaunch_prefers_the_appimage_over_the_current_exe() {
        let exe = PathBuf::from("/tmp/.mount_sone/usr/bin/sone");
        let with = [
            (OsString::from("HOME"), OsString::from("/home/u")),
            (
                OsString::from("APPIMAGE"),
                OsString::from("/home/u/SONE.AppImage"),
            ),
        ];
        assert_eq!(
            relaunch_binary(&with, exe.clone()),
            PathBuf::from("/home/u/SONE.AppImage")
        );
        let without = [(OsString::from("HOME"), OsString::from("/home/u"))];
        assert_eq!(relaunch_binary(&without, exe.clone()), exe);
    }

    fn active(mode: RenderMode, revert_to: RenderMode) -> ActiveTrial {
        ActiveTrial {
            mode,
            revert_to,
            unprompted: false,
            deadline_ms: 0,
        }
    }

    #[test]
    fn confirming_keeps_the_trial_mode_and_clears_the_rest() {
        let before = Sidecar {
            mode: RenderMode::Auto,
            pending: None,
            trial: Some(RenderMode::Gpu),
            revert: Some(RenderMode::Auto),
            last: Some(EffectivePath::Gpu),
        };
        assert_eq!(
            confirmed_sidecar(before, &active(RenderMode::Gpu, RenderMode::Auto)),
            Sidecar {
                mode: RenderMode::Gpu,
                last: Some(EffectivePath::Gpu),
                ..Default::default()
            }
        );
    }

    #[test]
    fn a_trial_left_in_the_sidecar_reverts_to_the_reverted_modes_path() {
        let before = Sidecar {
            mode: RenderMode::Auto,
            trial: Some(RenderMode::Gpu),
            revert: Some(RenderMode::Auto),
            last: Some(EffectivePath::Gpu),
            ..Default::default()
        };
        let p = plan_launch(before, |m| match m {
            RenderMode::Gpu => EffectivePath::Gpu,
            _ => EffectivePath::Cpu,
        });
        assert_eq!(p.reverted_from, Some(RenderMode::Gpu));
        assert_eq!(p.sidecar_after.mode, RenderMode::Auto);
        assert_eq!(p.sidecar_after.last, Some(EffectivePath::Cpu));
    }

    #[test]
    fn env_preset_reports_presence_whatever_the_value() {
        let env = [(
            OsString::from("WEBKIT_DISABLE_COMPOSITING_MODE"),
            OsString::from("0"),
        )];
        assert_eq!(
            env_preset(&env),
            EnvPreset {
                dmabuf_disabled: false,
                compositing_disabled: true
            }
        );
    }

    #[test]
    fn an_unchanged_path_starts_nothing() {
        let before = Sidecar {
            last: Some(EffectivePath::Gpu),
            ..Default::default()
        };
        assert_eq!(plan_launch(before, |_| EffectivePath::Gpu).trial, None);
    }
}
