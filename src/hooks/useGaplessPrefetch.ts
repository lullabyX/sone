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
import { currentVideoAtom } from "../atoms/video";
import type { Track, StreamInfo } from "../types";

export type PendingNext = {
  trackId: number;
  qid: string;
  track: Track;
  streamInfo: StreamInfo;
};

let cachedSupported: boolean | null = null;

const FAILURE_MEMO_MS = 10_000;

export function useGaplessPrefetch(
  predictNextTrack: () => Track | null,
  pendingNextRef: React.MutableRefObject<PendingNext | null>,
) {
  const store = useStore();
  const genRef = useRef(0);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  const failedRef = useRef<{
    trackId: number;
    qid: string;
    until: number;
  } | null>(null);

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
    // gap-on-resume-near-end). A paused track's armed slot is harmless (concat can't switch its
    // active pad while paused — no EOS propagates), so leave it armed across pause/resume.
    const enabled =
      cachedSupported &&
      store.get(gaplessAtom) &&
      !store.get(exclusiveModeAtom) &&
      !store.get(bitPerfectAtom) &&
      !store.get(currentVideoAtom) && // a video is the current item → not audio-gapless
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
    // C3 pre-IPC dedup: the backend already dedups attaches by track_id, but for normal
    // in-order listening the predicted next is stable for the whole track, so every debounced
    // subscription fire would otherwise repeat the IPC + a backend URL re-resolution. Skip the
    // round-trip when the predicted next is identical to what's already registered.
    // - both trackId AND qid unchanged → already prerolled, skip entirely.
    // - trackId same, qid changed → still invoke so the backend updates its stored qid (the
    //   backend only re-stamps its qid when we actually call set_next_track).
    // - trackId changed → invoke as usual (new track to preroll).
    if (
      pendingNextRef.current &&
      pendingNextRef.current.trackId === next.id &&
      pendingNextRef.current.qid === qid
    ) {
      return;
    }
    // A track that just failed to resolve must not be retried on every queue
    // mutation — the background paginator writes queueAtom once per page, and
    // without this each page re-runs the full quality-tier cascade.
    const failed = failedRef.current;
    if (
      failed &&
      failed.trackId === next.id &&
      failed.qid === qid &&
      Date.now() < failed.until
    ) {
      return;
    }
    // Coalesce rather than drop: with shuffle on, the predicted next genuinely
    // changes mid-flight, and a dropped refresh would leave the slot armed with
    // the wrong track until some later atom write.
    if (inFlightRef.current) {
      queuedRef.current = true;
      return;
    }
    inFlightRef.current = true;
    try {
      const info = await invoke<StreamInfo>("set_next_track", {
        trackId: next.id,
        qid,
        useTrackGain: store.get(useTrackGainAtom),
      });
      if (gen !== genRef.current) return; // superseded
      failedRef.current = null;
      pendingNextRef.current = {
        trackId: next.id,
        qid,
        track: next,
        streamInfo: info,
      };
    } catch {
      if (gen !== genRef.current) return; // superseded
      failedRef.current = {
        trackId: next.id,
        qid,
        until: Date.now() + FAILURE_MEMO_MS,
      };
    } finally {
      inFlightRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        void refresh();
      }
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
      store.sub(currentTrackAtom, () => {
        failedRef.current = null;
        refreshDebounced();
      }),
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
