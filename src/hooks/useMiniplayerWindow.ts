import { useCallback, useEffect } from "react";
import { useAtom, useAtomValue } from "jotai";
import { miniplayerOpenAtom } from "../atoms/ui";
import { currentTrackAtom } from "../atoms/playback";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";

export function useMiniplayerWindow() {
  const [miniplayerOpen, setMiniplayerOpen] = useAtom(miniplayerOpenAtom);
  const currentTrack = useAtomValue(currentTrackAtom);

  // Listen for Rust-side close event
  useEffect(() => {
    const unlisten = listen("miniplayer-closed", () => {
      setMiniplayerOpen(false);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [setMiniplayerOpen]);

  const toggleMiniplayer = useCallback(async () => {
    if (miniplayerOpen) {
      // Close existing miniplayer
      const existing = await WebviewWindow.getByLabel("miniplayer");
      if (existing) {
        await existing.close();
      }
      setMiniplayerOpen(false);
    } else {
      // Create new miniplayer window
      // In Tauri 2, relative URLs resolve against the app's origin:
      //   Dev mode: http://localhost:1420/miniplayer.html (served by Vite)
      //   Production: tauri://localhost/miniplayer.html (from dist/)
      const miniplayer = new WebviewWindow("miniplayer", {
        url: "miniplayer.html",
        title: "SONE Miniplayer",
        width: 300,
        height: 80,
        minWidth: 220,
        minHeight: 80,
        maxWidth: 400,
        maxHeight: 600,
        decorations: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: true,
      });

      // Safety net: fix any broken state restored by window-state plugin
      miniplayer.once("tauri://created", async () => {
        await miniplayer.setFullscreen(false);
        await miniplayer.unmaximize();

        // Off-screen clamping
        try {
          const { availableMonitors } = await import("@tauri-apps/api/window");
          const monitors = await availableMonitors();
          const pos = await miniplayer.outerPosition();
          const size = await miniplayer.outerSize();
          const right = pos.x + size.width;
          const bottom = pos.y + size.height;

          let onScreen = false;
          for (const mon of monitors) {
            const mx = mon.position.x;
            const my = mon.position.y;
            const mw = mon.size.width;
            const mh = mon.size.height;
            // Check if at least 50px is visible on this monitor
            if (
              pos.x < mx + mw - 50 && right > mx + 50 &&
              pos.y < my + mh - 50 && bottom > my + 50
            ) {
              onScreen = true;
              break;
            }
          }

          if (!onScreen && monitors.length > 0) {
            // Place bottom-right of primary monitor with 40px margin
            const primary = monitors[0];
            const newX = primary.position.x + primary.size.width - size.width - 40;
            const newY = primary.position.y + primary.size.height - size.height - 40;
            const { LogicalPosition } = await import("@tauri-apps/api/dpi");
            await miniplayer.setPosition(new LogicalPosition(newX, newY));
          }
        } catch {
          // Monitor detection failed — leave at OS default position
        }
      });

      miniplayer.once("tauri://error", () => {
        setMiniplayerOpen(false);
      });

      setMiniplayerOpen(true);
    }
  }, [miniplayerOpen, setMiniplayerOpen]);

  return {
    miniplayerOpen,
    toggleMiniplayer,
    canToggle: !!currentTrack,
  };
}
