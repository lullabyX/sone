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
    }
    tauri_app_lib::run()
}
