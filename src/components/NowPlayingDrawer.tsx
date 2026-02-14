import {
  X,
  ListMusic,
  Sparkles,
  Mic2,
  Users,
  Music,
  Loader2,
  Play,
  Heart,
  MoreHorizontal,
  ListPlus,
  GripVertical,
} from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePlayback } from "../hooks/usePlayback";
import { useDrawer } from "../hooks/useDrawer";
import { useFavorites } from "../hooks/useFavorites";
import { useNavigation } from "../hooks/useNavigation";
import { useToast } from "../contexts/ToastContext";
import { getTrackRadio, getTrackLyrics, getTrackCredits } from "../api/tidal";
import {
  getTidalImageUrl,
  type Track,
  type Lyrics,
  type Credit,
} from "../types";
import TidalImage from "./TidalImage";
import TrackContextMenu from "./TrackContextMenu";

type TabId = "queue" | "suggested" | "lyrics" | "credits";

const TABS: { id: TabId; label: string; icon: typeof ListMusic }[] = [
  { id: "queue", label: "Play queue", icon: ListMusic },
  { id: "suggested", label: "Suggested tracks", icon: Sparkles },
  { id: "lyrics", label: "Lyrics", icon: Mic2 },
  { id: "credits", label: "Credits", icon: Users },
];

// ─── Queue Tab ───────────────────────────────────────────────────────────────

