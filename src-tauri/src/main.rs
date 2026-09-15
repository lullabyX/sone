// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // WebKitGTK's DMA-BUF renderer is unreliable on the NVIDIA proprietary
        // driver: GBM buffer allocation fails (blank/corrupt page rendering) and
        // the GStreamer video path tears and stutters (WebKit Bugzilla #261874
        // and #260654, tauri-apps/tauri#9394). This affects BOTH X11 and Wayland
        // — the web process renders surfaceless, so the DMA-BUF renderer is used
        // regardless of session type. Fall back to shared-memory rendering
        // whenever an NVIDIA kernel module is loaded. Pre-set
        // WEBKIT_DISABLE_DMABUF_RENDERER to override.
        //
        // TODO: revisit when WebKitGTK resolves the NVIDIA DMA-BUF bug
        // (upstream #262607 is WONTFIX as of 2026).
        let already_overridden =
            std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some();

        if !already_overridden {
            let nvidia_loaded = std::fs::read_to_string("/proc/modules")
                .map(|modules| {
                    modules.lines().any(|line| {
                        line.split_whitespace()
                            .next()
                            .map(|name| name == "nvidia" || name.starts_with("nvidia_"))
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false);

            if nvidia_loaded {
                eprintln!(
                    "[sone] NVIDIA detected; setting \
                     WEBKIT_DISABLE_DMABUF_RENDERER=1 to avoid WebKitGTK GBM \
                     allocation failure and video corruption. Pre-set the \
                     variable to override."
                );
                std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
        }

        // Read once, used by both the bypass record and the scrub below, so
        // the two reason about the same sidecar structurally rather than
        // because two reads microseconds apart happened to agree.
        let sidecar = tauri_app_lib::config_dir_for_env()
            .and_then(|d| tauri_app_lib::proxy::read_sidecar(&d));

        // Record whether an ambient bypass list will still be in the
        // environment once this function is done — read here, at the only
        // moment the answer is knowable, because nothing may mutate the
        // environment after `run()` starts GTK's threads.
        //
        // Outside the `if let` below on purpose: with neither `$XDG_CONFIG_HOME`
        // nor `$HOME` set there is no sidecar to read, no scrub, and therefore
        // an ambient bypass list that survives. Recording inside would skip
        // the call and read back `false` — fail-open, the direction this is
        // here to close.
        {
            let present = tauri_app_lib::proxy::SCRUBBED_PROXY_ENV_VARS
                .into_iter()
                .any(|v| std::env::var_os(v).is_some_and(|s| !s.is_empty()));
            tauri_app_lib::proxy::remember_launch_bypass(should_record_launch_bypass(
                present,
                sidecar.clone(),
            ));
        }

        // Own the proxy environment before anything can read it — but only
        // while SONE is actually proxying. `curlhttpsrc` reads `no_proxy` at
        // element construction and honours it over an explicitly-set proxy
        // property, with no property to override it, so an ambient value has
        // to be gone before any element exists; clearing it later is too late,
        // and `set_var` is unsound once GTK/glib have threads.
        //
        // Conditional, and that is the point. `Direct` means the system's own
        // configuration applies: a user behind a corporate proxy with
        // `http_proxy` exported works today, and scrubbing unconditionally
        // would silently route them direct — the exact silent-degradation
        // regression this whole design exists to prevent.
        //
        // The settings file is encrypted and its key needs a keyring and an
        // AppHandle, neither of which exists this early, so the decision comes
        // from the plaintext sidecar, which carries the enabled flag and the
        // proxy type and nothing else.
        if should_scrub_proxy_env(sidecar) {
            // Capture before removing, never after. `Direct` means the
            // system's own configuration applies, and if the user turns
            // SONE's proxy off later in this session that configuration is
            // the only thing routing them — but it lived in exactly the
            // variables about to be deleted. reqwest reads them back from
            // this capture instead of from an environment we emptied.
            //
            // The capture is the full list and the removal is only the
            // bypass pair. That is not an oversight: this is the sole
            // sound moment to read these values, and stage 4a needs the
            // per-scheme ones when it starts scrubbing them.
            let captured: Vec<(String, String)> = tauri_app_lib::proxy::PROXY_ENV_VARS
                .into_iter()
                .filter_map(|v| std::env::var(v).ok().map(|value| (v.to_string(), value)))
                .collect();
            tauri_app_lib::proxy::remember_scrubbed_env(captured);

            for v in tauri_app_lib::proxy::SCRUBBED_PROXY_ENV_VARS {
                std::env::remove_var(v);
            }
        }

        // Must happen here, while the process is still single-threaded: this is
        // the only sound place to mutate the environment, because glib/GTK
        // threads read it back via g_getenv once they exist. The audio worker
        // used to do it after spawning, which was unsound.
        {
            let plugin_path_1_0 = std::env::var("GST_PLUGIN_PATH_1_0").ok();
            let appdir = std::env::var("APPDIR").ok();
            let plugin_path = std::env::var("GST_PLUGIN_PATH").ok();
            let existing_dirs: Vec<&str> = GST_PLUGIN_DIR_CANDIDATES
                .into_iter()
                .filter(|dir| std::path::Path::new(dir).is_dir())
                .collect();

            if let Some(chosen) = gst_plugin_path_choice(
                plugin_path_1_0.as_deref(),
                appdir.as_deref(),
                plugin_path.as_deref(),
                &existing_dirs,
            ) {
                std::env::set_var("GST_PLUGIN_PATH", chosen);
            }
        }
    }
    tauri_app_lib::run()
}

/// Whether the startup scrub runs, given whatever the launch sidecar said.
///
/// Pure so the one rule that matters can be asserted without touching the
/// environment: anything other than a recorded, enabled proxy leaves the
/// variables exactly as the user's shell set them. A missing sidecar (first
/// launch, or a write that failed) is *not* a default — it is "not proxying".
#[cfg(target_os = "linux")]
fn should_scrub_proxy_env(sidecar: Option<(bool, String)>) -> bool {
    matches!(sidecar, Some((true, _)))
}

/// Whether the launch-time bypass list is recorded as still in force, given
/// whether one was present in the environment and whatever the launch sidecar
/// said.
///
/// Pure for the same reason as `should_scrub_proxy_env`, and needed more: the
/// gate is load-bearing in *both* directions and is one token from either
/// failure. Dropping the scrub term refuses every proxied tier, for the whole
/// session, for a user who launched with the proxy on and `no_proxy` exported —
/// a launch that scrubbed has no ambient bypass list left to defeat anything.
/// Dropping the whole call reopens the containment hole: `curlhttpsrc` reads
/// `no_proxy` when the element is constructed and forwards it as
/// `CURLOPT_NOPROXY`, which beats the `proxy` property, so a bypass list that
/// survived startup silently sends audio out on the user's real address.
#[cfg(target_os = "linux")]
fn should_record_launch_bypass(present: bool, sidecar: Option<(bool, String)>) -> bool {
    present && !should_scrub_proxy_env(sidecar)
}

/// System GStreamer plugin directories, probed in order, and only when the
/// process is not running from a bundle.
#[cfg(target_os = "linux")]
const GST_PLUGIN_DIR_CANDIDATES: [&str; 3] = [
    "/usr/lib/x86_64-linux-gnu/gstreamer-1.0",
    "/usr/lib64/gstreamer-1.0",
    "/usr/lib/gstreamer-1.0",
];

/// Decide what `GST_PLUGIN_PATH` should become, or `None` to leave it alone.
///
/// Pure so the precedence is testable; the caller does the filesystem probing
/// and passes only the candidate directories that exist, in preference order.
///
/// The rules are the ones the audio worker used before this moved to `main`,
/// and the order matters:
///
/// 1. Running from a bundle (`GST_PLUGIN_PATH_1_0` or `APPDIR` present): the
///    bundle wins. `GST_PLUGIN_PATH_1_0` **overwrites** an inherited
///    `GST_PLUGIN_PATH`, because a host value leaking into an AppImage points
///    at the host's plugins, which are the wrong ABI.
/// 2. `APPDIR` set but `GST_PLUGIN_PATH_1_0` absent: do nothing at all. A
///    bundle that did not export a plugin path is not asking to be pointed at
///    the host's system directories, so no probing happens.
/// 3. Otherwise, probe the system directories, but only if `GST_PLUGIN_PATH` is
///    not already set.
#[cfg(target_os = "linux")]
fn gst_plugin_path_choice(
    plugin_path_1_0: Option<&str>,
    appdir: Option<&str>,
    plugin_path: Option<&str>,
    existing_dirs: &[&str],
) -> Option<String> {
    if plugin_path_1_0.is_some() || appdir.is_some() {
        return plugin_path_1_0.map(str::to_string);
    }
    if plugin_path.is_some() {
        return None;
    }
    existing_dirs.first().map(|dir| dir.to_string())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::{gst_plugin_path_choice, should_record_launch_bypass, should_scrub_proxy_env};

    #[test]
    fn a_recorded_enabled_proxy_scrubs_whatever_its_type() {
        assert!(should_scrub_proxy_env(Some((true, "http".into()))));
        assert!(should_scrub_proxy_env(Some((true, "socks5".into()))));
    }

    /// The regression this task must not introduce: the proxy toggle off means
    /// the system's own configuration applies, so an exported `http_proxy` has
    /// to survive startup untouched.
    #[test]
    fn the_proxy_toggle_off_leaves_the_environment_alone() {
        assert!(!should_scrub_proxy_env(Some((false, "http".into()))));
        assert!(!should_scrub_proxy_env(Some((false, "socks5".into()))));
    }

    /// No sidecar at all — every launch before this feature shipped, and every
    /// first launch after it.
    #[test]
    fn an_unknown_mode_leaves_the_environment_alone() {
        assert!(!should_scrub_proxy_env(None));
    }

    /// The whole truth table, because each row fails a different way and the
    /// two `false` rows fail in opposite directions.
    ///
    /// Row `(present, proxying)`: the launch scrubbed the bypass list, so
    /// nothing is left to defeat the proxy. Recording `true` here refuses
    /// every proxied tier for a session that is perfectly fine, and restarting
    /// reproduces it exactly — the failure that pins the `!should_scrub` term.
    #[test]
    fn a_launch_that_scrubbed_has_no_surviving_bypass_list() {
        assert!(!should_record_launch_bypass(
            true,
            Some((true, "http".into()))
        ));
        assert!(!should_record_launch_bypass(
            true,
            Some((true, "socks5".into()))
        ));
    }

    /// Row `(present, not proxying)`: nothing scrubbed, so the bypass list is
    /// still in the environment and will beat the `proxy` property the moment
    /// the user turns the proxy on. This is the containment hole, and the row
    /// that pins the call existing at all.
    #[test]
    fn a_bypass_list_that_survived_an_unscrubbed_launch_is_recorded() {
        assert!(should_record_launch_bypass(true, None));
        assert!(should_record_launch_bypass(
            true,
            Some((false, "http".into()))
        ));
    }

    /// Row `(absent, _)`: no bypass list at launch, nothing to record, whatever
    /// the sidecar said. Recording `true` on either of these refuses proxied
    /// playback for every user who never exported `no_proxy` at all.
    #[test]
    fn no_bypass_list_at_launch_records_nothing_either_way() {
        assert!(!should_record_launch_bypass(false, None));
        assert!(!should_record_launch_bypass(
            false,
            Some((false, "http".into()))
        ));
        assert!(!should_record_launch_bypass(
            false,
            Some((true, "http".into()))
        ));
    }

    const DIRS: [&str; 2] = ["/usr/lib64/gstreamer-1.0", "/usr/lib/gstreamer-1.0"];

    #[test]
    fn bundle_plugin_path_overwrites_an_inherited_one() {
        assert_eq!(
            gst_plugin_path_choice(
                Some("/app/lib/gstreamer-1.0"),
                None,
                Some("/usr/lib/gstreamer-1.0"),
                &DIRS,
            ),
            Some("/app/lib/gstreamer-1.0".to_string()),
            "a host GST_PLUGIN_PATH leaking into a bundle must not win"
        );
    }

    /// The ordinary AppImage layout: AppRun exports GST_PLUGIN_PATH_1_0 and the
    /// host has no GST_PLUGIN_PATH at all. Every other bundle case here passes a
    /// *set* plugin_path, so without this one an implementation that only
    /// honours _1_0 when something is already set passes the whole suite while
    /// leaving the most common bundle with no plugin path.
    #[test]
    fn a_bundle_plugin_path_is_used_when_nothing_was_inherited() {
        assert_eq!(
            gst_plugin_path_choice(Some("/app/lib/gstreamer-1.0"), None, None, &DIRS),
            Some("/app/lib/gstreamer-1.0".to_string()),
            "the canonical AppImage layout must still get the bundle's plugins"
        );
    }

    /// Same, with APPDIR also exported, which is what AppRun actually does.
    #[test]
    fn a_bundle_plugin_path_wins_with_appdir_present_and_nothing_inherited() {
        assert_eq!(
            gst_plugin_path_choice(
                Some("/app/lib/gstreamer-1.0"),
                Some("/tmp/.mount_sone"),
                None,
                &DIRS,
            ),
            Some("/app/lib/gstreamer-1.0".to_string())
        );
    }

    /// Row `(_1_0 set, APPDIR set, GST_PLUGIN_PATH set)`: the bundle still wins.
    #[test]
    fn a_bundle_plugin_path_overwrites_an_inherited_one_with_appdir_present() {
        assert_eq!(
            gst_plugin_path_choice(
                Some("/app/lib/gstreamer-1.0"),
                Some("/tmp/.mount_sone"),
                Some("/usr/lib/gstreamer-1.0"),
                &DIRS,
            ),
            Some("/app/lib/gstreamer-1.0".to_string())
        );
    }

    /// Row `(_1_0 unset, APPDIR set, GST_PLUGIN_PATH set)`: still a bundle, so
    /// still no probe. Without this, a mutant that falls through to the system
    /// directories on this row points an AppImage at host plugins undetected.
    #[test]
    fn appdir_with_an_inherited_path_probes_nothing_either() {
        assert_eq!(
            gst_plugin_path_choice(
                None,
                Some("/tmp/.mount_sone"),
                Some("/usr/lib/gstreamer-1.0"),
                &DIRS,
            ),
            None,
            "a bundle must never be pointed at the host's system plugin dirs"
        );
    }

    #[test]
    fn appdir_without_a_bundle_plugin_path_probes_nothing() {
        assert_eq!(
            gst_plugin_path_choice(None, Some("/tmp/.mount_sone"), None, &DIRS),
            None,
            "an AppImage must not be pointed at the host's system plugin dirs"
        );
    }

    #[test]
    fn outside_a_bundle_an_unset_path_takes_the_first_existing_dir() {
        assert_eq!(
            gst_plugin_path_choice(None, None, None, &DIRS),
            Some("/usr/lib64/gstreamer-1.0".to_string())
        );
    }

    #[test]
    fn outside_a_bundle_an_existing_path_is_left_alone() {
        assert_eq!(
            gst_plugin_path_choice(None, None, Some("/opt/gst"), &DIRS),
            None
        );
    }

    #[test]
    fn outside_a_bundle_with_no_existing_dirs_nothing_is_set() {
        assert_eq!(gst_plugin_path_choice(None, None, None, &[]), None);
    }
}
