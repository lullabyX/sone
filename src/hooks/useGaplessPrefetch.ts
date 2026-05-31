import { useCallback, useEffect, useRef } from "react";
import { useStore } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import {
  manualQueueAtom,
  queueAtom,
  currentTrackAtom,
  repeatAtom,
  shuffleAtom,
  autoplayAtom,
  exclusiveModeAtom,
  bitPerfectAtom,
  gaplessAtom,
  useTrackGainAtom,
} from "../atoms/playback";
import type { Track, StreamInfo } from "../types";

export type PendingNext = {
  trackId: number;
  qid: string;
  track: Track;
  streamInfo: StreamInfo;
};

let cachedSupported: boolean | null = null;

export function useGaplessPrefetch(
  predictNextTrack: () => Track | null,
  pendingNextRef: React.MutableRefObject<PendingNext | null>,
) {
  const store = useStore();
  const genRef = useRef(0);

  const clearSlot = useCallback(async () => {
    pendingNextRef.current = null;
    await invoke("clear_next_track").catch(() => {});
  }, [pendingNextRef]);

  const refresh = useCallback(async () => {
    const gen = ++genRef.current;
    if (cachedSupported === null) {
      cachedSupported = await invoke<boolean>("get_gapless_supported").catch(
        () => false,
      );
    }
    // Gate on currentTrack presence only — NOT isPlayingAtom. isPlaying flickers false during
    // device-busy retries and on every pause; gating on it would churn the slot (network round-trips,
    // gap-on-resume-near-end). A paused track's armed slot is harmless (about-to-finish can't fire
    // while paused), so leave it armed across pause/resume.
    const enabled =
      cachedSupported &&
      store.get(gaplessAtom) &&
      !store.get(exclusiveModeAtom) &&
      !store.get(bitPerfectAtom) &&
      !!store.get(currentTrackAtom);
    if (!enabled) {
      await clearSlot();
      return;
    }
    const next = predictNextTrack();
    if (!next) {
      await clearSlot();
      return;
    }
    const qid = next._qid ?? String(next.id);
    try {
      const info = await invoke<StreamInfo>("set_next_track", {
        trackId: next.id,
        qid,
        useTrackGain: store.get(useTrackGainAtom),
      });
      if (gen !== genRef.current) return; // superseded
      pendingNextRef.current = {
        trackId: next.id,
        qid,
        track: next,
        streamInfo: info,
      };
    } catch {
      /* best-effort */
    }
  }, [store, predictNextTrack, clearSlot, pendingNextRef]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshDebounced = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void refresh(), 250);
  }, [refresh]);

  // Mode/kill-switch changes refresh IMMEDIATELY (no debounce window for a stale arm).
  // `refresh()` already calls clearSlot() internally when !enabled, so a separate clearSlot()
  // here would only create a clear/set channel-reorder race — call refresh() alone.
  const refreshImmediate = useCallback(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const subs = [
      store.sub(manualQueueAtom, refreshDebounced),
      store.sub(queueAtom, refreshDebounced),
      store.sub(currentTrackAtom, refreshDebounced),
      store.sub(repeatAtom, refreshDebounced),
      store.sub(shuffleAtom, refreshDebounced),
      store.sub(autoplayAtom, refreshDebounced),
      store.sub(exclusiveModeAtom, refreshImmediate),
      store.sub(bitPerfectAtom, refreshImmediate),
      store.sub(gaplessAtom, refreshImmediate),
    ];
    void refresh();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      subs.forEach((u) => u());
    };
  }, [store, refresh, refreshDebounced, refreshImmediate]);
}
