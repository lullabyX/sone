import {
  Play,
  ListEnd,
  ListPlus,
  ListMusic,
  Heart,
  Loader2,
  UserPlus,
  UserCheck,
  Trash2,
  FolderInput,
  Link,
} from "lucide-react";
import {
  useState,
  useRef,
  useEffect,
  useCallback,
  startTransition,
} from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useToast } from "../contexts/ToastContext";
import { type MediaItemType, type Track } from "../types";
import { fetchMediaTracks } from "../api/tidal";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useFavorites } from "../hooks/useFavorites";
import { usePlaylists } from "../hooks/usePlaylists";
import { useContextMenu } from "../hooks/useContextMenu";
import { userPlaylistsAtom } from "../atoms/playlists";
import { currentViewAtom } from "../atoms/navigation";
import { getShareUrl } from "../utils/itemHelpers";
import AddToPlaylistMenu from "./AddToPlaylistMenu";
import MoveToFolderMenu from "./MoveToFolderMenu";
import MenuPortal from "./MenuPortal";

interface MediaContextMenuProps {
  item: MediaItemType;
  cursorPosition: { x: number; y: number };
  sourceFolderId?: string;
  onClose: () => void;
}

export default function MediaContextMenu({
  item,
  cursorPosition,
  sourceFolderId,
  onClose,
}: MediaContextMenuProps) {
  const { playTrack, setQueueTracks, addToQueue, playNextInQueue } =
    usePlaybackActions();
  const {
    favoriteAlbumIds,
    addFavoriteAlbum,
    removeFavoriteAlbum,
    favoritePlaylistUuids,
    addFavoritePlaylist,
    removeFavoritePlaylist,
    followedArtistIds,
    followArtist,
    unfollowArtist,
    favoriteMixIds,
    addFavoriteMix,
    removeFavoriteMix,
  } = useFavorites();
  const { showToast } = useToast();
  const { deletePlaylist } = usePlaylists();
  const currentView = useAtomValue(currentViewAtom);
  const setCurrentView = useSetAtom(currentViewAtom);
  const userPlaylists = useAtomValue(userPlaylistsAtom);

  const [loadingAction, setLoadingAction] = useState<string | null>(null);

  // "Add to playlist" sub-menu state
  const [showPlaylistSubmenu, setShowPlaylistSubmenu] = useState(false);
  const [playlistTrackIds, setPlaylistTrackIds] = useState<number[] | null>(
    null,
  );
  const [fetchingForPlaylist, setFetchingForPlaylist] = useState(false);
  const playlistBtnRef = useRef<HTMLButtonElement | null>(null);

  // Delete playlist confirmation state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // "Move to folder" sub-menu state
  const [showMoveToFolder, setShowMoveToFolder] = useState(false);
  const moveFolderBtnRef = useRef<HTMLButtonElement | null>(null);

  // Library favorite state
  const [isFav, setIsFav] = useState<boolean | null>(null);
  const [checkingFav, setCheckingFav] = useState(false);

  // Ownership check: is this a user-created playlist?
  const isUserPlaylist =
    item.type === "playlist" && userPlaylists.some((p) => p.uuid === item.uuid);

  // Derive favorite status from atoms (no API call needed)
  useEffect(() => {
    if (item.type === "album") {
      setIsFav(favoriteAlbumIds.has(item.id));
    } else if (item.type === "playlist") {
      setIsFav(favoritePlaylistUuids.has(item.uuid));
    } else if (item.type === "artist") {
      setIsFav(followedArtistIds.has(item.id));
    } else if (item.type === "mix") {
      setIsFav(favoriteMixIds.has(item.mixId));
    } else {
      setIsFav(null);
    }
    setCheckingFav(false);
  }, [
    item,
    favoriteAlbumIds,
    favoritePlaylistUuids,
    followedArtistIds,
    favoriteMixIds,
  ]);

  const { menuRef, style } = useContextMenu({
    cursorPosition,
    suppressClose: showPlaylistSubmenu || showDeleteConfirm || showMoveToFolder,
    onClose,
  });

  /** Short display label for the media item */
  const rawLabel = item.type === "artist" ? item.name : item.title;
  const itemLabel =
    rawLabel.length > 30 ? rawLabel.slice(0, 28) + "…" : rawLabel;

  // Lightweight source tag for manual queue items
  const manualSource = (() => {
    if (item.type === "album")
      return {
        type: "album" as const,
        id: item.id,
        name: item.title,
        image: item.cover,
      };
    if (item.type === "playlist")
      return {
        type: "playlist" as const,
        id: item.uuid,
        name: item.title,
        image: item.image,
      };
    if (item.type === "mix")
      return {
        type: "mix" as const,
        id: item.mixId,
        name: item.title,
        image: item.image,
        subtitle: item.subtitle,
      };
    return undefined;
  })();

  // Helper: fetch tracks and perform an action
  const withTracks = useCallback(
    async (
      actionName: string,
      action: (tracks: Track[]) => void,
      successMsg?: string,
    ) => {
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
    [item, fetchMediaTracks, onClose, showToast],
  );

  const handlePlayNow = useCallback(() => {
    withTracks(
      "play",
      (tracks) => {
        const [first, ...rest] = tracks;
        let source:
          | {
              type: string;
              id: string | number;
              name: string;
              image?: string;
              subtitle?: string;
              allTracks: Track[];
            }
          | undefined;
        if (item.type === "album") {
          source = {
            type: "album",
            id: item.id,
            name: item.title,
            image: item.cover,
            allTracks: tracks,
          };
        } else if (item.type === "playlist") {
          source = {
            type: "playlist",
            id: item.uuid,
            name: item.title,
            image: item.image,
            allTracks: tracks,
          };
        } else if (item.type === "mix") {
          source = {
            type: "mix",
            id: item.mixId,
            name: item.title,
            image: item.image,
            subtitle: item.subtitle,
            allTracks: tracks,
          };
        }
        setQueueTracks(rest, source ? { source } : undefined);
        playTrack(first);
      },
      `Now playing "${itemLabel}"`,
    );
  }, [withTracks, playTrack, setQueueTracks, itemLabel, item]);

  const handlePlayNext = useCallback(() => {
    withTracks(
      "play next",
      (tracks) => {
        // Insert tracks at the front of the queue in reverse order
        // so the first track of the album/playlist appears first
        for (let i = tracks.length - 1; i >= 0; i--) {
          playNextInQueue(tracks[i], manualSource);
        }
      },
      `"${itemLabel}" will play next`,
    );
  }, [withTracks, playNextInQueue, itemLabel, manualSource]);

  const handleAddToQueue = useCallback(() => {
    withTracks(
      "add to queue",
      (tracks) => {
        tracks.forEach((t) => addToQueue(t, manualSource));
      },
      `Added "${itemLabel}" to queue`,
    );
  }, [withTracks, addToQueue, itemLabel, manualSource]);

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
          showToast(`Removed "${itemLabel}" from library`);
        } else {
          await addFavoriteAlbum(item.id);
          showToast(`Added "${itemLabel}" to library`);
        }
      } else if (item.type === "playlist") {
        if (isFav) {
          await removeFavoritePlaylist(item.uuid);
          showToast(`Removed "${itemLabel}" from library`);
        } else {
          await addFavoritePlaylist(item.uuid);
          showToast(`Added "${itemLabel}" to library`);
        }
      } else if (item.type === "artist") {
        if (isFav) {
          await unfollowArtist(item.id);
          showToast(`Unfollowed "${itemLabel}"`);
        } else {
          await followArtist(item.id);
          showToast(`Following "${itemLabel}"`);
        }
      } else if (item.type === "mix") {
        if (isFav) {
          await removeFavoriteMix(item.mixId);
          showToast(`Removed "${itemLabel}" from library`);
        } else {
          await addFavoriteMix(item.mixId, {
            id: item.mixId,
            title: item.title,
            subTitle: item.subtitle || "",
            images: item.image
              ? { SMALL: { url: item.image }, MEDIUM: { url: item.image } }
              : undefined,
          });
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
    item,
    isFav,
    itemLabel,
    addFavoriteAlbum,
    removeFavoriteAlbum,
    addFavoritePlaylist,
    removeFavoritePlaylist,
    followArtist,
    unfollowArtist,
    addFavoriteMix,
    removeFavoriteMix,
    onClose,
    showToast,
  ]);

  const menuItemClass =
    "w-full flex items-center gap-3 px-4 py-2.5 hover:bg-th-hl-faint transition-colors text-left text-[14px] text-th-text-secondary hover:text-th-text-primary";

  const isLoading = (action: string) => loadingAction === action;

  const handleDeletePlaylist = useCallback(async () => {
    if (item.type !== "playlist") return;
    setLoadingAction("delete");
    try {
      await deletePlaylist(item.uuid);
      showToast(`Deleted "${itemLabel}"`);
      if (
        currentView.type === "playlist" &&
        currentView.playlistId === item.uuid
      ) {
        // Replace current history entry so back button doesn't return to deleted playlist
        const homeView = { type: "home" as const };
        window.history.replaceState(homeView, "");
        startTransition(() => setCurrentView(homeView));
      }
    } catch (err) {
      console.error("Failed to delete playlist:", err);
      showToast("Failed to delete playlist", "error");
    }
    setLoadingAction(null);
    onClose();
  }, [
    item,
    deletePlaylist,
    itemLabel,
    currentView,
    setCurrentView,
    onClose,
    showToast,
  ]);

  const handleShare = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(getShareUrl(item));
      showToast("Copied share link to clipboard");
    } catch {
      showToast("Failed to copy link", "error");
    }
    onClose();
  }, [item, showToast, onClose]);

  // Whether "Add to library" / "Follow" is supported for this item type
  const canFavorite =
    item.type === "album" ||
    item.type === "playlist" ||
    item.type === "artist" ||
    item.type === "mix";

  return (
    <MenuPortal>
      <div
        ref={menuRef}
        className="z-[9999] w-[240px] bg-th-surface rounded-xl shadow-2xl overflow-hidden flex flex-col py-1"
        style={style}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
        {/* Play now */}
        <button
          className={menuItemClass}
          onClick={handlePlayNow}
          disabled={!!loadingAction}
        >
          {isLoading("play") ? (
            <Loader2
              size={18}
              className="shrink-0 text-th-text-muted animate-spin"
            />
          ) : (
            <Play size={18} className="shrink-0 text-th-text-muted" />
          )}
          <span>Play now</span>
        </button>

        {/* Play next */}
        <button
          className={menuItemClass}
          onClick={handlePlayNext}
          disabled={!!loadingAction}
        >
          {isLoading("play next") ? (
            <Loader2
              size={18}
              className="shrink-0 text-th-text-muted animate-spin"
            />
          ) : (
            <ListEnd size={18} className="shrink-0 text-th-text-muted" />
          )}
          <span>Play next</span>
        </button>

        {/* Add to queue */}
        <button
          className={menuItemClass}
          onClick={handleAddToQueue}
          disabled={!!loadingAction}
        >
          {isLoading("add to queue") ? (
            <Loader2
              size={18}
              className="shrink-0 text-th-text-muted animate-spin"
            />
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
            <Loader2
              size={18}
              className="shrink-0 text-th-text-muted animate-spin"
            />
          ) : (
            <ListMusic size={18} className="shrink-0 text-th-text-muted" />
          )}
          <span>Add to playlist</span>
        </button>

        {/* Move to folder */}
        {item.type === "playlist" && (
          <button
            ref={moveFolderBtnRef}
            className={menuItemClass}
            onClick={() => setShowMoveToFolder(true)}
          >
            <FolderInput size={18} className="shrink-0 text-th-text-muted" />
            <span>Move to folder</span>
          </button>
        )}

        {/* Add to / Remove from library / Follow artist */}
        {canFavorite && (
          <>
            <div className="my-1 border-t border-th-inset" />
            <button
              className={menuItemClass}
              onClick={handleToggleFavorite}
              disabled={!!loadingAction || checkingFav}
            >
              {isLoading("favorite") || checkingFav ? (
                <Loader2
                  size={18}
                  className="shrink-0 text-th-text-muted animate-spin"
                />
              ) : item.type === "artist" ? (
                isFav ? (
                  <UserCheck size={18} className="shrink-0 text-th-accent" />
                ) : (
                  <UserPlus size={18} className="shrink-0 text-th-text-muted" />
                )
              ) : (
                <Heart
                  size={18}
                  className={`shrink-0 ${isFav ? "text-th-accent" : "text-th-text-muted"}`}
                  fill={isFav ? "currentColor" : "none"}
                />
              )}
              <span>
                {item.type === "artist"
                  ? isFav
                    ? "Unfollow artist"
                    : "Follow artist"
                  : isFav
                    ? "Remove from my library"
                    : "Add to my library"}
              </span>
            </button>
          </>
        )}

        {/* Share */}
        <div className="my-1 border-t border-th-inset" />
        <button className={menuItemClass} onClick={handleShare}>
          <Link size={18} className="shrink-0 text-th-text-muted" />
          <span>Share</span>
        </button>

        {/* Delete playlist (only for user-created playlists) */}
        {isUserPlaylist && (
          <>
            <div className="my-1 border-t border-th-inset" />
            <button
              className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-th-hl-faint transition-colors text-left text-[14px] text-th-error hover:text-th-error"
              onClick={() => setShowDeleteConfirm(true)}
              disabled={!!loadingAction}
            >
              <Trash2 size={18} className="shrink-0" />
              <span>Delete playlist</span>
            </button>
          </>
        )}
      </div>

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <div
          className="fixed inset-0 z-[10000] bg-black/60 backdrop-blur-sm flex items-center justify-center"
          onClick={() => setShowDeleteConfirm(false)}
        >
          <div
            className="bg-th-elevated rounded-xl shadow-2xl max-w-[400px] w-[90%] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-th-text-primary mb-2">
              Delete playlist?
            </h3>
            <p className="text-sm text-th-text-secondary mb-6">
              Are you sure you want to delete "{rawLabel}"? This can't be
              undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                className="px-4 py-2 rounded-lg text-sm font-medium text-th-text-secondary hover:text-th-text-primary hover:bg-th-hl-med transition-colors"
                onClick={() => setShowDeleteConfirm(false)}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 rounded-lg text-sm font-medium bg-th-error text-white hover:brightness-110 transition-all disabled:opacity-50"
                onClick={handleDeletePlaylist}
                disabled={!!loadingAction}
              >
                {isLoading("delete") ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

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

      {/* Move to folder submenu */}
      {showMoveToFolder && item.type === "playlist" && (
        <MoveToFolderMenu
          playlistUuid={item.uuid}
          playlistTitle={item.title}
          playlistImage={item.image}
          playlistCreatorName={item.creatorName}
          anchorRef={moveFolderBtnRef}
          sourceFolderId={sourceFolderId}
          onClose={() => {
            setShowMoveToFolder(false);
            onClose();
          }}
        />
      )}
    </MenuPortal>
  );
}
