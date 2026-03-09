import { Heart, MoreHorizontal } from "lucide-react";
import { useState, useRef, useCallback, useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { currentTrackAtom } from "../atoms/playback";
import { favoriteTrackIdsAtom } from "../atoms/favorites";
import { maximizedPlayerAtom } from "../atoms/ui";
import { useFavorites } from "../hooks/useFavorites";
import { getTidalImageUrl } from "../types";
import CrossfadeTidalImage from "./CrossfadeTidalImage";
import TrackContextMenu from "./TrackContextMenu";

export default function MaximizedPlayer() {
  const currentTrack = useAtomValue(currentTrackAtom);
  const setMaximized = useSetAtom(maximizedPlayerAtom);
  const favoriteTrackIds = useAtomValue(favoriteTrackIdsAtom);
  const { addFavoriteTrack, removeFavoriteTrack } = useFavorites();

  // Context menu state
  const [contextMenuTrack, setContextMenuTrack] = useState<typeof currentTrack | null>(null);
  const contextMenuAnchorRef = useRef<HTMLButtonElement>(null);

  // All hooks MUST be above the early return (Rules of Hooks).
  const isLiked = currentTrack ? favoriteTrackIds.has(currentTrack.id) : false;

  const toggleLike = useCallback(async () => {
    if (!currentTrack) return;
    try {
      if (isLiked) {
        await removeFavoriteTrack(currentTrack.id);
      } else {
        await addFavoriteTrack(currentTrack.id, currentTrack);
      }
    } catch (err) {
      console.error("Failed to toggle track favorite:", err);
    }
  }, [currentTrack, isLiked, addFavoriteTrack, removeFavoriteTrack]);

  // Reset maximized state when track goes away (queue depleted)
  useEffect(() => {
    if (!currentTrack) setMaximized(false);
  }, [currentTrack, setMaximized]);

  if (!currentTrack) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center select-none bg-black"
    >
      {/* Blurred album art background — 320px source is sufficient under 40px blur */}
      <div className="absolute inset-0 overflow-hidden">
        <CrossfadeTidalImage
          src={getTidalImageUrl(currentTrack.album?.cover, 320)}
          alt=""
          className="w-full h-full scale-110 blur-[40px]"
        />
        <div className="absolute inset-0 bg-black/60" />
      </div>

      {/* Center content */}
      <div className="relative z-10 flex flex-col items-center gap-5">
        {/* Large album art — responsive: 80vmin capped at 400px */}
        <div className="max-w-[400px] w-[80vmin] aspect-square rounded-lg overflow-hidden shadow-2xl shadow-black/60">
          <CrossfadeTidalImage
            src={getTidalImageUrl(currentTrack.album?.cover, 1280)}
            alt={currentTrack.album?.title || currentTrack.title}
            className="w-full h-full"
          />
        </div>

        {/* Track info */}
        <div className="flex flex-col items-center gap-1 max-w-[400px] w-[80vmin]">
          <span className="text-white text-[24px] font-bold truncate max-w-full">
            {currentTrack.title}
          </span>
          <span className="text-th-text-muted text-[16px] truncate max-w-full">
            {currentTrack.artist?.name || "Unknown Artist"}
          </span>
        </div>

        {/* Favorite + context menu */}
        <div className="flex items-center gap-3">
          <button
            onClick={toggleLike}
            className={`transition-[color,transform] duration-200 active:scale-90 ${
              isLiked ? "text-th-accent" : "text-th-text-faint hover:text-white"
            }`}
          >
            <Heart
              size={22}
              fill={isLiked ? "currentColor" : "none"}
              strokeWidth={isLiked ? 0 : 2}
            />
          </button>
          <button
            ref={contextMenuAnchorRef}
            onClick={() => setContextMenuTrack(currentTrack)}
            className="text-th-text-faint hover:text-white transition-colors duration-150"
          >
            <MoreHorizontal size={22} />
          </button>
        </div>
      </div>

      {/* Context menu */}
      {contextMenuTrack && (
        <TrackContextMenu
          track={contextMenuTrack}
          index={0}
          anchorRef={contextMenuAnchorRef}
          onClose={() => setContextMenuTrack(null)}
        />
      )}
    </div>
  );
}
