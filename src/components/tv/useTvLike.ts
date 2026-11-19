import { useToast } from "../../contexts/ToastContext";
import { useFavorites } from "../../hooks/useFavorites";
import type { Track } from "../../types";

/** Whether the track (or video) is in the collection, and its like toggle:
 *  Loved Tracks for a track, the collection for a video. */
export function useTvLike(track: Track) {
  const fav = useFavorites();
  const { showToast } = useToast();
  const isVideo = track.itemType === "video";
  const liked = isVideo
    ? fav.favoriteVideoIds.has(track.id)
    : fav.favoriteTrackIds.has(track.id);
  const label = isVideo
    ? liked
      ? "Remove from collection"
      : "Add to collection"
    : liked
      ? "Remove from Loved Tracks"
      : "Add to Loved Tracks";
  const toggle = () => {
    const run = isVideo
      ? liked
        ? fav.removeFavoriteVideo(track.id)
        : fav.addFavoriteVideo(track.id)
      : liked
        ? fav.removeFavoriteTrack(track.id)
        : fav.addFavoriteTrack(track.id, track);
    void Promise.resolve(run).catch(() =>
      showToast(
        isVideo
          ? "Couldn't update your collection"
          : "Couldn't update Loved Tracks",
        "error",
      ),
    );
  };
  return { liked, label, toggle };
}
