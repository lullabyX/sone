import {
  X,
  ListMusic,
  Sparkles,
  Mic2,
  Users,
  Music,
  Play,
  Heart,
  MoreHorizontal,
  ListPlus,
  GripVertical,
  Maximize2,
} from "lucide-react";
import { parseLrc, type LrcLine } from "../lib/lrc";
import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  memo,
  useMemo,
} from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  isPlayingAtom,
  currentTrackAtom,
  queueAtom,
  historyAtom,
  manualQueueAtom,
  playbackSourceAtom,
  contextSourceAtom,
} from "../atoms/playback";
import { maximizedPlayerAtom } from "../atoms/ui";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useDrawer } from "../hooks/useDrawer";
import { useFavorites } from "../hooks/useFavorites";
import { useNavigation } from "../hooks/useNavigation";
import { useToast } from "../contexts/ToastContext";
import { getInterpolatedPosition } from "../lib/playbackPosition";
import {
  getMixItems,
  getTrackLyrics,
  getTrackCredits,
  getArtistBio,
} from "../api/tidal";
import BioText from "./BioText";
import {
  getTidalImageUrl,
  getTrackDisplayTitle,
  type Track,
  type Lyrics,
  type Credit,
} from "../types";
import TidalImage from "./TidalImage";
import TrackContextMenu from "./TrackContextMenu";
import { TrackArtists, type ArtistInfo } from "./TrackArtists";
import { getTrackArtistDisplay } from "../utils/itemHelpers";

type TabId = "queue" | "suggested" | "lyrics" | "credits";

const TABS: { id: TabId; label: string; icon: typeof ListMusic }[] = [
  { id: "queue", label: "Play queue", icon: ListMusic },
  { id: "suggested", label: "Suggested tracks", icon: Sparkles },
  { id: "lyrics", label: "Lyrics", icon: Mic2 },
  { id: "credits", label: "Credits", icon: Users },
];

// ─── Queue Tab ───────────────────────────────────────────────────────────────

const QUEUE_ROW_HEIGHT = 56; // px — matches py-2 (8+8) + h-10 (40) content
const SECTION_DIVIDER_HEIGHT = 52; // px — gap above (24) + label (16) + gap below (12), matches gap-6 + mb-3

