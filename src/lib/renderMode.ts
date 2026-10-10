import { invoke } from "@tauri-apps/api/core";

/**
 * Flags the document when WebKitGTK paints without accelerated compositing
 * (main.rs turns the DMA-BUF renderer off on NVIDIA). There a CSS animation
 * cannot move a layer on its own: every frame repaints everything under and
 * over the animated area on the web process main thread, so full-width
 * decorative animations hold still instead.
 *
 * If the backend cannot answer, animations stay on.
 */
export async function trackRenderMode(): Promise<void> {
  try {
    const software = await invoke<boolean>("is_software_rendering");
    document.documentElement.classList.toggle(
      "software-rendering",
      software === true,
    );
  } catch {
    // Older backend or no IPC: keep the default (animated) look.
  }
}
