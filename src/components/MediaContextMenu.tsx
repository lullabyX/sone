import {
  Play,
  ListEnd,
  ListPlus,
  ListMusic,
  Heart,
  Loader2,
} from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { useToast } from "../contexts/ToastContext";
import { type MediaItemType, type Track } from "../types";
import { fetchMediaTracks } from "../api/tidal";
import { usePlayback } from "../hooks/usePlayback";
import { useFavorites } from "../hooks/useFavorites";
import { usePlaylists } from "../hooks/usePlaylists";
import AddToPlaylistMenu from "./AddToPlaylistMenu";

interface MediaContextMenuProps {
  item: MediaItemType;
  cursorPosition: { x: number; y: number };
  onClose: () => void;
}

export default function MediaContextMenu({
  item,
  cursorPosition,
  onClose,
}: MediaContextMenuProps) {
  const {
    playTrack,
    setQueueTracks,
    addToQueue,
    playNextInQueue,
  } = usePlayback();
  const {
    addFavoriteAlbum,
    removeFavoriteAlbum,
    isAlbumFavorited,
    addFavoritePlaylist,
    removeFavoritePlaylist,
  } = useFavorites();
  const { favoritePlaylists } = usePlaylists();
  const { showToast } = useToast();

  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: -9999,
    left: -9999,
  });
  const [isPositioned, setIsPositioned] = useState(false);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);

  // "Add to playlist" sub-menu state
  const [showPlaylistSubmenu, setShowPlaylistSubmenu] = useState(false);
  const [playlistTrackIds, setPlaylistTrackIds] = useState<number[] | null>(null);
  const [fetchingForPlaylist, setFetchingForPlaylist] = useState(false);
  const playlistBtnRef = useRef<HTMLButtonElement | null>(null);

  // Library favorite state
  const [isFav, setIsFav] = useState<boolean | null>(null);
  const [checkingFav, setCheckingFav] = useState(false);

  // Check favorite status on mount
  useEffect(() => {
    let cancelled = false;
    const checkFav = async () => {
      setCheckingFav(true);
      try {
        if (item.type === "album") {
          const result = await isAlbumFavorited(item.id);
          if (!cancelled) setIsFav(result);
        } else if (item.type === "playlist") {
          // Check if this playlist is in the user's favorite playlists
          const result = favoritePlaylists.some((p) => p.uuid === item.uuid);
          if (!cancelled) setIsFav(result);
        } else {
          // Mixes don't have a favorite API
          if (!cancelled) setIsFav(null);
        }
      } catch {
        if (!cancelled) setIsFav(null);
      }
      if (!cancelled) setCheckingFav(false);
    };
    checkFav();
    return () => { cancelled = true; };
  }, [item, isAlbumFavorited, favoritePlaylists]);

  // Position the menu at cursor, clamped to viewport
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const menu = menuRef.current;
      if (!menu) return;

      const menuRect = menu.getBoundingClientRect();
      const menuWidth = menuRect.width || 240;
      const menuHeight = menuRect.height || 300;
      const viewW = window.innerWidth;
      const viewH = window.innerHeight;
      const pad = 8;

      const zoom = parseFloat(document.documentElement.style.zoom || "1");
      let top = cursorPosition.y / zoom;
      let left = cursorPosition.x / zoom;

      // Clamp horizontally
      if (left < pad) left = pad;
      if (left + menuWidth > viewW - pad) {
        left = viewW - menuWidth - pad;
      }

      // Clamp vertically
      if (top + menuHeight > viewH - pad) {
        top = cursorPosition.y / zoom - menuHeight;
      }
      if (top < pad) top = pad;

      setPosition({ top, left });
      setIsPositioned(true);
    });

    return () => cancelAnimationFrame(raf);
  }, [cursorPosition]);

  // Close on click outside
  useEffect(() => {
    if (showPlaylistSubmenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose, showPlaylistSubmenu]);

  /** Short display label for the media item */
  const itemLabel = item.title.length > 30 ? item.title.slice(0, 28) + "…" : item.title;

  // Helper: fetch tracks and perform an action
  const withTracks = useCallback(
    async (actionName: string, action: (tracks: Track[]) => void, successMsg?: string) => {
      setLoadingAction(actionName);
      try {
        const tracks = await fetchMediaTracks(item);
        if (tracks.length > 0) {
          action(tracks);
          if (successMsg) showToast(successMsg);
        }
      } catch (err) {
        console.error(`Failed to ${actionName}:`, err);
        showToast(`Failed to ${actionName}`, "error");
      }
      onClose();
    },
    [item, fetchMediaTracks, onClose, showToast]
  );

  const handlePlayNow = useCallback(() => {
    withTracks("play", (tracks) => {
      const [first, ...rest] = tracks;
      setQueueTracks(rest);
      playTrack(first);
    }, `Now playing "${itemLabel}"`);
  }, [withTracks, playTrack, setQueueTracks, itemLabel]);

  const handlePlayNext = useCallback(() => {
    withTracks("play next", (tracks) => {
      // Insert tracks at the front of the queue in reverse order
      // so the first track of the album/playlist appears first
      for (let i = tracks.length - 1; i >= 0; i--) {
        playNextInQueue(tracks[i]);
      }
    }, `"${itemLabel}" will play next`);
  }, [withTracks, playNextInQueue, itemLabel]);

  const handleAddToQueue = useCallback(() => {
    withTracks("add to queue", (tracks) => {
      tracks.forEach((t) => addToQueue(t));
    }, `Added "${itemLabel}" to queue`);
  }, [withTracks, addToQueue, itemLabel]);

  const handleAddToPlaylist = useCallback(async () => {
    if (playlistTrackIds) {
      // Already fetched
      setShowPlaylistSubmenu(true);
      return;
    }
    setFetchingForPlaylist(true);
    try {
      const tracks = await fetchMediaTracks(item);
      const ids = tracks.map((t) => t.id);
      setPlaylistTrackIds(ids);
      setShowPlaylistSubmenu(true);
    } catch (err) {
      console.error("Failed to fetch tracks for playlist:", err);
    }
    setFetchingForPlaylist(false);
  }, [item, fetchMediaTracks, playlistTrackIds]);

  const handleToggleFavorite = useCallback(async () => {
    setLoadingAction("favorite");
    try {
      if (item.type === "album") {
        if (isFav) {
          await removeFavoriteAlbum(item.id);
          setIsFav(false);
          showToast(`Removed "${itemLabel}" from library`);
        } else {
          await addFavoriteAlbum(item.id);
          setIsFav(true);
          showToast(`Added "${itemLabel}" to library`);
        }
      } else if (item.type === "playlist") {
        if (isFav) {
          await removeFavoritePlaylist(item.uuid);
          setIsFav(false);
          showToast(`Removed "${itemLabel}" from library`);
        } else {
          await addFavoritePlaylist(item.uuid);
          setIsFav(true);
          showToast(`Added "${itemLabel}" to library`);
        }
      }
    } catch (err) {
      console.error("Failed to toggle favorite:", err);
      showToast("Failed to update library", "error");
    }
    setLoadingAction(null);
    onClose();
  }, [
    item, isFav, itemLabel,
    addFavoriteAlbum, removeFavoriteAlbum,
    addFavoritePlaylist, removeFavoritePlaylist,
    onClose, showToast,
  ]);

  const menuItemClass =
    "w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.04] transition-colors text-left text-[14px] text-th-text-secondary hover:text-white";

  const isLoading = (action: string) => loadingAction === action;

  // Whether "Add to library" is supported for this item type
  const canFavorite = item.type === "album" || item.type === "playlist";

  return (
    <>
      <div
        ref={menuRef}
        className="fixed z-[9999] w-[240px] bg-th-surface rounded-xl shadow-2xl overflow-hidden flex flex-col py-1"
        style={{
          top: position.top,
          left: position.left,
          opacity: isPositioned ? 1 : 0,
          animation: isPositioned ? "fadeIn 0.12s ease-out" : undefined,
        }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
        {/* Play now */}
        <button className={menuItemClass} onClick={handlePlayNow} disabled={!!loadingAction}>
          {isLoading("play") ? (
            <Loader2 size={18} className="shrink-0 text-th-text-muted animate-spin" />
          ) : (
            <Play size={18} className="shrink-0 text-th-text-muted" />
          )}
          <span>Play now</span>
        </button>

        {/* Play next */}
        <button className={menuItemClass} onClick={handlePlayNext} disabled={!!loadingAction}>
          {isLoading("play next") ? (
            <Loader2 size={18} className="shrink-0 text-th-text-muted animate-spin" />
          ) : (
            <ListEnd size={18} className="shrink-0 text-th-text-muted" />
          )}
          <span>Play next</span>
        </button>

        {/* Add to queue */}
        <button className={menuItemClass} onClick={handleAddToQueue} disabled={!!loadingAction}>
          {isLoading("add to queue") ? (
            <Loader2 size={18} className="shrink-0 text-th-text-muted animate-spin" />
          ) : (
            <ListPlus size={18} className="shrink-0 text-th-text-muted" />
          )}
          <span>Add to play queue</span>
        </button>

        {/* Divider */}
        <div className="my-1 border-t border-th-inset" />

        {/* Add to playlist */}
        <button
          ref={playlistBtnRef}
          className={menuItemClass}
          onClick={handleAddToPlaylist}
          disabled={fetchingForPlaylist}
        >
          {fetchingForPlaylist ? (
            <Loader2 size={18} className="shrink-0 text-th-text-muted animate-spin" />
          ) : (
            <ListMusic size={18} className="shrink-0 text-th-text-muted" />
          )}
          <span>Add to playlist</span>
        </button>

        {/* Add to / Remove from library (albums & playlists only) */}
        {canFavorite && (
          <>
            <div className="my-1 border-t border-th-inset" />
            <button
              className={menuItemClass}
              onClick={handleToggleFavorite}
              disabled={!!loadingAction || checkingFav}
            >
              {isLoading("favorite") || checkingFav ? (
                <Loader2 size={18} className="shrink-0 text-th-text-muted animate-spin" />
              ) : (
                <Heart
                  size={18}
                  className={`shrink-0 ${isFav ? "text-th-accent" : "text-th-text-muted"}`}
                  fill={isFav ? "currentColor" : "none"}
                />
              )}
              <span>{isFav ? "Remove from my library" : "Add to my library"}</span>
            </button>
          </>
        )}
      </div>

      {/* Add to playlist submenu */}
      {showPlaylistSubmenu && playlistTrackIds && (
        <AddToPlaylistMenu
          trackIds={playlistTrackIds}
          anchorRef={playlistBtnRef}
          onClose={() => {
            setShowPlaylistSubmenu(false);
            onClose();
          }}
        />
      )}
    </>
  );
}
