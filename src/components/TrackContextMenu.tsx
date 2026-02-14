import {
  ListEnd,
  ListPlus,
  Heart,
  Radio,
  Trash2,
  ListMusic,
} from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { useToast } from "../contexts/ToastContext";
import { usePlayback } from "../hooks/usePlayback";
import { useFavorites } from "../hooks/useFavorites";
import { useNavigation } from "../hooks/useNavigation";
import { usePlaylists } from "../hooks/usePlaylists";
import type { Track } from "../types";
import AddToPlaylistMenu from "./AddToPlaylistMenu";

interface TrackContextMenuProps {
  track: Track;
  index: number;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  /** When provided (right-click), the menu opens at the cursor position */
  cursorPosition?: { x: number; y: number };
  onClose: () => void;
  /** If set, shows "Remove from playlist" option */
  playlistId?: string;
  isUserPlaylist?: boolean;
  onTrackRemoved?: (index: number) => void;
}

export default function TrackContextMenu({
  track,
  index,
  anchorRef,
  cursorPosition,
  onClose,
  playlistId,
  isUserPlaylist,
  onTrackRemoved,
}: TrackContextMenuProps) {
  const { addToQueue, playNextInQueue } = usePlayback();
  const { favoriteTrackIds, addFavoriteTrack, removeFavoriteTrack } = useFavorites();
  const { navigateToTrackRadio } = useNavigation();
  const { removeTrackFromPlaylist } = usePlaylists();
  const { showToast } = useToast();

  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({
    top: -9999,
    left: -9999,
  });
  const [isPositioned, setIsPositioned] = useState(false);
  const [showPlaylistSubmenu, setShowPlaylistSubmenu] = useState(false);

  // Fake anchor ref for AddToPlaylistMenu positioning — we'll use the menu itself
  const playlistBtnRef = useRef<HTMLButtonElement | null>(null);

  const isFav = favoriteTrackIds.has(track.id);
  const canRemoveFromPlaylist = !!playlistId && !!isUserPlaylist;

  // Position the menu: measure actual size, clamp to viewport.
  // In Tauri's WebKit, getBoundingClientRect() returns CSS-pixel values while
  // mouse clientX/clientY are in viewport (zoomed) coordinates.  Only cursor
  // positions need zoom compensation; rect values & viewport bounds do not.
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

      let top: number;
      let left: number;

      if (cursorPosition) {
        // Right-click: clientX/Y are in viewport (zoomed) coords — convert to CSS px
        const zoom = parseFloat(document.documentElement.style.zoom || "1");
        top = cursorPosition.y / zoom;
        left = cursorPosition.x / zoom;
      } else if (anchorRef.current) {
        // Dots button: getBoundingClientRect already returns CSS px
        const rect = anchorRef.current.getBoundingClientRect();
        top = rect.bottom + 4;
        left = rect.right - menuWidth;
      } else {
        return;
      }

      // Clamp horizontally
      if (left < pad) left = pad;
      if (left + menuWidth > viewW - pad) {
        left = viewW - menuWidth - pad;
      }

      // Clamp vertically: flip upward if it would overflow
      if (top + menuHeight > viewH - pad) {
        if (cursorPosition) {
          const zoom = parseFloat(document.documentElement.style.zoom || "1");
          top = cursorPosition.y / zoom - menuHeight;
        } else if (anchorRef.current) {
          const rect = anchorRef.current.getBoundingClientRect();
          top = rect.top - menuHeight - 4;
        }
      }
      if (top < pad) top = pad;

      setPosition({ top, left });
      setIsPositioned(true);
    });

    return () => cancelAnimationFrame(raf);
  }, [anchorRef, cursorPosition, canRemoveFromPlaylist]);

  // Close on click outside
  useEffect(() => {
    if (showPlaylistSubmenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        (!anchorRef.current || !anchorRef.current.contains(e.target as Node))
      ) {
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
  }, [onClose, anchorRef, showPlaylistSubmenu]);

  const trackLabel = track.title.length > 30 ? track.title.slice(0, 28) + "…" : track.title;

  const handlePlayNext = useCallback(() => {
    playNextInQueue(track);
    showToast(`"${trackLabel}" will play next`);
    onClose();
  }, [track, trackLabel, playNextInQueue, showToast, onClose]);

  const handleAddToQueue = useCallback(() => {
    addToQueue(track);
    showToast(`Added "${trackLabel}" to queue`);
    onClose();
  }, [track, trackLabel, addToQueue, showToast, onClose]);

  const handleToggleFavorite = useCallback(async () => {
    try {
      if (isFav) {
        await removeFavoriteTrack(track.id);
        showToast(`Removed "${trackLabel}" from Loved tracks`);
      } else {
        await addFavoriteTrack(track.id);
        showToast(`Added "${trackLabel}" to Loved tracks`);
      }
    } catch (err) {
      console.error("Failed to toggle favorite:", err);
      showToast("Failed to update Loved tracks", "error");
    }
    onClose();
  }, [track.id, trackLabel, isFav, addFavoriteTrack, removeFavoriteTrack, showToast, onClose]);

  const handleGoToTrackRadio = useCallback(() => {
    navigateToTrackRadio(track.id, {
      title: track.title,
      artistName: track.artist?.name,
      cover: track.album?.cover,
    });
    onClose();
  }, [track, navigateToTrackRadio, onClose]);

  const handleRemoveFromPlaylist = useCallback(async () => {
    if (!playlistId) return;
    try {
      await removeTrackFromPlaylist(playlistId, index);
      onTrackRemoved?.(index);
      showToast(`Removed "${trackLabel}" from playlist`);
    } catch (err) {
      console.error("Failed to remove track from playlist:", err);
      showToast("Failed to remove track", "error");
    }
    onClose();
  }, [playlistId, index, trackLabel, removeTrackFromPlaylist, onTrackRemoved, showToast, onClose]);

  const menuItemClass =
    "w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.04] transition-colors text-left text-[14px] text-th-text-secondary hover:text-white";

  return (
    <>
      <div
        ref={menuRef}
        className="fixed z-9999 w-[240px] bg-th-surface rounded-xl shadow-2xl overflow-hidden flex flex-col py-1"
        style={{
          top: position.top,
          left: position.left,
          opacity: isPositioned ? 1 : 0,
          animation: isPositioned ? "fadeIn 0.12s ease-out" : undefined,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Play next */}
        <button className={menuItemClass} onClick={handlePlayNext}>
          <ListEnd size={18} className="shrink-0 text-th-text-muted" />
          <span>Play next</span>
        </button>

        {/* Add to queue */}
        <button className={menuItemClass} onClick={handleAddToQueue}>
          <ListPlus size={18} className="shrink-0 text-th-text-muted" />
          <span>Add to play queue</span>
        </button>

        {/* Divider */}
        <div className="my-1 border-t border-th-inset" />

        {/* Add to playlist */}
        <button
          ref={playlistBtnRef}
          className={menuItemClass}
          onClick={() => setShowPlaylistSubmenu(true)}
        >
          <ListMusic size={18} className="shrink-0 text-th-text-muted" />
          <span>Add to playlist</span>
        </button>

        {/* Add to / Remove from Loved tracks */}
        <button className={menuItemClass} onClick={handleToggleFavorite}>
          <Heart
            size={18}
            className={`shrink-0 ${isFav ? "text-th-accent" : "text-th-text-muted"}`}
            fill={isFav ? "currentColor" : "none"}
          />
          <span>{isFav ? "Remove from Loved tracks" : "Add to Loved tracks"}</span>
        </button>

        {/* Divider */}
        <div className="my-1 border-t border-th-inset" />

        {/* Go to track radio */}
        <button className={menuItemClass} onClick={handleGoToTrackRadio}>
          <Radio size={18} className="shrink-0 text-th-text-muted" />
          <span>Go to track radio</span>
        </button>

        {/* Remove from playlist (only for user's own playlist) */}
        {canRemoveFromPlaylist && (
          <>
            <div className="my-1 border-t border-th-inset" />
            <button
              className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.04] transition-colors text-left text-[14px] text-th-error hover:text-th-error"
              onClick={handleRemoveFromPlaylist}
            >
              <Trash2 size={18} className="shrink-0" />
              <span>Remove from playlist</span>
            </button>
          </>
        )}
      </div>

      {/* Add to playlist submenu */}
      {showPlaylistSubmenu && (
        <AddToPlaylistMenu
          trackIds={[track.id]}
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
