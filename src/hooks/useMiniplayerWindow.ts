import { useCallback, useEffect } from "react";
import { useAtom, useAtomValue } from "jotai";
import { miniplayerOpenAtom } from "../atoms/ui";
import { currentTrackAtom } from "../atoms/playback";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";

const STORAGE_KEY = "sone.miniplayer.geometry";

interface MiniplayerGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

function loadGeometry(): MiniplayerGeometry | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const geo = JSON.parse(raw) as MiniplayerGeometry;
    if (
      typeof geo.x === "number" &&
      typeof geo.y === "number" &&
      typeof geo.width === "number" &&
      typeof geo.height === "number"
    ) {
      return geo;
    }
  } catch { /* ignore */ }
  return null;
}

async function saveGeometry(win: WebviewWindow) {
  try {
    const pos = await win.outerPosition();
    const size = await win.outerSize();
    const geo: MiniplayerGeometry = {
      x: pos.x,
      y: pos.y,
      width: size.width,
      height: size.height,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(geo));
  } catch { /* ignore */ }
}

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
      // Save geometry before closing
      const existing = await WebviewWindow.getByLabel("miniplayer");
      if (existing) {
        await saveGeometry(existing);
        await existing.close();
      }
      setMiniplayerOpen(false);
    } else {
      const saved = loadGeometry();

      // In Tauri 2, relative URLs resolve against the app's origin:
      //   Dev mode: http://localhost:1420/miniplayer.html (served by Vite)
      //   Production: tauri://localhost/miniplayer.html (from dist/)
      const miniplayer = new WebviewWindow("miniplayer", {
        url: "miniplayer.html",
        title: "SONE Miniplayer",
        width: saved?.width ?? 300,
        height: saved?.height ?? 120,
        x: saved?.x,
        y: saved?.y,
        minWidth: 220,
        minHeight: 64,
        maxWidth: 600,
        maxHeight: 700,
        decorations: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: true,
      });

      miniplayer.once("tauri://created", async () => {
        await miniplayer.setFullscreen(false);
        await miniplayer.unmaximize();

        // Off-screen clamping (only when restoring a saved position)
        if (saved) {
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
              if (
                pos.x < mx + mw - 50 && right > mx + 50 &&
                pos.y < my + mh - 50 && bottom > my + 50
              ) {
                onScreen = true;
                break;
              }
            }

            if (!onScreen && monitors.length > 0) {
              const primary = monitors[0];
              const newX = primary.position.x + primary.size.width - size.width - 40;
              const newY = primary.position.y + primary.size.height - size.height - 100;
              const { PhysicalPosition } = await import("@tauri-apps/api/dpi");
              await miniplayer.setPosition(new PhysicalPosition(newX, newY));
            }
          } catch { /* ignore */ }
        }
      });

      miniplayer.once("tauri://error", (e) => {
        console.error("Miniplayer window creation failed:", e);
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
