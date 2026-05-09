// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // WebKitGTK's DMA-BUF renderer fails to allocate GBM buffers on
        // NVIDIA + Wayland (issue #87, tauri-apps/tauri#10702, WebKit
        // Bugzilla #261874). Fall back to shared-memory rendering when an
        // NVIDIA kernel module is loaded under a Wayland session. Pre-set
        // WEBKIT_DISABLE_DMABUF_RENDERER to override.
        //
        // TODO: revisit when WebKitGTK resolves the NVIDIA DMA-BUF bug.
        let on_wayland = std::env::var("XDG_SESSION_TYPE")
            .map(|v| v.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false);
        let already_overridden =
            std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some();

        if on_wayland && !already_overridden {
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
                    "[sone] NVIDIA detected on Wayland; setting \
                     WEBKIT_DISABLE_DMABUF_RENDERER=1 to avoid WebKitGTK \
                     GBM allocation failure. Pre-set the variable to override."
                );
                std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
        }
    }
    tauri_app_lib::run()
}
