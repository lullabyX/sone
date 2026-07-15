/**
 * useSonosQueueMirror — debounced one-way mirror of SONE's up-next list onto
 * the speaker's native queue, enabling gapless self-advance that survives
 * SONE exiting. Fires liberally (including on "sonos-queue-reset" after any
 * backend queue rebuild); the Rust side no-ops when the tail is unchanged.
 */

import { useCallback, useEffect, useRef } from "react";
import { useStore } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  currentTrackAtom,
  manualQueueAtom,
  playbackTargetAtom,
  queueAtom,
  repeatAtom,
} from "../atoms/playback";
import { isTrackUnavailable } from "../lib/trackAvailability";
import { buildSonosMeta } from "../lib/sonosMeta";
import type { Track } from "../types";

/** Rolling window size. As the speaker advances and the frontend queue
 *  drains, new entries slide into the window and get appended. */
const TAIL_CAP = 50;

function toTailTrack(track: Track) {
  return {
    trackId: track.id,
    qid: track._qid ?? String(track.id),
    meta: buildSonosMeta(track),
  };
}

export function useSonosQueueMirror() {
  const store = useStore();

  const sync = useCallback(async () => {
    if (store.get(playbackTargetAtom).type !== "sonos") return;
    // No current track → the speaker queue isn't seeded; mirroring a
    // tail now would append onto whatever stale queue the speaker holds.
    if (!store.get(currentTrackAtom)) return;
    // Repeat-one: the speaker must never self-advance — SONE replays the
    // current track at EOS via the track-finished → playNext path.
    const tail =
      store.get(repeatAtom) === 2
        ? []
        : [...store.get(manualQueueAtom), ...store.get(queueAtom)]
            .filter((t) => !isTrackUnavailable(t))
            .slice(0, TAIL_CAP);
    try {
      await invoke("sonos_sync_queue_tail", {
        tracks: tail.map(toTailTrack),
      });
    } catch (error) {
      console.error("Sonos queue mirror sync failed:", error);
    }
  }, [store]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncDebounced = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void sync(), 500);
  }, [sync]);
  const syncImmediate = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    void sync();
  }, [sync]);

  useEffect(() => {
    const subs = [
      store.sub(manualQueueAtom, syncDebounced),
      store.sub(queueAtom, syncDebounced),
      store.sub(repeatAtom, syncDebounced),
      store.sub(currentTrackAtom, syncDebounced),
      store.sub(playbackTargetAtom, syncImmediate),
    ];
    const unlistenReset = listen("sonos-queue-reset", syncImmediate);
    void sync();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      subs.forEach((u) => u());
      unlistenReset.then((fn) => fn());
    };
  }, [store, sync, syncDebounced, syncImmediate]);
}
