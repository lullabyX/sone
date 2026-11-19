import { useEffect, useLayoutEffect, useState } from "react";
import { useAtomValue, useStore } from "jotai";
import { tvModeAtom } from "../atoms/tv";
import { useShortcuts } from "./useShortcuts";

const ZOOM_KEY = "sone.zoom.v1";
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;

/**
 * Restores the persisted UI zoom, applies it to :root, and wires the
 * zoom in/out/reset shortcuts. TV mode always renders at 1 and ignores the
 * shortcuts; the saved zoom comes back on exit.
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
  const tvMode = useAtomValue(tvModeAtom);
  const store = useStore();

  // Layout, not passive: a passive effect runs after the browser has painted,
  // so a non-default zoom would show one frame at the wrong scale on every
  // launch. The persisted value is already available at first render.
  useLayoutEffect(() => {
    const applied = String(tvMode ? 1 : zoom);
    document.documentElement.style.zoom = applied;
    document.documentElement.style.setProperty("--zoom", applied);
  }, [zoom, tvMode]);

  useEffect(() => {
    try {
      localStorage.setItem(ZOOM_KEY, String(zoom));
    } catch {}
  }, [zoom]);

  useShortcuts({
    zoomIn: () => {
      if (store.get(tvModeAtom)) return;
      setZoom((z) =>
        Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100),
      );
    },
    zoomOut: () => {
      if (store.get(tvModeAtom)) return;
      setZoom((z) =>
        Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100),
      );
    },
    zoomReset: () => {
      if (store.get(tvModeAtom)) return;
      setZoom(1.0);
    },
  });
}
