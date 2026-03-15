import { useCallback } from "react";
import { usePlaybackActions } from "./usePlaybackActions";
import { fetchMediaTracks } from "../api/tidal";
import type { MediaItemType, Track } from "../types";

function buildSource(item: MediaItemType, tracks: Track[]) {
  switch (item.type) {
    case "album":
      return {
        type: "album" as const,
        id: item.id,
        name: item.title,
        image: item.cover,
        allTracks: tracks,
      };
    case "playlist":
      return {
        type: "playlist" as const,
        id: item.uuid,
        name: item.title,
        image: item.image,
        allTracks: tracks,
      };
    case "mix":
      return {
        type: "mix" as const,
        id: item.mixId,
        name: item.title,
        image: item.image,
        subtitle: item.subtitle,
        allTracks: tracks,
      };
    default:
      return undefined;
  }
}

export function useMediaPlay() {
  const { playTrack, setQueueTracks } = usePlaybackActions();

  return useCallback(
    async (item: MediaItemType) => {
      try {
        const tracks = await fetchMediaTracks(item);
        if (tracks.length > 0) {
          const [first, ...rest] = tracks;
          const source = buildSource(item, tracks);
          setQueueTracks(rest, source ? { source } : undefined);
          await playTrack(first);
        }
      } catch (err) {
        console.error("Failed to play media:", err);
      }
    },
    [playTrack, setQueueTracks],
  );
}