const QueueTab = memo(function QueueTab({
  scrollEl,
}: {
  scrollEl: HTMLDivElement;
}) {
  const currentTrack = useAtomValue(currentTrackAtom);
  const contextQueue = useAtomValue(queueAtom);
  const history = useAtomValue(historyAtom);
  const isPlaying = useAtomValue(isPlayingAtom);
  const source = useAtomValue(playbackSourceAtom);
  const contextSource = useAtomValue(contextSourceAtom);
  const manualQueue = useAtomValue(manualQueueAtom);
  const contextQueueSource = contextSource ?? source;
  const combinedQueue = useMemo(
    () => [...manualQueue, ...contextQueue],
    [manualQueue, contextQueue],
  );
  const {
    playTrack,
    setQueueTracks,
    removeFromQueue,
    playFromQueue,
    clearQueue,
  } = usePlaybackActions();
  const { favoriteTrackIds, addFavoriteTrack, removeFavoriteTrack } =
    useFavorites();
  const {
    navigateToArtist,
    navigateToAlbum,
    navigateToPlaylist,
    navigateToMix,
    navigateToArtistTracks,
    navigateToFavorites,
  } = useNavigation();
  const { setDrawerOpen } = useDrawer();
  const { showToast } = useToast();

  const navigableSourceTypes = new Set([
    "album",
    "playlist",
    "mix",
    "artist",
    "artist-tracks",
    "favorites",
    "radio",
  ]);
  const sourceIsNavigable = source && navigableSourceTypes.has(source.type);

  const navigateToSource = useCallback(() => {
    if (!source) return;
    setDrawerOpen(false);
    switch (source.type) {
      case "album":
        navigateToAlbum(source.id as number);
        break;
      case "playlist":
        navigateToPlaylist(source.id as string, {
          title: source.name,
          image: source.image,
        });
        break;
      case "mix":
        navigateToMix(source.id as string, {
          title: source.name,
          image: source.image,
          subtitle: source.subtitle,
          mixType: source.mixType,
        });
        break;
      case "artist":
        navigateToArtist(source.id as number);
        break;
      case "artist-tracks":
        navigateToArtistTracks(source.id as number, source.name);
        break;
      case "favorites":
        navigateToFavorites();
        break;
      case "radio":
        navigateToMix(source.id.toString(), {
          title: source.name,
          image: source.image,
          mixType: "TRACK_MIX",
        });
        break;
    }
  }, [
    source,
    setDrawerOpen,
    navigateToAlbum,
    navigateToPlaylist,
    navigateToMix,
    navigateToArtist,
    navigateToArtistTracks,
    navigateToFavorites,
  ]);

  const navigateToContextQueueSource = useCallback(() => {
    const s = contextQueueSource;
    if (!s) return;
    setDrawerOpen(false);
    switch (s.type) {
      case "album":
        navigateToAlbum(s.id as number);
        break;
      case "playlist":
        navigateToPlaylist(s.id as string, { title: s.name, image: s.image });
        break;
      case "mix":
        navigateToMix(s.id as string, { title: s.name, image: s.image, subtitle: s.subtitle, mixType: s.mixType });
        break;
      case "artist":
        navigateToArtist(s.id as number);
        break;
      case "artist-tracks":
        navigateToArtistTracks(s.id as number, s.name);
        break;
      case "favorites":
        navigateToFavorites();
        break;
      case "radio":
        navigateToMix(s.id.toString(), { title: s.name, image: s.image, mixType: "TRACK_MIX" });
        break;
    }
  }, [contextQueueSource, setDrawerOpen, navigateToAlbum, navigateToPlaylist, navigateToMix, navigateToArtist, navigateToArtistTracks, navigateToFavorites]);

  // Use refs so drag/drop handlers always read the current values
  const dragIdxRef = useRef<number | null>(null);
  const queueRef = useRef(combinedQueue);
  queueRef.current = combinedQueue;
  const manualCountRef = useRef(manualQueue.length);
  manualCountRef.current = manualQueue.length;
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, idx: number) => {
    dragIdxRef.current = idx;
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(idx));
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropIdx(idx);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDropIdx(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetIdx: number) => {
      e.preventDefault();
      e.stopPropagation();
      const sourceIdx = dragIdxRef.current;
      if (sourceIdx === null || sourceIdx === targetIdx) {
        dragIdxRef.current = null;
        setDragIdx(null);
        setDropIdx(null);
        return;
      }
      const currentQueue = queueRef.current;
      const mc = manualCountRef.current;
      const reordered = [...currentQueue];
      const [moved] = reordered.splice(sourceIdx, 1);
      reordered.splice(targetIdx, 0, moved);
      // Compute new manual/context boundary after cross-section drag
      let newManualCount = mc;
      if (sourceIdx < mc && targetIdx >= mc) {
        // Dragged from manual into context
        newManualCount = mc - 1;
      } else if (sourceIdx >= mc && targetIdx < mc) {
        // Dragged from context into manual
        newManualCount = mc + 1;
      }
      setQueueTracks(reordered, { reorder: true, manualCount: newManualCount });
      dragIdxRef.current = null;
      setDragIdx(null);
      setDropIdx(null);
    },
    [setQueueTracks],
  );

  const handleDragEnd = useCallback(() => {
    dragIdxRef.current = null;
    setDragIdx(null);
    setDropIdx(null);
  }, []);

  const handleToggleFavorite = useCallback(
    async (trackId: number, track?: Track) => {
      const isFav = favoriteTrackIds.has(trackId);
      try {
        if (isFav) {
          await removeFavoriteTrack(trackId);
          showToast("Removed from Loved tracks");
        } else {
          await addFavoriteTrack(trackId, track);
          showToast("Added to Loved tracks");
        }
      } catch {
        showToast("Failed to update Loved tracks", "error");
      }
    },
    [favoriteTrackIds, addFavoriteTrack, removeFavoriteTrack, showToast],
  );

  const handleArtistClick = useCallback(
    (artist: ArtistInfo) => {
      if (artist.id) {
        setDrawerOpen(false);
        navigateToArtist(artist.id, {
          name: artist.name,
          picture: artist.picture,
        });
      }
    },
    [navigateToArtist, setDrawerOpen],
  );

  const handleAlbumClick = useCallback(
    (track: Track) => {
      if (track.album?.id) {
        setDrawerOpen(false);
        navigateToAlbum(track.album.id, {
          title: track.album.title,
          cover: track.album.cover,
          artistName: track.artist?.name,
        });
      }
    },
    [navigateToAlbum, setDrawerOpen],
  );

  /** Shared props builder for TrackRow to avoid repetition */
  const trackRowNav = useCallback(
    (track: Track) => ({
      isFav: favoriteTrackIds.has(track.id),
      onToggleFavorite: () => handleToggleFavorite(track.id, track),
      onArtistClick: (track.artist?.id || track.artists?.[0]?.id)
        ? handleArtistClick
        : undefined,
      onAlbumClick: track.album?.id ? () => handleAlbumClick(track) : undefined,
    }),
    [
      favoriteTrackIds,
      handleToggleFavorite,
      handleArtistClick,
      handleAlbumClick,
    ],
  );

  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  // Whether we need a section divider between manual and context queues
  const hasDivider = manualQueue.length > 0 && contextQueue.length > 0;
  // The virtual index where the divider sits (right after the last manual item)
  const dividerVIdx = manualQueue.length;

  useLayoutEffect(() => {
    if (listRef.current) {
      setScrollMargin(listRef.current.offsetTop);
    }
  }, [history.length, !!currentTrack]);

  const virtualizer = useVirtualizer({
    count: combinedQueue.length + (hasDivider ? 1 : 0),
    getScrollElement: () => scrollEl,
    estimateSize: (index) =>
      hasDivider && index === dividerVIdx
        ? SECTION_DIVIDER_HEIGHT
        : QUEUE_ROW_HEIGHT,
    overscan: 10,
    scrollMargin,
  });

  return (
    <div className="flex flex-col gap-6">
      {/* History — chronological order, most recent at the bottom */}
      {history.length > 0 && (
        <section>
          <h3 className="text-[13px] font-bold text-th-text-muted uppercase tracking-wider mb-3">
            History
          </h3>
          <div className="flex flex-col gap-0.5">
            {history.slice(-10).map((track, i) => (
              <TrackRow
                key={`hist-${track.id}-${i}`}
                track={track}
                isActive={false}
                isPlaying={false}
                dimmed
                onClick={() => playTrack(track)}
                {...trackRowNav(track)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Now Playing */}
      {currentTrack && (
        <section>
          <h3 className="text-[13px] font-bold text-th-text-muted uppercase tracking-wider mb-3">
            Now playing
          </h3>
          <TrackRow
            track={currentTrack}
            isActive
            isPlaying={isPlaying}
            onClick={() => {}}
            {...trackRowNav(currentTrack)}
          />
        </section>
      )}

      {/* Next Up — virtualized, draggable */}
      {combinedQueue.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[13px] font-bold text-th-text-muted uppercase tracking-wider">
              {manualQueue.length > 0 ? (
                "Next in queue"
              ) : source ? (
                <>
                  Next up from{" "}
                  {sourceIsNavigable ? (
                    <button
                      onClick={navigateToSource}
                      className="uppercase underline hover:text-th-text-primary transition-colors"
                    >
                      {source.name}
                    </button>
                  ) : (
                    <span className="uppercase underline">{source.name}</span>
                  )}
                </>
              ) : (
                "Next up"
              )}
            </h3>
            <button
              onClick={() => clearQueue()}
              className="text-[11px] text-th-text-muted hover:text-th-text-primary transition-colors"
            >
              Clear
            </button>
          </div>
          <div
            ref={listRef}
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((vItem) => {
              const vIdx = vItem.index;

              // Render the section divider as its own virtual item
              if (hasDivider && vIdx === dividerVIdx) {
                return (
                  <div
                    key="section-divider"
                    className="absolute left-0 right-0 flex items-end"
                    style={{
                      top: `${vItem.start - scrollMargin}px`,
                      height: `${vItem.size}px`,
                    }}
                  >
                    <span className="text-[13px] font-bold text-th-text-muted uppercase tracking-wider pb-3">
                      {contextQueueSource ? (
                        <>
                          Next up from{" "}
                          {navigableSourceTypes.has(contextQueueSource.type) ? (
                            <button
                              onClick={navigateToContextQueueSource}
                              className="uppercase underline hover:text-th-text-primary transition-colors"
                            >
                              {contextQueueSource.name}
                            </button>
                          ) : (
                            <span className="uppercase underline">{contextQueueSource.name}</span>
                          )}
                        </>
                      ) : (
                        "Next up"
                      )}
                    </span>
                  </div>
                );
              }

              // Map virtual index to real queue index (skip the divider slot)
              const queueIdx =
                hasDivider && vIdx > dividerVIdx ? vIdx - 1 : vIdx;
              const track = combinedQueue[queueIdx];
              const isDragged = dragIdx === queueIdx;
              const showDropAbove =
                dragIdx !== null && dropIdx === queueIdx && dragIdx > queueIdx;
              const showDropBelow =
                dragIdx !== null && dropIdx === queueIdx && dragIdx < queueIdx;

              return (
                <div
                  key={`queue-${(track as any)._qid || track.id}-${queueIdx}`}
                  data-index={queueIdx}
                  draggable
                  onDragStart={(e) => handleDragStart(e, queueIdx)}
                  onDragOver={(e) => handleDragOver(e, queueIdx)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, queueIdx)}
                  onDragEnd={handleDragEnd}
                  className={`absolute left-0 right-0 flex items-center gap-1 rounded-md transition-opacity duration-150 ${
                    isDragged ? "opacity-30" : "opacity-100"
                  }`}
                  style={{
                    top: `${vItem.start - scrollMargin}px`,
                  }}
                >
                  {/* Drop indicator line — above */}
                  {showDropAbove && (
                    <div className="absolute -top-[1px] left-6 right-0 h-[2px] bg-th-accent rounded-full z-10 pointer-events-none">
                      <div className="absolute -left-1 -top-[3px] w-2 h-2 rounded-full bg-th-accent" />
                    </div>
                  )}

                  <div className="flex items-center justify-center w-6 shrink-0 cursor-grab active:cursor-grabbing text-th-text-disabled hover:text-th-text-muted transition-colors">
                    <GripVertical size={14} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <TrackRow
                      track={track}
                      isActive={false}
                      isPlaying={false}
                      onClick={() => playFromQueue(queueIdx)}
                      onRemove={() => removeFromQueue(queueIdx)}
                      {...trackRowNav(track)}
                    />
                  </div>

                  {/* Drop indicator line — below */}
                  {showDropBelow && (
                    <div className="absolute -bottom-[1px] left-6 right-0 h-[2px] bg-th-accent rounded-full z-10 pointer-events-none">
                      <div className="absolute -left-1 -top-[3px] w-2 h-2 rounded-full bg-th-accent" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {combinedQueue.length === 0 && !currentTrack && (
        <div className="flex flex-col items-center justify-center py-16 text-th-text-disabled">
          <Music size={40} className="mb-3" />
          <p className="text-sm">Queue is empty</p>
        </div>
      )}
    </div>
  );
});

// ─── Suggested Tracks Tab ────────────────────────────────────────────────────

function SuggestedTrackRow({
  track,
  isActive,
  index,
  isFav,
  onPlay,
  onAddToQueue,
  onToggleFavorite,
  onArtistClick,
  onAlbumClick,
}: {
  track: Track;
  isActive: boolean;
  index: number;
  isFav: boolean;
  onPlay: (track: Track) => void;
  onAddToQueue: (track: Track) => void;
  onToggleFavorite: (trackId: number, isFav: boolean, track?: Track) => void;
  onArtistClick?: (artist: ArtistInfo) => void;
  onAlbumClick?: (track: Track) => void;
}) {
  // Context menu state — lightweight, no heavy hooks
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const dotsBtnRef = useRef<HTMLButtonElement | null>(null);
  const [dotsMenuOpen, setDotsMenuOpen] = useState(false);

  const handleRightClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleRowClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onAddToQueue(track);
    },
    [track, onAddToQueue],
  );

  const handlePlayClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onPlay(track);
    },
    [track, onPlay],
  );

  const handleToggleFavorite = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleFavorite(track.id, isFav, track);
    },
    [track, isFav, onToggleFavorite],
  );

  const handleAddToQueue = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onAddToQueue(track);
    },
    [track, onAddToQueue],
  );

  const handleDotsClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setDotsMenuOpen(true);
  }, []);

  return (
    <>
      <div
        onClick={handleRowClick}
        onContextMenu={handleRightClick}
        className={`flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer group transition-[background-color] duration-150 ${
          isActive ? "bg-th-hl-med" : "hover:bg-th-hl-faint"
        }`}
      >
        {/* Album art with play overlay — scoped hover via group/image */}
        <div
          className="w-10 h-10 rounded bg-th-surface-hover overflow-hidden shrink-0 relative cursor-pointer group/image"
          onClick={handlePlayClick}
        >
          <TidalImage
            src={getTidalImageUrl(track.album?.cover, 80)}
            alt={track.title}
            className="w-full h-full"
          />
          {/* Play overlay — only visible when hovering the image itself */}
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover/image:opacity-100 transition-opacity">
            <Play size={14} fill="white" className="text-white ml-0.5" />
          </div>
        </div>

        {/* Track info */}
        <div className="flex-1 min-w-0">
          <p
            className={`text-[13px] font-medium truncate ${
              isActive ? "text-th-accent" : "text-th-text-primary"
            }`}
          >
            {getTrackDisplayTitle(track)}
          </p>
          <p className="text-[11px] text-th-text-muted truncate">
            <TrackArtists
              artists={track.artists}
              artist={track.artist}
              className="hover:text-th-text-primary hover:underline cursor-pointer"
              onArtistClick={onArtistClick}
            />
            {track.album?.title && (
              <>
                <span className="mx-1">&middot;</span>
                <span
                  className="hover:text-th-text-primary hover:underline cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAlbumClick?.(track);
                  }}
                >
                  {track.album.title}
                </span>
              </>
            )}
          </p>
        </div>

        {/* Right-side action icons — always visible */}
        <div className="flex items-center gap-0.5 shrink-0">
          {/* Three dots menu */}
          <button
            ref={dotsBtnRef}
            onClick={handleDotsClick}
            className="w-7 h-7 rounded-full flex items-center justify-center text-th-text-disabled hover:text-th-text-primary hover:bg-th-border-subtle transition-colors duration-150"
            title="More options"
          >
            <MoreHorizontal size={15} />
          </button>

          {/* Heart / favorite */}
          <button
            onClick={handleToggleFavorite}
            className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-th-border-subtle transition-colors duration-150"
            title={isFav ? "Remove from Loved tracks" : "Add to Loved tracks"}
          >
            <Heart
              size={15}
              className={
                isFav
                  ? "text-th-accent"
                  : "text-th-text-disabled hover:text-th-text-primary"
              }
              fill={isFav ? "currentColor" : "none"}
            />
          </button>

          {/* Add to queue */}
          <button
            onClick={handleAddToQueue}
            className="w-7 h-7 rounded-full flex items-center justify-center text-th-text-disabled hover:text-th-text-primary hover:bg-th-border-subtle transition-colors duration-150"
            title="Add to queue"
          >
            <ListPlus size={15} />
          </button>
        </div>
      </div>

      {/* Context menu (right-click) */}
      {contextMenu && (
        <TrackContextMenu
          track={track}
          index={index}
          anchorRef={
            { current: null } as React.RefObject<HTMLButtonElement | null>
          }
          cursorPosition={contextMenu}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Context menu (dots button) */}
      {dotsMenuOpen && (
        <TrackContextMenu
          track={track}
          index={index}
          anchorRef={dotsBtnRef}
          onClose={() => setDotsMenuOpen(false)}
        />
      )}
    </>
  );
}

