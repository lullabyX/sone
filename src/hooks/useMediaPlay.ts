import { useCallback, useRef } from "react";
import { usePlaybackActions } from "./usePlaybackActions";
import { usePlaySource } from "./usePlaySource";
import { useToast } from "../contexts/ToastContext";
import { playableFromMedia } from "../lib/trackSources";
import type { MediaItemType, Track } from "../types";

const PLAY_REENTRY_GUARD_MS = 250;

export function useMediaPlay() {
  const { playSingle } = usePlaybackActions();
  const playSource = usePlaySource();
  const { showToast } = useToast();
  const lastInvokeRef = useRef(0);

  return useCallback(
    async (item: MediaItemType) => {
      // Skip duplicate fetches on rapid double-clicks of a card.
      const now = Date.now();
      if (now - lastInvokeRef.current < PLAY_REENTRY_GUARD_MS) {
        return false;
      }
      lastInvokeRef.current = now;
      // Video plays through the queue dispatch as a single-item video so
      // currentTrackAtom is set consistently with the audio path.
      if (item.type === "video") {
        const r = await playSingle({
          id: item.id,
          title: item.title,
          itemType: "video",
          imageId: item.imageId,
          duration: item.duration,
          explicit: item.explicit,
          artist: item.artist ? { id: 0, name: item.artist } : undefined,
        } as Track);
        return r.ok || r.reason !== "filtered";
      }
      try {
        const playable = await playableFromMedia(item);
        return playable ? await playSource(playable) : false;
      } catch (err) {
        console.error("Failed to play media:", err);
        showToast("Failed to play", "error");
        return false;
      }
    },
    [playSingle, playSource, showToast],
  );
}
