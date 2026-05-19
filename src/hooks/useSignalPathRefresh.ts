import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { signalPathAtom, type SignalPath } from "../atoms/playback";

const HEARTBEAT_MS = 2000;

/**
 * Drives signal-path refreshes while a consumer (the modal) is open.
 * - Immediate refresh on mount when `enabled` flips true
 * - 2s heartbeat for OS-mixer / hw_params drift the backend can't push
 * - Cleared on unmount or when `enabled` flips false
 *
 * Backend-pushed `signal-path-changed` events are handled separately by
 * AppInitializer (always-on listener). This hook only adds the pull
 * channel for ground-truth that has no event source.
 */
export function useSignalPathRefresh(enabled: boolean) {
  const setSp = useSetAtom(signalPathAtom);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const refresh = () =>
      invoke<SignalPath>("refresh_signal_path")
        .then((sp) => {
          if (!cancelled) setSp(sp);
        })
        .catch(() => {});
    refresh();
    const id = setInterval(refresh, HEARTBEAT_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, setSp]);
}