const SuggestedTab = memo(function SuggestedTab() {
  const currentTrack = useAtomValue(currentTrackAtom);
  const { playTrack, addToQueue } = usePlaybackActions();
  const { favoriteTrackIds, addFavoriteTrack, removeFavoriteTrack } =
    useFavorites();
  const { navigateToArtist, navigateToAlbum } = useNavigation();
  const { setDrawerOpen } = useDrawer();
  const { showToast } = useToast();

  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentTrack) return;

    let active = true;
    setLoading(true);
    setError(null);

    const trackMixId = currentTrack.mixes?.TRACK_MIX;
    if (trackMixId) {
      getMixItems(trackMixId)
        .then(({ tracks }) => {
          if (active) setTracks(tracks);
        })
        .catch((err) => {
          if (active) setError(String(err));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    } else {
      setTracks([]);
      setLoading(false);
    }

    return () => {
      active = false;
    };
  }, [currentTrack?.id]);

  // Stable callbacks passed to every row — hooks called once here, not per row
  const handleAddToQueue = useCallback(
    (track: Track) => {
      addToQueue(track);
      const displayTitle = getTrackDisplayTitle(track);
      const label = displayTitle.length > 30 ? displayTitle.slice(0, 28) + "…" : displayTitle;
      showToast(`Added "${label}" to queue`, "success");
    },
    [addToQueue, showToast],
  );

  const handleToggleFavorite = useCallback(
    async (trackId: number, currentlyFav: boolean, track?: Track) => {
      try {
        if (currentlyFav) {
          await removeFavoriteTrack(trackId);
          showToast("Removed from Loved tracks");
        } else {
          await addFavoriteTrack(trackId, track);
          showToast("Added to Loved tracks");
        }
      } catch {
        showToast("Failed to update Loved tracks", "error");
      }
    },
    [addFavoriteTrack, removeFavoriteTrack, showToast],
  );

  const handleArtistClick = useCallback(
    (artist: ArtistInfo) => {
      if (artist.id) {
        setDrawerOpen(false);
        navigateToArtist(artist.id, {
          name: artist.name,
          picture: artist.picture,
        });
      }
    },
    [navigateToArtist, setDrawerOpen],
  );

  const handleAlbumClick = useCallback(
    (track: Track) => {
      if (track.album?.id) {
        setDrawerOpen(false);
        navigateToAlbum(track.album.id, {
          title: track.album.title,
          cover: track.album.cover,
          artistName: track.artist?.name,
        });
      }
    },
    [navigateToAlbum, setDrawerOpen],
  );

  if (loading) {
    return (
      <div className="flex flex-col gap-0.5">
        {Array.from({ length: 8 }, (_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 px-3 py-2"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <div className="w-10 h-10 rounded bg-th-hl-med animate-pulse shrink-0" />
            <div className="flex-1 min-w-0 flex flex-col gap-1.5">
              <div
                className="h-[13px] rounded bg-th-hl-med animate-pulse"
                style={{ width: `${[65, 45, 72, 55, 80, 50, 60, 40][i]}%` }}
              />
              <div
                className="h-[11px] rounded bg-th-hl-faint animate-pulse"
                style={{ width: `${[50, 70, 40, 60, 35, 55, 45, 65][i]}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error || tracks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-th-text-disabled">
        <Sparkles size={40} className="mb-3" />
        <p className="text-sm">No suggested tracks available for this track</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {tracks.map((track, i) => (
        <SuggestedTrackRow
          key={`sug-${track.id}-${i}`}
          track={track}
          isActive={currentTrack?.id === track.id}
          index={i}
          isFav={favoriteTrackIds.has(track.id)}
          onPlay={playTrack}
          onAddToQueue={handleAddToQueue}
          onToggleFavorite={handleToggleFavorite}
          onArtistClick={handleArtistClick}
          onAlbumClick={handleAlbumClick}
        />
      ))}
    </div>
  );
});

// ─── Lyrics Tab ──────────────────────────────────────────────────────────────

// Memoized individual lyrics line — only re-renders when its own state changes
const LyricsLine = memo(function LyricsLine({
  text,
  isActive,
  isPast,
  lineRef,
}: {
  text: string;
  isActive: boolean;
  isPast: boolean;
  lineRef: (el: HTMLParagraphElement | null) => void;
}) {
  return (
    <p
      ref={lineRef}
      className={`text-xl font-medium cursor-default leading-snug origin-left transition-[transform,color,opacity] duration-500 ease-out ${
        isActive
          ? "scale-[1.22] font-bold text-th-text-primary"
          : isPast
            ? "text-th-text-disabled"
            : "text-th-text-faint"
      }`}
      style={isActive ? { willChange: "transform" } : undefined}
    >
      {text}
    </p>
  );
});

const LyricsTab = memo(function LyricsTab() {
  const currentTrack = useAtomValue(currentTrackAtom);
  const isPlaying = useAtomValue(isPlayingAtom);
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lrcLines, setLrcLines] = useState<LrcLine[]>([]);
  const [activeLine, setActiveLine] = useState(-1);
  const [userScrolled, setUserScrolled] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLParagraphElement | null)[]>([]);
  const isAutoScrolling = useRef(false);
  const scrollTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const activeLineRef = useRef(-1);

  // Fetch lyrics
  useEffect(() => {
    if (!currentTrack) return;

    let active = true;
    setLoading(true);
    setError(null);
    setLyrics(null);
    setLrcLines([]);
    setActiveLine(-1);
    activeLineRef.current = -1;
    setUserScrolled(false);

    getTrackLyrics(currentTrack.id)
      .then((result) => {
        if (!active) return;
        setLyrics(result);
        if (result.subtitles) {
          const parsed = parseLrc(result.subtitles);
          if (parsed.length > 0) setLrcLines(parsed);
        }
      })
      .catch((err) => {
        if (active) setError(String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [currentTrack?.id]);

  // Detect user-initiated scrolls vs programmatic scrolls
  useEffect(() => {
    const el = containerRef.current;
    if (!el || lrcLines.length === 0) return;

    const onScroll = () => {
      if (isAutoScrolling.current) return;
      setUserScrolled(true);
      clearTimeout(scrollTimeout.current);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [lrcLines]);

  // Sync active line with interpolated position — rAF loop, state update only on line change
  useEffect(() => {
    if (lrcLines.length === 0 || !isPlaying) return;

    let rafId: number;
    const tick = () => {
      const pos = getInterpolatedPosition();
      let idx = -1;
      for (let i = lrcLines.length - 1; i >= 0; i--) {
        if (pos >= lrcLines[i].time) {
          idx = i;
          break;
        }
      }
      // Only update state when the active line actually changes
      if (idx !== activeLineRef.current) {
        activeLineRef.current = idx;
        setActiveLine(idx);
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [lrcLines, isPlaying]);

  // Auto-scroll to active line (only if user hasn't scrolled)
  const scrollToLine = useCallback((idx: number) => {
    const el = lineRefs.current[idx];
    const container = containerRef.current;
    if (!el || !container) return;

    isAutoScrolling.current = true;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => {
      isAutoScrolling.current = false;
    }, 600);
  }, []);

  useEffect(() => {
    if (activeLine >= 0 && !userScrolled) scrollToLine(activeLine);
  }, [activeLine, userScrolled, scrollToLine]);

  // "Sync lyrics" button handler
  const handleResync = useCallback(() => {
    setUserScrolled(false);
    if (activeLine >= 0) scrollToLine(activeLine);
  }, [activeLine, scrollToLine]);

  // Stable ref callback factory — avoids new closures per line on each render
  const setLineRef = useCallback(
    (i: number) => (el: HTMLParagraphElement | null) => {
      lineRefs.current[i] = el;
    },
    [],
  );

  if (loading) {
    return (
      <div className="flex flex-col gap-3 py-10">
        {[72, 55, 85, 40, 68, 90, 50, 75, 60, 45, 80, 35].map((w, i) => (
          <div
            key={i}
            className="h-[22px] rounded bg-th-hl-med animate-pulse"
            style={{ width: `${w}%`, animationDelay: `${i * 80}ms` }}
          />
        ))}
      </div>
    );
  }

  if (error || (!lyrics?.lyrics && lrcLines.length === 0)) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-th-text-disabled">
        <Mic2 size={40} className="mb-3" />
        <p className="text-sm">No lyrics available for this track</p>
      </div>
    );
  }

  // Synced lyrics view (from subtitles/LRC)
  if (lrcLines.length > 0) {
    return (
      <div className="relative overflow-hidden h-full">
        <div
          ref={containerRef}
          className="h-full overflow-y-auto overflow-x-hidden flex flex-col gap-3 py-10 pr-0 scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent"
          dir={lyrics?.isRightToLeft ? "rtl" : "ltr"}
        >
          {lrcLines.map((line, i) => (
            <LyricsLine
              key={i}
              text={line.text}
              isActive={i === activeLine}
              isPast={activeLine >= 0 && i < activeLine}
              lineRef={setLineRef(i)}
            />
          ))}
          <div className="h-40" /> {/* bottom spacer */}
          {lyrics?.lyricsProvider && (
            <p className="text-[11px] text-th-text-disabled pb-4">
              Lyrics provided by {lyrics.lyricsProvider}
            </p>
          )}
        </div>

        {/* Floating sync button — visible when user has scrolled away */}
        {userScrolled && (
          <button
            onClick={handleResync}
            className="absolute bottom-4 right-8 flex items-center gap-2 px-4 py-2.5 bg-th-accent text-black text-[12px] font-bold rounded-full shadow-lg shadow-black/40 hover:brightness-110 active:scale-95 transition-[filter,transform] duration-150 animate-fadeIn"
          >
            <Mic2 size={14} />
            Sync lyrics
          </button>
        )}
      </div>
    );
  }

  // Plain lyrics fallback
  return (
    <div className="py-8 px-2" dir={lyrics?.isRightToLeft ? "rtl" : "ltr"}>
      <div className="whitespace-pre-wrap text-[18px] leading-loose text-th-text-faint">
        {lyrics?.lyrics}
      </div>
      {lyrics?.lyricsProvider && (
        <p className="mt-8 text-[11px] text-th-text-disabled">
          Lyrics provided by {lyrics.lyricsProvider}
        </p>
      )}
    </div>
  );
});

// ─── Credits Tab ─────────────────────────────────────────────────────────────

function SkeletonBar({ className = "" }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded bg-th-hl-med ${className}`} />
  );
}

function SkeletonRow({ first = false }: { first?: boolean }) {
  return (
    <div
      className={`flex flex-col gap-1.5 py-4 ${first ? "" : "border-t border-th-border-subtle"}`}
    >
      <SkeletonBar className="h-3 w-20" />
      <SkeletonBar className="h-[18px] w-48" />
    </div>
  );
}

const CreditsTab = memo(function CreditsTab() {
  const currentTrack = useAtomValue(currentTrackAtom);
  const { navigateToArtist } = useNavigation();
  const { setDrawerOpen } = useDrawer();
  const [credits, setCredits] = useState<Credit[]>([]);
  const [creditsLoading, setCreditsLoading] = useState(true);
  const [creditsError, setCreditsError] = useState<string | null>(null);
  const [bio, setBio] = useState<string | null>(null);
  const [bioLoading, setBioLoading] = useState(false);

  useEffect(() => {
    if (!currentTrack) return;

    let active = true;
    setCreditsLoading(true);
    setCreditsError(null);
    setCredits([]);

    getTrackCredits(currentTrack.id)
      .then((result) => {
        if (active) setCredits(result);
      })
      .catch((err) => {
        if (active) setCreditsError(String(err));
      })
      .finally(() => {
        if (active) setCreditsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [currentTrack?.id]);

  useEffect(() => {
    const artistId = currentTrack?.artist?.id;
    if (!artistId) {
      setBio(null);
      return;
    }

    let active = true;
    setBioLoading(true);
    setBio(null);

    getArtistBio(artistId)
      .then((result) => {
        if (active) setBio(result || null);
      })
      .catch(() => {
        if (active) setBio(null);
      })
      .finally(() => {
        if (active) setBioLoading(false);
      });

    return () => {
      active = false;
    };
  }, [currentTrack?.artist?.id]);

  const handleArtistLink = useCallback(
    (artistId: number, name: string) => {
      setDrawerOpen(false);
      navigateToArtist(artistId, { name });
    },
    [navigateToArtist, setDrawerOpen],
  );

  const hasNoCredits =
    !creditsLoading && (creditsError || credits.length === 0);
  const releaseDate = currentTrack?.album?.releaseDate
    ? (() => {
        const d = new Date(currentTrack.album!.releaseDate!);
        return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
      })()
    : null;
  if (hasNoCredits && !bioLoading && !bio) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-th-text-disabled">
        <Users size={40} className="mb-3" />
        <p className="text-sm">No credits available for this track</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Track metadata + credits — unified row list */}
      {currentTrack && (
        <>
          <CreditRow label="Title" value={getTrackDisplayTitle(currentTrack)} first />
          <CreditRow
            label="Artists"
            value={getTrackArtistDisplay(currentTrack)}
          />
          {currentTrack.album?.title && (
            <CreditRow label="Album" value={currentTrack.album.title} />
          )}
          {releaseDate && <CreditRow label="Released" value={releaseDate} />}
          {currentTrack.copyright && (
            <CreditRow label="Label" value={currentTrack.copyright} />
          )}
        </>
      )}

      {/* Credit roles */}
      {creditsLoading ? (
        <>
          {[...Array(4)].map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </>
      ) : (
        credits.map((credit, i) => (
          <CreditRow
            key={`${credit.creditType}-${i}`}
            label={credit.creditType}
            value={credit.contributors.map((c) => c.name).join(", ")}
          />
        ))
      )}

      {/* Artist bio */}
      {bioLoading && (
        <div className="flex flex-col gap-2.5 pt-6 mt-2">
          <SkeletonBar className="h-5 w-12" />
          <SkeletonBar className="h-4 w-full" />
          <SkeletonBar className="h-4 w-full" />
          <SkeletonBar className="h-4 w-5/6" />
          <SkeletonBar className="h-4 w-3/4" />
        </div>
      )}
      {!bioLoading && bio && (
        <div className="flex flex-col pt-6 mt-2">
          <h3 className="text-[16px] font-bold text-th-text-primary mb-3">Bio</h3>
          <BioText
            bio={bio}
            onArtistClick={handleArtistLink}
            className="text-th-text-secondary"
          />
        </div>
      )}
    </div>
  );
});

function CreditRow({
  label,
  value,
  first = false,
}: {
  label: string;
  value: string;
  first?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-1 py-4 ${first ? "" : "border-t border-th-border-subtle"}`}
    >
      <span className="text-[11px] font-bold text-th-text-faint uppercase tracking-widest">
        {label}
      </span>
      <span className="text-[15px] text-th-text-primary font-medium leading-relaxed">
        {value}
      </span>
    </div>
  );
}

// ─── Shared Track Row ────────────────────────────────────────────────────────

function TrackRow({
  track,
  isActive,
  isPlaying,
  dimmed,
  onClick,
  onRemove,
  isFav,
  onToggleFavorite,
  onArtistClick,
  onAlbumClick,
}: {
  track: Track;
  isActive: boolean;
  isPlaying: boolean;
  dimmed?: boolean;
  onClick: () => void;
  onRemove?: () => void;
  isFav?: boolean;
  onToggleFavorite?: () => void;
  onArtistClick?: (artist: ArtistInfo) => void;
  onAlbumClick?: () => void;
}) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const dotsBtnRef = useRef<HTMLButtonElement | null>(null);
  const [dotsMenuOpen, setDotsMenuOpen] = useState(false);

  return (
    <>
      <div
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setContextMenu({ x: e.clientX, y: e.clientY });
        }}
        className={`flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer group transition-[background-color] duration-150 ${
          isActive ? "bg-th-hl-med" : "hover:bg-th-hl-faint"
        } ${dimmed ? "opacity-50" : ""}`}
      >
        <div className="w-10 h-10 rounded bg-th-surface-hover overflow-hidden shrink-0 relative">
          <TidalImage
            src={getTidalImageUrl(track.album?.cover, 80)}
            alt={track.title}
            className="w-full h-full"
          />
          {isActive && isPlaying && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
              <div className="flex items-end gap-[2px] h-3.5">
                <span className="w-[2px] h-full bg-th-accent rounded-full playing-bar" />
                <span
                  className="w-[2px] h-full bg-th-accent rounded-full playing-bar"
                  style={{ animationDelay: "0.2s" }}
                />
                <span
                  className="w-[2px] h-full bg-th-accent rounded-full playing-bar"
                  style={{ animationDelay: "0.4s" }}
                />
              </div>
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p
            className={`text-[13px] font-medium truncate ${
              isActive ? "text-th-accent" : "text-th-text-primary"
            }`}
          >
            {getTrackDisplayTitle(track)}
          </p>
          <p className="text-[11px] text-th-text-muted truncate">
            <TrackArtists
              artists={track.artists}
              artist={track.artist}
              className={
                onArtistClick
                  ? "hover:text-th-text-primary hover:underline cursor-pointer"
                  : ""
              }
              onArtistClick={onArtistClick}
            />
            {track.album?.title && (
              <>
                <span className="mx-1">&middot;</span>
                <span
                  className={
                    onAlbumClick
                      ? "hover:text-th-text-primary hover:underline cursor-pointer"
                      : ""
                  }
                  onClick={
                    onAlbumClick
                      ? (e) => {
                          e.stopPropagation();
                          onAlbumClick();
                        }
                      : undefined
                  }
                >
                  {track.album.title}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {/* Three dots menu */}
          <button
            ref={dotsBtnRef}
            onClick={(e) => {
              e.stopPropagation();
              setDotsMenuOpen(true);
            }}
            className="w-7 h-7 rounded-full flex items-center justify-center text-th-text-disabled hover:text-th-text-primary hover:bg-th-border-subtle transition-colors duration-150"
            title="More options"
          >
            <MoreHorizontal size={15} />
          </button>

          {/* Heart / favorite */}
          {onToggleFavorite && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite();
              }}
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-th-border-subtle transition-colors duration-150"
              title={isFav ? "Remove from Loved tracks" : "Add to Loved tracks"}
            >
              <Heart
                size={15}
                className={
                  isFav
                    ? "text-th-accent"
                    : "text-th-text-disabled hover:text-th-text-primary"
                }
                fill={isFav ? "currentColor" : "none"}
              />
            </button>
          )}

          {onRemove && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              className="w-7 h-7 rounded-full flex items-center justify-center text-th-text-disabled hover:text-th-text-primary hover:bg-th-border-subtle transition-colors duration-150"
              title="Remove"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Context menu (right-click) */}
      {contextMenu && (
        <TrackContextMenu
          track={track}
          index={0}
          anchorRef={
            { current: null } as React.RefObject<HTMLButtonElement | null>
          }
          cursorPosition={contextMenu}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Context menu (dots button) */}
      {dotsMenuOpen && (
        <TrackContextMenu
          track={track}
          index={0}
          anchorRef={dotsBtnRef}
          onClose={() => setDotsMenuOpen(false)}
        />
      )}
    </>
  );
}

// ─── Queue Tab Wrapper (owns the scroll container ref for virtualization) ────

function QueueTabWrapper() {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  return (
    <div
      ref={setScrollEl}
      className="absolute inset-0 overflow-y-auto px-6 py-4 scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent"
    >
      {scrollEl && <QueueTab scrollEl={scrollEl} />}
    </div>
  );
}

// ─── Main Drawer ─────────────────────────────────────────────────────────────

export default function NowPlayingDrawer() {
  const currentTrack = useAtomValue(currentTrackAtom);
  const { drawerOpen, setDrawerOpen, drawerTab, setDrawerTab } = useDrawer();
  const setMaximized = useSetAtom(maximizedPlayerAtom);
  const activeTab = (drawerTab || "queue") as TabId;
  const setActiveTab = (tab: TabId) => setDrawerTab(tab);

  const vibrantColor = currentTrack?.album?.vibrantColor;

  const overlayGradient = useMemo(() => {
    if (!vibrantColor) return "none";
    const hex = vibrantColor.replace(/^#/, "");
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return "none";
    return `linear-gradient(rgba(${r}, ${g}, ${b}, 0.28) 0%, rgba(${r}, ${g}, ${b}, 0) 90%)`;
  }, [vibrantColor]);

  // Don't render anything until there's a track to show
  if (!currentTrack) return null;

  return (
    <div
      className={`fixed inset-0 bottom-[90px] z-40 flex flex-col transition-[visibility] ${
        drawerOpen ? "visible" : "invisible delay-200"
      }`}
    >
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/80 transition-opacity duration-200 ${
          drawerOpen ? "opacity-100" : "opacity-0"
        }`}
        onClick={() => setDrawerOpen(false)}
      />

      {/* Drawer content — GPU-promoted layer for smooth animation */}
      <div
        className="relative z-10 flex-1 flex overflow-hidden bg-th-base"
        style={{
          transform: drawerOpen
            ? "translate3d(0,0,0)"
            : "translate3d(0,100%,0)",
          transition: "transform 250ms cubic-bezier(0.32, 0.72, 0, 1)",
          willChange: "transform",
          backfaceVisibility: "hidden",
        }}
      >
        {/* Gradient overlay from dominant album color (adaptive brightness) */}
        <div
          className="absolute inset-0 pointer-events-none z-0"
          style={{
            backgroundImage: overlayGradient,
            transition: "background-image 1000ms ease-in-out",
          }}
        />

        {/* Left: Album Art — 45% */}
        <div className="relative z-[1] w-[45%] flex flex-col items-center justify-center p-10 gap-6">
          <div className="w-full max-w-[640px] aspect-square rounded-lg overflow-hidden shadow-2xl shadow-black/60">
            <TidalImage
              src={getTidalImageUrl(currentTrack.album?.cover, 640)}
              alt={currentTrack.album?.title || currentTrack.title}
              className="w-full h-full"
            />
          </div>
          <div className="text-center w-full max-w-[520px]">
            <h2 className="text-[22px] font-bold text-th-text-primary truncate">
              {getTrackDisplayTitle(currentTrack)}
            </h2>
            <p className="text-[15px] text-th-text-muted truncate mt-1">
              {getTrackArtistDisplay(currentTrack)}
            </p>
          </div>
        </div>

        {/* Right: Tabs — 55% */}
        <div className="relative z-[1] w-[55%] flex flex-col min-w-0 border-l border-th-border-subtle">
          {/* Tab bar + close */}
          <div className="flex items-center justify-between px-6 pt-5 pb-2">
            <div className="flex items-center gap-1 flex-wrap">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium transition-colors duration-150 ${
                    activeTab === tab.id
                      ? "bg-th-hl-strong text-th-text-primary"
                      : "text-th-text-muted hover:text-th-text-primary hover:bg-th-hl-faint"
                  }`}
                >
                  <tab.icon size={14} />
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 shrink-0 ml-2">
              <button
                onClick={() => setMaximized(true)}
                className="w-8 h-8 rounded-full flex items-center justify-center text-th-text-muted hover:text-th-text-primary hover:bg-th-hl-med transition-colors duration-150"
                title="Fullscreen player"
              >
                <Maximize2 size={18} />
              </button>
              <button
                onClick={() => setDrawerOpen(false)}
                className="w-8 h-8 rounded-full flex items-center justify-center text-th-text-muted hover:text-th-text-primary hover:bg-th-hl-med transition-colors duration-150"
              >
                <X size={18} />
              </button>
            </div>
          </div>

          {/* Tab content — only active tab mounted (Vaul pattern: always mounted, CSS-controlled visibility) */}
          <div className="flex-1 overflow-hidden relative">
            {activeTab === "queue" && <QueueTabWrapper />}
            {activeTab === "suggested" && (
              <div className="absolute inset-0 overflow-y-auto px-6 py-4 scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent">
                <SuggestedTab />
              </div>
            )}
            {activeTab === "lyrics" && (
              <div className="absolute inset-0 overflow-y-auto pl-6 py-4 scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent">
                <LyricsTab />
              </div>
            )}
            {activeTab === "credits" && (
              <div className="absolute inset-0 overflow-y-auto px-6 py-4 scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent">
                <CreditsTab />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
