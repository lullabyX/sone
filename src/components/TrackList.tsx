import { Play, Heart, MoreHorizontal, Plus, ListPlus, ChevronUp, ChevronDown } from "lucide-react";
import { type Track, getTidalImageUrl, getTrackDisplayTitle } from "../types";
import ExplicitBadge from "./ExplicitBadge";
import TidalImage from "./TidalImage";
import AddToPlaylistMenu from "./AddToPlaylistMenu";
import TrackContextMenu from "./TrackContextMenu";
import { useRef, useEffect, useState, memo, useMemo } from "react";
import { useAtomValue, atom } from "jotai";
import { currentTrackAtom, isPlayingAtom, allowExplicitAtom } from "../atoms/playback";
import { favoriteTrackIdsAtom } from "../atoms/favorites";
import { useNavigation } from "../hooks/useNavigation";
import { useFavorites } from "../hooks/useFavorites";
import { TrackArtists } from "./TrackArtists";

interface TrackListProps {
  tracks: Track[];
  onPlay: (track: Track, index: number) => void;
  showDateAdded?: boolean;
  showAlbum?: boolean;
  showCover?: boolean;
  showArtist?: boolean;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  context?: "album" | "playlist" | "favorites" | "search";
  /** Optional per-row display numbers (e.g. original playlist position when filtering) */
  trackDisplayNumbers?: number[];
  /** For "Remove from playlist" support */
  playlistId?: string;
  isUserPlaylist?: boolean;
  onTrackRemoved?: (index: number) => void;
  /** When provided, shows a dedicated "add to this playlist" button (immediate action, no menu) */
  onAddToCurrentPlaylist?: (track: Track) => void;
  sortable?: boolean;
  sortColumn?: string | null;
  sortDirection?: "ASC" | "DESC" | null;
  onSort?: (column: string | null, direction: "ASC" | "DESC" | null) => void;
  sortLoading?: boolean;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatDate(dateString?: string): string {
  if (!dateString) return "";
  const date = new Date(dateString);
  const now = new Date();
  const diffTime = Math.abs(now.getTime() - date.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays <= 7) return "This week";
  if (diffDays <= 14) return "Last week";
  if (diffDays <= 30) return "Last month";

  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ─── Memoized TrackRow ─────────────────────────────────────────────────────

interface TrackRowProps {
  track: Track;
  index: number;
  displayNumber?: number;
  gridCols: string;
  showCover: boolean;
  showArtist: boolean;
  showAlbum: boolean;
  showDateAdded: boolean;
  context: string;
  onPlay: (track: Track, index: number) => void;
  playlistId?: string;
  isUserPlaylist?: boolean;
  onTrackRemoved?: (index: number) => void;
  onAddToCurrentPlaylist?: (track: Track) => void;
}

const TrackRow = memo(function TrackRow({
  track,
  index,
  displayNumber,
  gridCols,
  showCover,
  showArtist,
  showAlbum,
  showDateAdded,
  context,
  onPlay,
  playlistId,
  isUserPlaylist,
  onTrackRemoved,
  onAddToCurrentPlaylist,
}: TrackRowProps) {
  const favoriteTrackIds = useAtomValue(favoriteTrackIdsAtom);
  const { navigateToAlbum } = useNavigation();
  const { addFavoriteTrack, removeFavoriteTrack } = useFavorites();

  const [playlistMenuOpen, setPlaylistMenuOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [contextMenuCursorPos, setContextMenuCursorPos] = useState<
    { x: number; y: number } | undefined
  >(undefined);
  const plusButtonRef = useRef<HTMLButtonElement>(null);
  const dotsButtonRef = useRef<HTMLButtonElement>(null);

  const allowExplicit = useAtomValue(allowExplicitAtom);
  const isBlocked = !allowExplicit && !!track.explicit;

  const isActiveAtom = useMemo(
    () => atom((get) => (get(currentTrackAtom)?.id ?? null) === track.id),
    [track.id],
  );
  const isActive = useAtomValue(isActiveAtom);

  const isPlayingHereAtom = useMemo(
    () => atom((get) => (get(currentTrackAtom)?.id ?? null) === track.id && get(isPlayingAtom)),
    [track.id],
  );
  const playing = useAtomValue(isPlayingHereAtom);

  const isFav = favoriteTrackIds.has(track.id);

  const toggleFavorite = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (isFav) {
        await removeFavoriteTrack(track.id);
      } else {
        await addFavoriteTrack(track.id, track);
      }
    } catch (err) {
      console.error("Failed to toggle favorite", err);
    }
  };

  const handlePlusClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setContextMenuOpen(false);
    setPlaylistMenuOpen((prev) => !prev);
  };

  const handleDotsClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPlaylistMenuOpen(false);
    setContextMenuCursorPos(undefined);
    setContextMenuOpen((prev) => !prev);
  };

