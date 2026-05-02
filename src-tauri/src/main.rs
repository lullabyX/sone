// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // NVIDIA GPUs can't allocate GBM buffers for WebKitGTK's DMA-BUF
        // renderer on Wayland.
        // Shared-memory fallback works fine.
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            if let Ok(modules) = std::fs::read_to_string("/proc/modules") {
                if modules.contains("nvidia") {
                    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
                }
            }
        }
    }
    tauri_app_lib::run()
}
