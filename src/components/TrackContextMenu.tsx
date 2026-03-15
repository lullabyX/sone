import {
  ListEnd,
  ListPlus,
  Heart,
  Radio,
  Trash2,
  ListMusic,
  Link,
} from "lucide-react";
import { useState, useRef, useCallback } from "react";
import { useToast } from "../contexts/ToastContext";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useFavorites } from "../hooks/useFavorites";
import { useNavigation } from "../hooks/useNavigation";
import { usePlaylists } from "../hooks/usePlaylists";
import { useContextMenu } from "../hooks/useContextMenu";
import { getTidalImageUrl, getTrackDisplayTitle, type Track } from "../types";
import { getTrackShareUrl } from "../utils/itemHelpers";
import AddToPlaylistMenu from "./AddToPlaylistMenu";
import MenuPortal from "./MenuPortal";

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
  const { addToQueue, playNextInQueue } = usePlaybackActions();
  const { favoriteTrackIds, addFavoriteTrack, removeFavoriteTrack } =
    useFavorites();
  const { navigateToMix } = useNavigation();
  const { removeTrackFromPlaylist } = usePlaylists();
  const { showToast } = useToast();

  const [showPlaylistSubmenu, setShowPlaylistSubmenu] = useState(false);

  // Fake anchor ref for AddToPlaylistMenu positioning — we'll use the menu itself
  const playlistBtnRef = useRef<HTMLButtonElement | null>(null);

  const isFav = favoriteTrackIds.has(track.id);
  const canRemoveFromPlaylist = !!playlistId && !!isUserPlaylist;

  const { menuRef, style } = useContextMenu({
    cursorPosition,
    anchorRef,
    suppressClose: showPlaylistSubmenu,
    onClose,
  });

  const trackTitle = getTrackDisplayTitle(track) || (track as any).name || "";
  const trackLabel =
    trackTitle.length > 30 ? trackTitle.slice(0, 28) + "…" : trackTitle;

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
        await addFavoriteTrack(track.id, track);
        showToast(`Added "${trackLabel}" to Loved tracks`);
      }
    } catch (err) {
      console.error("Failed to toggle favorite:", err);
      showToast("Failed to update Loved tracks", "error");
    }
    onClose();
  }, [
    track,
    trackLabel,
    isFav,
    addFavoriteTrack,
    removeFavoriteTrack,
    showToast,
    onClose,
  ]);

  const handleGoToTrackRadio = useCallback(() => {
    const trackMixId = track.mixes?.TRACK_MIX;
    if (!trackMixId) return;
    navigateToMix(trackMixId, {
      title: `${track.title} Radio`,
      image: track.album?.cover ? getTidalImageUrl(track.album.cover, 640) : undefined,
      subtitle: `Based on ${track.artist?.name ?? ""}`,
      mixType: "TRACK_MIX",
    });
    onClose();
  }, [track, navigateToMix, onClose]);

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
  }, [
    playlistId,
    index,
    trackLabel,
    removeTrackFromPlaylist,
    onTrackRemoved,
    showToast,
    onClose,
  ]);

  const handleShare = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(getTrackShareUrl(track.id));
      showToast("Copied share link to clipboard");
    } catch {
      showToast("Failed to copy link", "error");
    }
    onClose();
  }, [track.id, showToast, onClose]);

  const menuItemClass =
    "w-full flex items-center gap-3 px-4 py-2.5 hover:bg-th-hl-faint transition-colors text-left text-[14px] text-th-text-secondary hover:text-th-text-primary";

  return (
    <MenuPortal>
      <div
        ref={menuRef}
        className="z-[9999] w-[240px] bg-th-surface rounded-xl shadow-2xl overflow-hidden flex flex-col py-1"
        style={style}
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
          <span>
            {isFav ? "Remove from Loved tracks" : "Add to Loved tracks"}
          </span>
        </button>

        {/* Go to track radio (hidden if mixes is populated but TRACK_MIX is absent) */}
        {(!track.mixes || !!track.mixes?.TRACK_MIX) && (
          <>
            <div className="my-1 border-t border-th-inset" />
            <button className={menuItemClass} onClick={handleGoToTrackRadio}>
              <Radio size={18} className="shrink-0 text-th-text-muted" />
              <span>Go to track radio</span>
            </button>
          </>
        )}

        {/* Share */}
        <div className="my-1 border-t border-th-inset" />
        <button className={menuItemClass} onClick={handleShare}>
          <Link size={18} className="shrink-0 text-th-text-muted" />
          <span>Share</span>
        </button>

        {/* Remove from playlist (only for user's own playlist) */}
        {canRemoveFromPlaylist && (
          <>
            <div className="my-1 border-t border-th-inset" />
            <button
              className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-th-hl-faint transition-colors text-left text-[14px] text-th-error hover:text-th-error"
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
    </MenuPortal>
  );
}