  const handleRowContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPlaylistMenuOpen(false);
    setContextMenuCursorPos({ x: e.clientX, y: e.clientY });
    setContextMenuOpen(true);
  };

  return (
    <div
      onClick={() => !isBlocked && onPlay(track, index)}
      onContextMenu={isBlocked ? undefined : handleRowContextMenu}
      className={`grid gap-4 px-4 py-2.5 rounded-md transition-colors items-center ${
        isBlocked
          ? "opacity-40 cursor-default"
          : `cursor-pointer group ${isActive ? "bg-th-hl-faint" : "hover:bg-th-hl-faint"}`
      }`}
      style={{ gridTemplateColumns: gridCols }}
    >
      {/* Track Number / Playing Indicator */}
      <div className="flex items-center justify-end">
        {playing ? (
          <div className="flex items-end gap-[3px] h-4">
            <span className="w-[3px] h-full bg-th-accent rounded-full playing-bar" />
            <span
              className="w-[3px] h-full bg-th-accent rounded-full playing-bar"
              style={{ animationDelay: "0.2s" }}
            />
            <span
              className="w-[3px] h-full bg-th-accent rounded-full playing-bar"
              style={{ animationDelay: "0.4s" }}
            />
          </div>
        ) : (
          <>
            <span
              className={`text-[15px] tabular-nums group-hover:hidden ${
                isActive ? "text-th-accent" : "text-th-text-muted"
              }`}
            >
              {displayNumber != null
                ? displayNumber
                : context === "album"
                  ? (track.trackNumber ?? index + 1)
                  : index + 1}
            </span>
            <Play
              size={14}
              fill="currentColor"
              className="text-th-text-primary hidden group-hover:block"
            />
          </>
        )}
      </div>

      {/* Title + Thumbnail */}
      <div className="flex items-center gap-3 min-w-0">
        {showCover && (
          <div className="relative w-10 h-10 shrink-0 rounded bg-th-surface-hover overflow-hidden">
            <TidalImage
              src={getTidalImageUrl(track.album?.cover, 160)}
              alt={track.album?.title || track.title}
              className="w-full h-full object-cover"
            />
          </div>
        )}
        <div className="flex flex-col justify-center min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className={`text-[15px] font-medium truncate leading-snug ${
                isActive ? "text-th-accent" : "text-th-text-primary"
              }`}
            >
              {getTrackDisplayTitle(track)}
            </span>
            {track.explicit && <ExplicitBadge />}
          </div>
          {!showArtist && (
            <span className="text-[13px] text-th-text-muted truncate leading-snug">
              <TrackArtists
                artists={track.artists}
                artist={track.artist}
                className="hover:text-th-text-primary hover:underline transition-colors cursor-pointer"
              />
            </span>
          )}
        </div>
      </div>

      {/* Artist (Column) */}
      {showArtist && (
        <div className="flex items-center min-w-0">
          <span className="text-[14px] text-th-text-muted truncate">
            <TrackArtists
              artists={track.artists}
              artist={track.artist}
              className="hover:text-th-text-primary hover:underline transition-colors cursor-pointer"
            />
          </span>
        </div>
      )}

      {/* Album */}
      {showAlbum && (
        <div className="flex items-center min-w-0">
          <span
            className="text-[14px] text-th-text-muted truncate hover:text-th-text-primary hover:underline transition-colors cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              if (track.album?.id) {
                navigateToAlbum(track.album.id, {
                  title: track.album.title,
                  cover: track.album.cover,
                  artistName: track.artist?.name,
                });
              }
            }}
          >
            {track.album?.title || ""}
          </span>
        </div>
      )}

      {/* Date Added */}
      {showDateAdded && (
        <div className="flex items-center min-w-0">
          <span className="text-[14px] text-th-text-muted truncate">
            {formatDate(track.dateAdded)}
          </span>
        </div>
      )}

      {/* Duration */}
      <div className="flex items-center justify-end text-[14px] text-th-text-muted tabular-nums">
        {formatDuration(track.duration)}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2">
        <button
          ref={dotsButtonRef}
          className={`p-1.5 rounded-full transition-colors ${
            isBlocked
              ? "hidden"
              : contextMenuOpen
                ? "text-th-text-primary opacity-100"
                : "text-th-text-muted hover:text-th-text-primary opacity-0 group-hover:opacity-100"
          }`}
          title="More options"
          onClick={handleDotsClick}
          disabled={isBlocked}
        >
          <MoreHorizontal size={18} />
        </button>
        {contextMenuOpen && (
          <TrackContextMenu
            track={track}
            index={index}
            anchorRef={dotsButtonRef}
            cursorPosition={contextMenuCursorPos}
            onClose={() => setContextMenuOpen(false)}
            playlistId={playlistId}
            isUserPlaylist={isUserPlaylist}
            onTrackRemoved={onTrackRemoved}
          />
        )}
        {onAddToCurrentPlaylist ? (
          <button
            className="p-1.5 rounded-full transition-colors text-th-text-muted hover:text-th-accent"
            title="Add to this playlist"
            onClick={(e) => {
              e.stopPropagation();
              onAddToCurrentPlaylist(track);
            }}
          >
            <ListPlus size={18} />
          </button>
        ) : (
          <>
            <button
              ref={plusButtonRef}
              className={`p-1.5 rounded-full transition-colors ${
                playlistMenuOpen
                  ? "text-th-accent"
                  : "text-th-text-muted hover:text-th-text-primary"
              }`}
              title="Add to playlist"
              onClick={handlePlusClick}
            >
              <Plus size={18} />
            </button>
            {playlistMenuOpen && (
              <AddToPlaylistMenu
                trackIds={[track.id]}
                anchorRef={plusButtonRef}
                onClose={() => setPlaylistMenuOpen(false)}
              />
            )}
          </>
        )}
        <button
          className={`p-1.5 rounded-full transition-colors ${isFav ? "text-th-accent" : "text-th-text-muted hover:text-th-text-primary"}`}
          title={isFav ? "Remove from favorites" : "Add to favorites"}
          onClick={toggleFavorite}
        >
          <Heart size={18} fill={isFav ? "currentColor" : "none"} />
        </button>
      </div>
    </div>
  );
});

// ─── SortIndicator ─────────────────────────────────────────────────────────

function SortIndicator({ direction }: { direction: "ASC" | "DESC" }) {
  return direction === "ASC"
    ? <ChevronUp size={14} className="inline ml-0.5" />
    : <ChevronDown size={14} className="inline ml-0.5" />;
}

// ─── TrackList ─────────────────────────────────────────────────────────────

export default memo(function TrackList({
  tracks,
  onPlay,
  showDateAdded = false,
  showAlbum = true,
  showCover = true,
  showArtist = true,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
  context = "playlist",
  trackDisplayNumbers,
  playlistId,
  isUserPlaylist,
  onTrackRemoved,
  onAddToCurrentPlaylist,
  sortable = false,
  sortColumn,
  sortDirection,
  onSort,
  sortLoading = false,
}: TrackListProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    if (!onLoadMore) return;

    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore) {
          onLoadMore();
        }
      },
      { threshold: 0.1 },
    );

    if (sentinelRef.current) {
      observerRef.current.observe(sentinelRef.current);
    }

    return () => observerRef.current?.disconnect();
  }, [hasMore, onLoadMore]);

  // Build grid columns string
  const gridCols = useMemo(
    () =>
      [
        "36px", // #
        showCover ? "minmax(200px, 4fr)" : "minmax(200px, 4fr)", // Title (with or without cover)
        ...(showArtist ? ["minmax(120px, 2fr)"] : []),
        ...(showAlbum ? ["minmax(120px, 2fr)"] : []),
        ...(showDateAdded ? ["minmax(100px, 1fr)"] : []),
        "72px", // Time
        "100px", // Actions (always present for + and heart)
      ].join(" "),
    [showCover, showArtist, showAlbum, showDateAdded],
  );

  const handleHeaderClick = (column: string) => {
    if (!onSort) return;
    if (sortColumn === column) {
      // Toggle direction
      onSort(column, sortDirection === "ASC" ? "DESC" : "ASC");
    } else {
      onSort(column, "ASC");
    }
  };

  return (
    <div className="flex flex-col w-full">
      {/* Header Row */}
      <div
        className="grid gap-4 px-4 py-3 border-b border-th-inset text-[12px] text-th-text-muted uppercase tracking-widest mb-2"
        style={{ gridTemplateColumns: gridCols }}
      >
        <span className="text-right">#</span>
        <span>
          {sortable ? (
            <span className="cursor-pointer select-none hover:text-th-accent whitespace-nowrap" onClick={() => handleHeaderClick("NAME")}>
              Title{sortColumn === "NAME" && sortDirection && <SortIndicator direction={sortDirection} />}
            </span>
          ) : "Title"}
        </span>
        {showArtist && (
          <span>
            {sortable ? (
              <span className="cursor-pointer select-none hover:text-th-accent whitespace-nowrap" onClick={() => handleHeaderClick("ARTIST")}>
                Artist{sortColumn === "ARTIST" && sortDirection && <SortIndicator direction={sortDirection} />}
              </span>
            ) : "Artist"}
          </span>
        )}
        {showAlbum && (
          <span>
            {sortable ? (
              <span className="cursor-pointer select-none hover:text-th-accent whitespace-nowrap" onClick={() => handleHeaderClick("ALBUM")}>
                Album{sortColumn === "ALBUM" && sortDirection && <SortIndicator direction={sortDirection} />}
              </span>
            ) : "Album"}
          </span>
        )}
        {showDateAdded && (
          <span>
            {sortable ? (
              <span className="cursor-pointer select-none hover:text-th-accent whitespace-nowrap" onClick={() => handleHeaderClick("DATE")}>
                Date Added{sortColumn === "DATE" && sortDirection && <SortIndicator direction={sortDirection} />}
              </span>
            ) : "Date Added"}
          </span>
        )}
        <span className="text-right">
          {sortable ? (
            <span className="cursor-pointer select-none hover:text-th-accent whitespace-nowrap" onClick={() => handleHeaderClick("LENGTH")}>
              Time{sortColumn === "LENGTH" && sortDirection && <SortIndicator direction={sortDirection} />}
            </span>
          ) : "Time"}
        </span>
        <span /> {/* Actions column header */}
      </div>

      {/* Track Rows */}
      <div className="flex flex-col">
        {sortLoading ? (
          Array.from({ length: 20 }).map((_, i) => (
            <div
              key={i}
              className="grid gap-4 px-4 py-2.5"
              style={{ gridTemplateColumns: gridCols }}
            >
              <div className="flex items-center justify-end">
                <div className="h-4 w-5 bg-th-surface-hover rounded animate-pulse" />
              </div>
              <div className="flex items-center gap-3 min-w-0">
                {showCover && (
                  <div className="w-10 h-10 shrink-0 rounded bg-th-surface-hover animate-pulse" />
                )}
                <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                  <div className="h-4 w-3/5 bg-th-surface-hover rounded animate-pulse" />
                  <div className="h-3 w-2/5 bg-th-surface-hover/60 rounded animate-pulse" />
                </div>
              </div>
              {showArtist && (
                <div className="flex items-center">
                  <div className="h-3.5 w-3/5 bg-th-surface-hover/60 rounded animate-pulse" />
                </div>
              )}
              {showAlbum && (
                <div className="flex items-center">
                  <div className="h-3.5 w-3/5 bg-th-surface-hover/60 rounded animate-pulse" />
                </div>
              )}
              {showDateAdded && (
                <div className="flex items-center">
                  <div className="h-3.5 w-2/5 bg-th-surface-hover/60 rounded animate-pulse" />
                </div>
              )}
              <div className="flex items-center justify-end">
                <div className="h-3.5 w-8 bg-th-surface-hover/60 rounded animate-pulse" />
              </div>
              <div />
            </div>
          ))
        ) : (
          tracks.map((track, index) => (
            <TrackRow
              key={`${track.id}-${index}`}
              track={track}
              index={index}
              displayNumber={trackDisplayNumbers?.[index]}
              gridCols={gridCols}
              showCover={showCover}
              showArtist={showArtist}
              showAlbum={showAlbum}
              showDateAdded={showDateAdded}
              context={context}
              onPlay={onPlay}
              playlistId={playlistId}
              isUserPlaylist={isUserPlaylist}
              onTrackRemoved={onTrackRemoved}
              onAddToCurrentPlaylist={onAddToCurrentPlaylist}
            />
          ))
        )}
      </div>

      {/* Infinite Scroll Sentinel */}
      {hasMore && (
        <div ref={sentinelRef}>
          {loadingMore ? (
            <div className="flex flex-col">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="grid gap-4 px-4 py-2.5"
                  style={{ gridTemplateColumns: gridCols }}
                >
                  <div className="flex items-center justify-end">
                    <div className="h-4 w-5 bg-th-surface-hover rounded animate-pulse" />
                  </div>
                  <div className="flex items-center gap-3 min-w-0">
                    {showCover && (
                      <div className="w-10 h-10 shrink-0 rounded bg-th-surface-hover animate-pulse" />
                    )}
                    <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                      <div className="h-4 w-3/5 bg-th-surface-hover rounded animate-pulse" />
                      <div className="h-3 w-2/5 bg-th-surface-hover/60 rounded animate-pulse" />
                    </div>
                  </div>
                  {showArtist && (
                    <div className="flex items-center">
                      <div className="h-3.5 w-3/5 bg-th-surface-hover/60 rounded animate-pulse" />
                    </div>
                  )}
                  {showAlbum && (
                    <div className="flex items-center">
                      <div className="h-3.5 w-3/5 bg-th-surface-hover/60 rounded animate-pulse" />
                    </div>
                  )}
                  {showDateAdded && (
                    <div className="flex items-center">
                      <div className="h-3.5 w-2/5 bg-th-surface-hover/60 rounded animate-pulse" />
                    </div>
                  )}
                  <div className="flex items-center justify-end">
                    <div className="h-3.5 w-8 bg-th-surface-hover/60 rounded animate-pulse" />
                  </div>
                  <div />
                </div>
              ))}
            </div>
          ) : (
            <div className="h-8" />
          )}
        </div>
      )}
    </div>
  );
});
