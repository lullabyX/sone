/**
 * useSonosQueueMirror — keeps the speaker's native queue tail in sync with
 * SONE's up-next list while casting (debounced one-way mirror, sibling of
 * useGaplessPrefetch's subscription shape). The speaker then self-advances
 * through the tail gaplessly, and keeps playing it even if SONE exits.
 *
 * Dedup lives on the Rust side (`plan_sync` no-ops on an unchanged tail), so
 * this hook can fire liberally — including on the "sonos-queue-reset" event
 * the backend emits after any queue rebuild (connect / play_track).
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
import { getTrackArtistDisplay } from "../utils/itemHelpers";
import type { Track } from "../types";

/** Rolling window size. As the speaker advances and the frontend queue
 *  drains, new entries slide into the window and get appended. */
const TAIL_CAP = 50;

function toTailTrack(track: Track) {
  return {
    trackId: track.id,
    qid: track._qid ?? String(track.id),
    meta: {
      title: track.title ?? "",
      artist: getTrackArtistDisplay(track),
      album: track.album?.title ?? "",
    },
  };
}

export function useSonosQueueMirror() {
  const store = useStore();
  const generationRef = useRef(0);

  const sync = useCallback(async () => {
    const generation = ++generationRef.current;
    if (store.get(playbackTargetAtom).type !== "sonos") return;
    // No current track → we haven't seeded the speaker queue; mirroring a
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
    if (generation !== generationRef.current) return;
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
