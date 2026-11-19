import { useCallback, useMemo } from "react";
import { useStore } from "jotai";
import {
  currentTrackAtom,
  manualQueueAtom,
  playbackSourceAtom,
  queueAtom,
} from "../../atoms/playback";
import { currentVideoAtom, videoExpandedAtom } from "../../atoms/video";
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
 * only when something actually started — never over a video. Pressing what
 * is already playing (same item, from the same list) opens it instead of
 * restarting it: Now Playing for a track, full screen for an open video.
 */
export function useTvPlayback(show: () => void) {
  const store = useStore();
  const { showToast } = useToast();
  const playSourceFn = usePlaySource();
  const playMediaFn = useMediaPlay();
  const { playTrack: playOneFn, playFromQueue } = usePlaybackActions();

  const reasonFor = useCallback(
    (track: Track) =>
      isTrackUnavailable(track)
        ? "unavailable"
        : contentBlockReason(track, readContentPrefs(store)),
    [store],
  );

  /** Whether `track` would be refused, without saying so. */
  const refuses = useCallback(
    (track: Track) => reasonFor(track) !== null,
    [reasonFor],
  );

  const refuse = useCallback(
    (track: Track) => {
      const reason = reasonFor(track);
      if (!reason) return false;
      showToast(REFUSED[reason], "info");
      return true;
    },
    [reasonFor, showToast],
  );

  /** Brings the open video with this id back full screen; false when that
   *  video is not open (it was closed, or another one plays). */
  const expandVideo = useCallback(
    (id: number) => {
      if (store.get(currentVideoAtom)?.id !== id) return false;
      store.set(videoExpandedAtom, true);
      return true;
    },
    [store],
  );

  const playSource = useCallback<TvNav["playSource"]>(
    async (src, opts) => {
      const startAt = opts?.startAt;
      if (startAt && refuse(startAt)) return false;
      if (startAt && isPlayingFrom(store, startAt, src.meta)) {
        if (startAt.itemType !== "video") {
          show();
          return true;
        }
        if (expandVideo(startAt.id)) return true;
      }
      const started = await playSourceFn(src, opts ?? {});
      if (started && store.get(currentTrackAtom)?.itemType !== "video") show();
      return started;
    },
    [store, refuse, expandVideo, playSourceFn, show],
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
      if (item.type === "video" && expandVideo(item.id)) return true;
      const started = await playMediaFn(item);
      if (started && store.get(currentTrackAtom)?.itemType !== "video") show();
      return started;
    },
    [store, expandVideo, playMediaFn, show],
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
    () => ({ playTrack, playSource, playMedia, playOne, playQueued, refuses }),
    [playTrack, playSource, playMedia, playOne, playQueued, refuses],
  );
}

/** `track` is what plays now (a video and a track can share an id), from
 *  the same list. */
function isPlayingFrom(
  store: ReturnType<typeof useStore>,
  track: Track,
  meta: { type: string; id: string | number },
) {
  const current = store.get(currentTrackAtom);
  const source = store.get(playbackSourceAtom);
  return (
    current?.id === track.id &&
    (current.itemType === "video") === (track.itemType === "video") &&
    source?.type === meta.type &&
    String(source.id) === String(meta.id)
  );
}
