import { useCallback } from "react";
import { useStore } from "jotai";
import {
  allowExplicitAtom,
  queueEpochAtom,
  shuffleAtom,
} from "../atoms/playback";
import { useToast } from "../contexts/ToastContext";
import { isTrackUnavailable } from "../lib/trackAvailability";
import { usePlaybackActions } from "./usePlaybackActions";
import type { PlayableSource } from "../lib/trackSources";
import type { Track } from "../types";

const START_BATCH = 50;
const MAX_PAGES = 200;

interface PlaySourceOptions {
  shuffle?: boolean;
  startAt?: Track;
}

// Module-level so a press on any screen supersedes a pending one elsewhere.
let latestRequest = 0;

export function usePlaySource() {
  const store = useStore();
  const { playFromSource, playAllFromSource, appendToQueue } =
    usePlaybackActions();
  const { showToast } = useToast();

  return useCallback(
    async (src: PlayableSource, opts: PlaySourceOptions = {}) => {
      const request = ++latestRequest;
      const epochAtRequest = store.get(queueEpochAtom);
      const shuffleModeAtStart = store.get(shuffleAtom);
      const { meta } = src;

      const isPlayable = (t: Track) =>
        !isTrackUnavailable(t) && (store.get(allowExplicitAtom) || !t.explicit);

      const seen = new Set<number>();
      const tracks: Track[] = [];
      let playableCount = 0;
      const take = (items: Track[]) => {
        const fresh: Track[] = [];
        let newIds = 0;
        for (const t of items) {
          if (src.dedupe) {
            if (seen.has(t.id)) continue;
            seen.add(t.id);
            newIds++;
          }
          if (src.include && !src.include(t)) continue;
          fresh.push(t);
          if (isPlayable(t)) playableCount++;
        }
        tracks.push(...fresh);
        return { fresh, newIds };
      };
      take(src.loaded);

      let offset = src.nextOffset ?? src.loaded.length;
      let hasMore = !!src.fetchPage && (src.hasMore ?? true);
      let pages = 0;
      const fetchNext = async () => {
        const page = await src.fetchPage!(offset);
        pages++;
        offset += page.items.length;
        const { fresh, newIds } = take(page.items);
        hasMore =
          page.hasMore &&
          page.items.length > 0 &&
          pages < MAX_PAGES &&
          (!src.dedupe || newIds > 0);
        return fresh;
      };

      const startAt = opts.startAt;
      const startNow = !!startAt && tracks.some((t) => t.id === startAt.id);
      let failed = false;
      try {
        while (!startNow && hasMore && playableCount < START_BATCH) {
          await fetchNext();
          if (
            request !== latestRequest ||
            store.get(queueEpochAtom) !== epochAtRequest
          ) {
            return false;
          }
        }
      } catch (err) {
        console.error(`Failed to load ${meta.type} tracks:`, err);
        hasMore = false;
        failed = true;
      }

      if (
        request !== latestRequest ||
        store.get(queueEpochAtom) !== epochAtRequest
      ) {
        return false;
      }
      if (tracks.length === 0) {
        if (failed) showToast("Couldn't load tracks", "error");
        return false;
      }

      const source = { ...meta, allTracks: tracks };
      let started = true;
      try {
        if (startAt) {
          const idx = tracks.findIndex((t) => t.id === startAt.id);
          // More pages are coming: don't wrap to the tracks before the click.
          const noWrap = hasMore && idx > 0 && !store.get(shuffleAtom);
          await playFromSource(startAt, noWrap ? tracks.slice(idx) : tracks, {
            source,
            albumMode: src.albumMode,
          });
        } else {
          started = await playAllFromSource(tracks, {
            source,
            albumMode: src.albumMode,
            shuffle: opts.shuffle,
          });
        }
      } catch (err) {
        console.error(`Failed to play ${meta.type}:`, err);
        return false;
      }
      if (!started) {
        showToast("No playable tracks", "info");
        return false;
      }

      // playFromSource / playAllFromSource replace the queue exactly once.
      const ourEpoch = epochAtRequest + 1;
      const stillOurs = () => store.get(queueEpochAtom) === ourEpoch;
      const shuffleAppend = !!opts.shuffle && !shuffleModeAtStart;

      if (hasMore) {
        void (async () => {
          try {
            while (hasMore && stillOurs()) {
              const fresh = await fetchNext();
              if (!stillOurs()) return;
              const playable = fresh.filter((t) => !isTrackUnavailable(t));
              if (playable.length > 0) {
                appendToQueue(playable, {
                  shuffle: shuffleAppend,
                  source: { type: meta.type, id: meta.id },
                });
              }
            }
          } catch (err) {
            console.error(`Failed to load remaining ${meta.type} tracks:`, err);
          }
        })();
      }
      return true;
    },
    [store, playFromSource, playAllFromSource, appendToQueue, showToast],
  );
}
