import { useEffect, useLayoutEffect, useState } from "react";
import { useShortcuts } from "./useShortcuts";

const ZOOM_KEY = "sone.zoom.v1";
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;

/**
 * Restores the persisted UI zoom, applies it to :root, and wires the
 * zoom in/out/reset shortcuts.
 *
 * Call once near the top of the component tree (e.g. in App).
 */
export function useZoom() {
  const [zoom, setZoom] = useState(() => {
    try {
      const saved = localStorage.getItem(ZOOM_KEY);
      if (saved) {
        const val = Number(saved);
        if (!Number.isNaN(val) && val >= ZOOM_MIN && val <= ZOOM_MAX)
          return val;
      }
    } catch {}
    return 1.0;
  });

  // Layout, not passive: a passive effect runs after the browser has painted,
  // so a non-default zoom would show one frame at the wrong scale on every
  // launch. The persisted value is already available at first render.
  useLayoutEffect(() => {
    document.documentElement.style.zoom = String(zoom);
    document.documentElement.style.setProperty("--zoom", String(zoom));
  }, [zoom]);

  useEffect(() => {
    try {
      localStorage.setItem(ZOOM_KEY, String(zoom));
    } catch {}
  }, [zoom]);

  useShortcuts({
    zoomIn: () =>
      setZoom((z) =>
        Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100),
      ),
    zoomOut: () =>
      setZoom((z) =>
        Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100),
      ),
    zoomReset: () => setZoom(1.0),
  });
}
