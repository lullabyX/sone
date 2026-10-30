import { useCallback, useMemo } from "react";
import { useStore } from "jotai";
import {
  currentTrackAtom,
  manualQueueAtom,
  queueAtom,
} from "../../atoms/playback";
import { useToast } from "../../contexts/ToastContext";
import { useMediaPlay } from "../../hooks/useMediaPlay";
import { usePlaySource } from "../../hooks/usePlaySource";
import { usePlaybackActions } from "../../hooks/usePlaybackActions";
import { contentBlockReason, readContentPrefs } from "../../lib/contentFilter";
import { isTrackUnavailable } from "../../lib/trackAvailability";
import type { MediaItemType, Track } from "../../types";
import type { TvNav } from "./TvNavContext";

const REFUSED = {
  explicit: "Explicit content is off — turn it on in Settings › Content",
  ai: "AI-generated content is off — turn it on in Settings › Content",
  unavailable: "This track isn't available",
};

/**
 * The only way TV starts playback. A track that cannot play is refused here
 * with a message saying why (and where to change it), and Now Playing opens
 * only when something actually started — never over a video.
 */
export function useTvPlayback(show: () => void) {
  const store = useStore();
  const { showToast } = useToast();
  const playSourceFn = usePlaySource();
  const playMediaFn = useMediaPlay();
  const { playTrack: playOneFn, playFromQueue } = usePlaybackActions();

  const refuse = useCallback(
    (track: Track) => {
      const reason = isTrackUnavailable(track)
        ? "unavailable"
        : contentBlockReason(track, readContentPrefs(store));
      if (!reason) return false;
      showToast(REFUSED[reason], "info");
      return true;
    },
    [store, showToast],
  );

  const playSource = useCallback<TvNav["playSource"]>(
    async (src, opts) => {
      const startAt = opts?.startAt;
      if (startAt && refuse(startAt)) return false;
      if (startAt && store.get(currentTrackAtom)?.id === startAt.id) {
        show();
        return true;
      }
      const started = await playSourceFn(src, opts ?? {});
      if (started && store.get(currentTrackAtom)?.itemType !== "video") show();
      return started;
    },
    [store, refuse, playSourceFn, show],
  );

  const playTrack = useCallback<TvNav["playTrack"]>(
    (track, tracks, options) => {
      const s = options?.source;
      const meta = s
        ? { type: s.type, id: s.id, name: s.name, image: s.image }
        : { type: "tv-row", id: track.id, name: track.title };
      return playSource(
        {
          meta,
          loaded: tracks.length ? tracks : [track],
          albumMode: options?.albumMode,
        },
        { startAt: track },
      );
    },
    [playSource],
  );

  const playMedia = useCallback(
    async (item: MediaItemType) => {
      const started = await playMediaFn(item);
      if (started && item.type !== "video") show();
      return started;
    },
    [playMediaFn, show],
  );

  const playOne = useCallback(
    async (track: Track) => {
      if (refuse(track)) return false;
      return (await playOneFn(track)).ok;
    },
    [refuse, playOneFn],
  );

  const playQueued = useCallback(
    async (index: number) => {
      if (index < 0) return false;
      const track = [...store.get(manualQueueAtom), ...store.get(queueAtom)][
        index
      ];
      if (!track || refuse(track)) return false;
      await playFromQueue(index);
      return true;
    },
    [store, refuse, playFromQueue],
  );

  return useMemo(
    () => ({ playTrack, playSource, playMedia, playOne, playQueued }),
    [playTrack, playSource, playMedia, playOne, playQueued],
  );
}