function QueueTab() {
  const {
    currentTrack,
    queue,
    history,
    isPlaying,
    playTrack,
    setQueueTracks,
    removeFromQueue,
  } = usePlayback();
  const { favoriteTrackIds, addFavoriteTrack, removeFavoriteTrack } =
    useFavorites();
  const { navigateToArtist, navigateToAlbum } = useNavigation();
  const { setDrawerOpen } = useDrawer();
  const { showToast } = useToast();

  // Use a ref so drop handler always reads the current source index
  const dragIdxRef = useRef<number | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, idx: number) => {
    dragIdxRef.current = idx;
    setDragIdx(idx);
    // Required for WebKit/Tauri to allow the drag
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
      const sourceIdx = dragIdxRef.current;
      if (sourceIdx === null || sourceIdx === targetIdx) {
        dragIdxRef.current = null;
        setDragIdx(null);
        setDropIdx(null);
        return;
      }
      const reordered = [...queue];
      const [moved] = reordered.splice(sourceIdx, 1);
      reordered.splice(targetIdx, 0, moved);
      setQueueTracks(reordered);
      dragIdxRef.current = null;
      setDragIdx(null);
      setDropIdx(null);
    },
    [queue, setQueueTracks]
  );

  const handleDragEnd = useCallback(() => {
    dragIdxRef.current = null;
    setDragIdx(null);
    setDropIdx(null);
  }, []);

  const handleToggleFavorite = useCallback(
    async (trackId: number) => {
      const isFav = favoriteTrackIds.has(trackId);
      try {
        if (isFav) {
          await removeFavoriteTrack(trackId);
          showToast("Removed from Loved tracks");
        } else {
          await addFavoriteTrack(trackId);
          showToast("Added to Loved tracks");
        }
      } catch {
        showToast("Failed to update Loved tracks", "error");
      }
    },
    [favoriteTrackIds, addFavoriteTrack, removeFavoriteTrack, showToast]
  );

  const handleArtistClick = useCallback(
    (track: Track) => {
      if (track.artist?.id) {
        setDrawerOpen(false);
        navigateToArtist(track.artist.id, {
          name: track.artist.name,
          picture: track.artist.picture,
        });
      }
    },
    [navigateToArtist, setDrawerOpen]
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
    [navigateToAlbum, setDrawerOpen]
  );

  /** Shared props builder for TrackRow to avoid repetition */
  const trackRowNav = useCallback(
    (track: Track) => ({
      isFav: favoriteTrackIds.has(track.id),
      onToggleFavorite: () => handleToggleFavorite(track.id),
      onArtistClick: track.artist?.id
        ? () => handleArtistClick(track)
        : undefined,
      onAlbumClick: track.album?.id ? () => handleAlbumClick(track) : undefined,
    }),
    [
      favoriteTrackIds,
      handleToggleFavorite,
      handleArtistClick,
      handleAlbumClick,
    ]
  );

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

      {/* Next Up — draggable */}
      {queue.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[13px] font-bold text-th-text-muted uppercase tracking-wider">
              Next up
            </h3>
            <button
              onClick={() => setQueueTracks([])}
              className="text-[11px] text-th-text-muted hover:text-white transition-colors"
            >
              Clear
            </button>
          </div>
          <div className="flex flex-col">
            {queue.map((track, i) => {
              const isDragged = dragIdx === i;
              const showDropAbove =
                dragIdx !== null && dropIdx === i && dragIdx > i;
              const showDropBelow =
                dragIdx !== null && dropIdx === i && dragIdx < i;

              return (
                <div
                  key={`queue-${track.id}-${i}`}
                  draggable
                  onDragStart={(e) => handleDragStart(e, i)}
                  onDragOver={(e) => handleDragOver(e, i)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, i)}
                  onDragEnd={handleDragEnd}
                  className={`relative flex items-center gap-1 rounded-md transition-opacity duration-150 ${
                    isDragged ? "opacity-30" : "opacity-100"
                  }`}
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
                      onClick={() => {
                        const remaining = queue.slice(i + 1);
                        setQueueTracks(remaining);
                        playTrack(track);
                      }}
                      onRemove={() => removeFromQueue(i)}
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

      {queue.length === 0 && !currentTrack && (
        <div className="flex flex-col items-center justify-center py-16 text-th-text-disabled">
          <Music size={40} className="mb-3" />
          <p className="text-sm">Queue is empty</p>
        </div>
      )}
    </div>
  );
}

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
  onToggleFavorite: (trackId: number, isFav: boolean) => void;
  onArtistClick?: (track: Track) => void;
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
    [track, onAddToQueue]
  );

  const handlePlayClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onPlay(track);
    },
    [track, onPlay]
  );

  const handleToggleFavorite = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleFavorite(track.id, isFav);
    },
    [track.id, isFav, onToggleFavorite]
  );

  const handleAddToQueue = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onAddToQueue(track);
    },
    [track, onAddToQueue]
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
          isActive ? "bg-white/[0.08]" : "hover:bg-white/[0.05]"
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
              isActive ? "text-th-accent" : "text-white"
            }`}
          >
            {track.title}
          </p>
          <p className="text-[11px] text-th-text-muted truncate">
            {track.artist?.name ? (
              <span
                className="hover:text-white hover:underline cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  onArtistClick?.(track);
                }}
              >
                {track.artist.name}
              </span>
            ) : (
              "Unknown Artist"
            )}
            {track.album?.title && (
              <>
                <span className="mx-1">&middot;</span>
                <span
                  className="hover:text-white hover:underline cursor-pointer"
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
            className="w-7 h-7 rounded-full flex items-center justify-center text-th-text-disabled hover:text-white hover:bg-th-border-subtle transition-colors duration-150"
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
                isFav ? "text-th-accent" : "text-th-text-disabled hover:text-white"
              }
              fill={isFav ? "currentColor" : "none"}
            />
          </button>

          {/* Add to queue */}
          <button
            onClick={handleAddToQueue}
            className="w-7 h-7 rounded-full flex items-center justify-center text-th-text-disabled hover:text-white hover:bg-th-border-subtle transition-colors duration-150"
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

function SuggestedTab() {
  const { currentTrack, playTrack, addToQueue } = usePlayback();
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

    getTrackRadio(currentTrack.id, 20)
      .then((result) => {
        if (active) setTracks(result);
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

  // Stable callbacks passed to every row — hooks called once here, not per row
  const handleAddToQueue = useCallback(
    (track: Track) => {
      addToQueue(track);
      const label =
        track.title.length > 30 ? track.title.slice(0, 28) + "…" : track.title;
      showToast(`Added "${label}" to queue`, "success");
    },
    [addToQueue, showToast]
  );

  const handleToggleFavorite = useCallback(
    async (trackId: number, currentlyFav: boolean) => {
      try {
        if (currentlyFav) {
          await removeFavoriteTrack(trackId);
          showToast("Removed from Loved tracks");
        } else {
          await addFavoriteTrack(trackId);
          showToast("Added to Loved tracks");
        }
      } catch {
        showToast("Failed to update Loved tracks", "error");
      }
    },
    [addFavoriteTrack, removeFavoriteTrack, showToast]
  );

  const handleArtistClick = useCallback(
    (track: Track) => {
      if (track.artist?.id) {
        setDrawerOpen(false);
        navigateToArtist(track.artist.id, {
          name: track.artist.name,
          picture: track.artist.picture,
        });
      }
    },
    [navigateToArtist, setDrawerOpen]
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
    [navigateToAlbum, setDrawerOpen]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={24} className="animate-spin text-th-accent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-th-text-disabled">
        <Sparkles size={40} className="mb-3" />
        <p className="text-sm">Suggested tracks not available</p>
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
}

// ─── Lyrics helpers ──────────────────────────────────────────────────────────

interface LrcLine {
  time: number; // seconds
  text: string;
}

function parseTimestamp(tag: string): number {
  // Parse [mm:ss], [mm:ss.xx], [mm:ss.xxx], [mm:ss:xx]
  const m = tag.match(/(\d{1,2}):(\d{2})(?:[.:]([\d]{1,3}))?/);
  if (!m) return 0;
  const mins = parseInt(m[1], 10);
  const secs = parseInt(m[2], 10);
  let ms = 0;
  if (m[3]) {
    ms =
      m[3].length === 1
        ? parseInt(m[3], 10) * 100
        : m[3].length === 2
        ? parseInt(m[3], 10) * 10
        : parseInt(m[3], 10);
  }
  return mins * 60 + secs + ms / 1000;
}

function parseLrc(subtitles: string): LrcLine[] {
  const lines: LrcLine[] = [];
  // Split into lines and process each
  for (const raw of subtitles.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    // Extract all [mm:ss.xx] timestamps from the line
    const timestamps: number[] = [];
    const stripped = line.replace(
      /\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]/g,
      (_match, tag) => {
        timestamps.push(parseTimestamp(tag));
        return "";
      }
    );

    const text = stripped.trim();
    if (!text || timestamps.length === 0) continue;

    // A line can have multiple timestamps (repeated lyrics)
    for (const time of timestamps) {
      lines.push({ time, text });
    }
  }

  // Sort by time
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

// ─── Lyrics Tab ──────────────────────────────────────────────────────────────

function LyricsTab() {
  const { currentTrack, isPlaying, getPlaybackPosition } = usePlayback();
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
    undefined
  );

  // Fetch lyrics
  useEffect(() => {
    if (!currentTrack) return;

    let active = true;
    setLoading(true);
    setError(null);
    setLyrics(null);
    setLrcLines([]);
    setActiveLine(-1);
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
      // Reset the flag if user stops scrolling for a while (debounce)
      clearTimeout(scrollTimeout.current);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [lrcLines]);

  // Sync active line with playback position
  useEffect(() => {
    if (lrcLines.length === 0 || !isPlaying) return;

    const sync = async () => {
      const pos = await getPlaybackPosition();
      let idx = -1;
      for (let i = lrcLines.length - 1; i >= 0; i--) {
        if (pos >= lrcLines[i].time) {
          idx = i;
          break;
        }
      }
      setActiveLine(idx);
    };

    sync();
    const interval = setInterval(sync, 300);
    return () => clearInterval(interval);
  }, [lrcLines, isPlaying, getPlaybackPosition]);

  // Auto-scroll to active line (only if user hasn't scrolled)
  const scrollToLine = useCallback((idx: number) => {
    const el = lineRefs.current[idx];
    const container = containerRef.current;
    if (!el || !container) return;

    isAutoScrolling.current = true;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Give the smooth scroll time to finish before re-enabling user detection
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={24} className="animate-spin text-th-accent" />
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
    lineRefs.current = [];
    return (
      <div className="relative h-full">
        <div
          ref={containerRef}
          className="h-full overflow-y-auto flex flex-col gap-3 py-10 px-2 scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent"
          dir={lyrics?.isRightToLeft ? "rtl" : "ltr"}
        >
          {lrcLines.map((line, i) => {
            const isActive = i === activeLine;
            const isPast = activeLine >= 0 && i < activeLine;
            return (
              <p
                key={i}
                ref={(el) => {
                  lineRefs.current[i] = el;
                }}
                className={`text-[18px] font-medium cursor-default leading-snug origin-left transition-[transform,color,opacity] duration-500 ease-out ${
                  isActive
                    ? "scale-[1.22] font-bold text-white"
                    : isPast
                    ? "text-th-text-disabled"
                    : "text-th-text-faint"
                }`}
                style={isActive ? { willChange: "transform" } : undefined}
              >
                {line.text}
              </p>
            );
          })}
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
            className="absolute bottom-4 right-4 flex items-center gap-2 px-4 py-2.5 bg-th-accent text-black text-[12px] font-bold rounded-full shadow-lg shadow-black/40 hover:brightness-110 active:scale-95 transition-[filter,transform] duration-150 animate-fadeIn"
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
}

// ─── Credits Tab ─────────────────────────────────────────────────────────────

function CreditsTab() {
  const { currentTrack } = usePlayback();
  const [credits, setCredits] = useState<Credit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentTrack) return;

    let active = true;
    setLoading(true);
    setError(null);
    setCredits([]);

    getTrackCredits(currentTrack.id)
      .then((result) => {
        if (active) setCredits(result);
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={24} className="animate-spin text-th-accent" />
      </div>
    );
  }

  if (error || credits.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-th-text-disabled">
        <Users size={40} className="mb-3" />
        <p className="text-sm">No credits available for this track</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Track metadata header */}
      {currentTrack && (
        <div className="flex flex-col gap-4 pb-4 mb-2 border-b border-th-border-subtle">
          <MetaRow label="Title" value={currentTrack.title} />
          <MetaRow
            label="Artist"
            value={currentTrack.artist?.name || "Unknown"}
          />
          {currentTrack.album?.title && (
            <MetaRow label="Album" value={currentTrack.album.title} />
          )}
        </div>
      )}

      {/* Credit roles */}
      {credits.map((credit, i) => (
        <div
          key={`${credit.creditType}-${i}`}
          className="flex flex-col gap-1 py-2.5 border-b border-white/[0.04] last:border-0"
        >
          <span className="text-[11px] font-bold text-th-text-faint uppercase tracking-widest">
            {credit.creditType}
          </span>
          <span className="text-[14px] text-white/90 leading-relaxed">
            {credit.contributors.map((c) => c.name).join(", ")}
          </span>
        </div>
      ))}
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-bold text-th-text-faint uppercase tracking-widest">
        {label}
      </span>
      <span className="text-[15px] text-white font-medium">{value}</span>
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
  onArtistClick?: () => void;
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
          isActive ? "bg-white/[0.08]" : "hover:bg-white/[0.05]"
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
              isActive ? "text-th-accent" : "text-white"
            }`}
          >
            {track.title}
          </p>
          <p className="text-[11px] text-th-text-muted truncate">
            {track.artist?.name ? (
              <span
                className={
                  onArtistClick
                    ? "hover:text-white hover:underline cursor-pointer"
                    : ""
                }
                onClick={
                  onArtistClick
                    ? (e) => {
                        e.stopPropagation();
                        onArtistClick();
                      }
                    : undefined
                }
              >
                {track.artist.name}
              </span>
            ) : (
              "Unknown Artist"
            )}
            {track.album?.title && (
              <>
                <span className="mx-1">&middot;</span>
                <span
                  className={
                    onAlbumClick
                      ? "hover:text-white hover:underline cursor-pointer"
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
            className="w-7 h-7 rounded-full flex items-center justify-center text-th-text-disabled hover:text-white hover:bg-th-border-subtle transition-colors duration-150"
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
                  isFav ? "text-th-accent" : "text-th-text-disabled hover:text-white"
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
              className="w-7 h-7 rounded-full flex items-center justify-center text-th-text-disabled hover:text-white hover:bg-th-border-subtle transition-colors duration-150"
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

// ─── Main Drawer ─────────────────────────────────────────────────────────────

/** Extract the average color from an image URL via fetch + canvas. */
function useDominantColor(imageUrl: string | undefined) {
  const [color, setColor] = useState<string | null>(null);
  const prevUrl = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!imageUrl) {
      setColor(null);
      return;
    }
    if (imageUrl === prevUrl.current) return;
    prevUrl.current = imageUrl;

    console.log("useDominantColor: Processing", imageUrl);
    let cancelled = false;

    // Fetch via Tauri backend to bypass CORS
    invoke<number[]>("get_image_bytes", { url: imageUrl })
      .then((bytes) => {
        if (cancelled) return;
        const u8arr = new Uint8Array(bytes);
        const blob = new Blob([u8arr]);
        const blobUrl = URL.createObjectURL(blob);

        const img = new Image();
        img.onload = () => {
          try {
            const size = 50;
            const canvas = document.createElement("canvas");
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
              console.error("useDominantColor: No 2d context");
              return;
            }

            // Draw the image scaled down
            ctx.drawImage(img, 0, 0, size, size);

            const imageData = ctx.getImageData(0, 0, size, size).data;
            const colorCounts: Record<string, number> = {};
            let maxCount = 0;
            let dominantColor = "0, 0, 0";

            // Quantize colors to group similar shades
            const quantization = 10;

            for (let i = 0; i < imageData.length; i += 4) {
              const r = imageData[i];
              const g = imageData[i + 1];
              const b = imageData[i + 2];
              const a = imageData[i + 3];

              // Skip transparent pixels
              if (a < 128) continue;

              const qr = Math.floor(r / quantization) * quantization;
              const qg = Math.floor(g / quantization) * quantization;
              const qb = Math.floor(b / quantization) * quantization;

              const key = `${qr},${qg},${qb}`;
              colorCounts[key] = (colorCounts[key] || 0) + 1;

              if (colorCounts[key] > maxCount) {
                maxCount = colorCounts[key];
                dominantColor = `${qr}, ${qg}, ${qb}`;
              }
            }

            console.log(
              "useDominantColor: Found dominant color",
              dominantColor
            );
            if (!cancelled) {
              setColor(dominantColor);
            }
          } catch (e) {
            console.error("useDominantColor: Canvas error", e);
          } finally {
            URL.revokeObjectURL(blobUrl);
          }
        };
        img.onerror = (e) => {
          console.error("useDominantColor: Image load error", e);
          URL.revokeObjectURL(blobUrl);
        };
        img.src = blobUrl;
      })
      .catch((e) => {
        console.error("useDominantColor: Tauri fetch error", e);
      });

    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  return color;
}

export default function NowPlayingDrawer() {
  const { currentTrack } = usePlayback();
  const { drawerOpen, setDrawerOpen, drawerTab, setDrawerTab } = useDrawer();
  const activeTab = (drawerTab || "queue") as TabId;
  const setActiveTab = (tab: TabId) => setDrawerTab(tab);

  const coverUrl = currentTrack
    ? getTidalImageUrl(currentTrack.album?.cover, 80)
    : undefined;
  const dominantColor = useDominantColor(coverUrl);

  // Close on Escape
  useEffect(() => {
    if (!drawerOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [drawerOpen, setDrawerOpen]);

  if (!drawerOpen || !currentTrack) return null;

  return (
    <div className="fixed inset-0 bottom-[90px] z-40 flex flex-col">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/80"
        onClick={() => setDrawerOpen(false)}
      />

      {/* Drawer content */}
      <div className="relative z-10 flex-1 flex overflow-hidden bg-th-base animate-slideUp">
        {/* Gradient overlay from dominant album color */}
        <div
          className="absolute inset-0 pointer-events-none z-0 transition-colors duration-1000 ease-in-out"
          style={{
            backgroundColor: dominantColor
              ? `rgba(${dominantColor}, 0.50)`
              : "transparent",
            maskImage: `linear-gradient(to bottom, black 0%, rgba(0, 0, 0, 0.05) 60%, transparent 70%)`,
            WebkitMaskImage: `linear-gradient(to bottom, black 0%, rgba(0, 0, 0, 0.05) 60%, transparent 70%)`,
          }}
        />

        {/* Left: Album Art — 40% */}
        <div className="relative z-[1] w-[40%] flex flex-col items-center justify-center p-10 gap-6">
          <div className="w-full max-w-[380px] aspect-square rounded-lg overflow-hidden shadow-2xl shadow-black/60">
            <TidalImage
              src={getTidalImageUrl(currentTrack.album?.cover, 640)}
              alt={currentTrack.album?.title || currentTrack.title}
              className="w-full h-full"
            />
          </div>
          <div className="text-center w-full max-w-[380px]">
            <h2 className="text-[22px] font-bold text-white truncate">
              {currentTrack.title}
            </h2>
            <p className="text-[15px] text-th-text-muted truncate mt-1">
              {currentTrack.artist?.name || "Unknown Artist"}
            </p>
          </div>
        </div>

        {/* Right: Tabs — 60% */}
        <div className="relative z-[1] w-[60%] flex flex-col min-w-0 border-l border-th-border-subtle">
          {/* Tab bar + close */}
          <div className="flex items-center justify-between px-6 pt-5 pb-2">
            <div className="flex items-center gap-1 flex-wrap">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium transition-colors duration-150 ${
                    activeTab === tab.id
                      ? "bg-white/12 text-white"
                      : "text-th-text-muted hover:text-white hover:bg-white/5"
                  }`}
                >
                  <tab.icon size={14} />
                  {tab.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => setDrawerOpen(false)}
              className="w-8 h-8 rounded-full flex items-center justify-center text-th-text-muted hover:text-white hover:bg-white/8 transition-colors duration-150 shrink-0 ml-2"
            >
              <X size={18} />
            </button>
          </div>

          {/* Tab content — all tabs stay mounted to preserve state; inactive ones are hidden */}
          <div className="flex-1 overflow-hidden relative">
            <div
              className={`absolute inset-0 overflow-y-auto px-6 py-4 scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent ${
                activeTab === "queue" ? "" : "hidden"
              }`}
            >
              <QueueTab />
            </div>
            <div
              className={`absolute inset-0 overflow-y-auto px-6 py-4 scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent ${
                activeTab === "suggested" ? "" : "hidden"
              }`}
            >
              <SuggestedTab />
            </div>
            <div
              className={`absolute inset-0 overflow-y-auto px-6 py-4 scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent ${
                activeTab === "lyrics" ? "" : "hidden"
              }`}
            >
              <LyricsTab />
            </div>
            <div
              className={`absolute inset-0 overflow-y-auto px-6 py-4 scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent ${
                activeTab === "credits" ? "" : "hidden"
              }`}
            >
              <CreditsTab />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
