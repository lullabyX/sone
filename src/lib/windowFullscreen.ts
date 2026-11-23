import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Sent by the backend with `true` / `false` on every fullscreen change. */
export const WINDOW_FULLSCREEN_EVENT = "window:fullscreen";

/** Whether the window is fullscreen right now, as the window manager has it.
 *  On Linux the window API's isFullscreen() is only SONE's last request. */
export async function windowIsFullscreen(): Promise<boolean> {
  try {
    return await invoke<boolean>("is_window_fullscreen");
  } catch {
    return getCurrentWindow()
      .isFullscreen()
      .catch(() => false);
  }
}
