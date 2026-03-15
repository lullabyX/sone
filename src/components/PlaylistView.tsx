import {
  Play,
  Pause,
  Music,
  X,
  Shuffle,
  Heart,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
  startTransition,
} from "react";
import { useStore } from "jotai";
import {
  isPlayingAtom,
  currentTrackAtom,
  shuffleAtom,
} from "../atoms/playback";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useFavorites } from "../hooks/useFavorites";
import { usePlaylists } from "../hooks/usePlaylists";
import { useToast } from "../contexts/ToastContext";
import { getPlaylistTracksPage, getPlaylistRecommendations, invalidateCache, getPlaylistDetails } from "../api/tidal";
import { getTidalImageUrl, type Track } from "../types";
import TidalImage from "./TidalImage";
import TrackList from "./TrackList";
import MediaContextMenu from "./MediaContextMenu";
import DebouncedFilterInput from "./DebouncedFilterInput";
import PageContainer from "./PageContainer";
import { DetailPageSkeleton } from "./PageSkeleton";

interface PlaylistViewProps {
  playlistId: string;
  playlistInfo?: {
    title: string;
    image?: string;
    description?: string;
    creatorName?: string;
    numberOfTracks?: number;
    isUserPlaylist?: boolean;
  };
  onBack: () => void;
}

export default function PlaylistView({
  playlistId,
  playlistInfo,
  onBack,
}: PlaylistViewProps) {
  const store = useStore();
  const {
    playTrack,
    setQueueTracks,
    pauseTrack,
    resumeTrack,
    setShuffledQueue,
    playFromSource,
    playAllFromSource,
  } = usePlaybackActions();

  const PAGE_SIZE = 100;

  const [allTracks, setAllTracks] = useState<Track[]>([]);
  const [totalTracks, setTotalTracks] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedInfo, setFetchedInfo] = useState<typeof playlistInfo>(undefined);

  // Fetch playlist metadata when playlistInfo is not provided (e.g. deep link)
  useEffect(() => {
    if (playlistInfo) return;
    getPlaylistDetails(playlistId)
      .then((p) =>
        setFetchedInfo({
          title: p.title,
          image: p.squareImage || p.image,
          description: p.description,
          creatorName: p.creator?.name,
          numberOfTracks: p.numberOfTracks,
        }),
      )
      .catch(() => {});
  }, [playlistId, playlistInfo]);

  const effectiveInfo = playlistInfo || fetchedInfo;

  const offsetRef = useRef(0);
  const hasMoreRef = useRef(true);
  const bgFetchingRef = useRef(false);
  const cancelledRef = useRef(false);
  const allTracksRef = useRef<Track[]>([]);

  // Recommendations state
  const RECS_BATCH = 50;
  const RECS_PAGE = 10;
  const [recPool, setRecPool] = useState<Track[]>([]);
  const [recPageIndex, setRecPageIndex] = useState(0);
  const [recApiOffset, setRecApiOffset] = useState(0);
  const [loadingRecs, setLoadingRecs] = useState(false);
  const { addTrackToPlaylist } = usePlaylists();
  const { showToast } = useToast();

  useEffect(() => {
    allTracksRef.current = allTracks;
  }, [allTracks]);

  // Fetch a batch of recommendations
  const fetchRecBatch = useCallback(async (offset: number) => {
    setLoadingRecs(true);
    try {
      const res = await getPlaylistRecommendations(playlistId, offset, RECS_BATCH);
      return res.items;
    } catch {
      return [];
    } finally {
      setLoadingRecs(false);
    }
  }, [playlistId]);

  // Current slice of recommendations to display
  const visibleRecs = useMemo(
    () => recPool.slice(recPageIndex * RECS_PAGE, (recPageIndex + 1) * RECS_PAGE),
    [recPool, recPageIndex],
  );

  const handleRefreshRecs = useCallback(async () => {
    const nextPage = recPageIndex + 1;
    const nextStart = nextPage * RECS_PAGE;
    if (nextStart < recPool.length) {
      // Still have cached tracks
      setRecPageIndex(nextPage);
    } else {
      // Exhausted current batch — fetch next from API
      const newOffset = recApiOffset + RECS_BATCH;
      invalidateCache(`playlist-recs:${playlistId}`);
      const newTracks = await fetchRecBatch(newOffset);
      if (newTracks.length > 0) {
        setRecPool(newTracks);
        setRecApiOffset(newOffset);
        setRecPageIndex(0);
      } else {
        // API returned empty — wrap around to beginning
        const freshTracks = await fetchRecBatch(0);
        setRecPool(freshTracks);
        setRecApiOffset(0);
        setRecPageIndex(0);
      }
    }
  }, [recPageIndex, recPool.length, recApiOffset, playlistId, fetchRecBatch]);

  const handleAddRecToPlaylist = useCallback(async (track: Track) => {
    // Optimistic: remove from recs immediately
    setRecPool((prev) => prev.filter((t) => t.id !== track.id));
    try {
      await addTrackToPlaylist(playlistId, track.id);
      showToast(`Added "${track.title}" to playlist`, "success");
    } catch {
      // Rollback: re-insert the track
      setRecPool((prev) => {
        if (prev.some((t) => t.id === track.id)) return prev;
        return [...prev, track];
      });
      showToast("Failed to add track", "error");
    }
  }, [playlistId, addTrackToPlaylist, showToast]);

  // Load first page only
  useEffect(() => {
    cancelledRef.current = false;
    bgFetchingRef.current = false;

    const loadFirstPage = async () => {
      setLoading(true);
      setError(null);
      setAllTracks([]);
      offsetRef.current = 0;
      hasMoreRef.current = true;

      try {
        const firstPage = await getPlaylistTracksPage(playlistId, 0, PAGE_SIZE);
        if (cancelledRef.current) return;

        setAllTracks(firstPage.items);
        setTotalTracks(firstPage.totalNumberOfItems);
        offsetRef.current = firstPage.items.length;
        hasMoreRef.current =
          firstPage.items.length < firstPage.totalNumberOfItems;
      } catch (err: any) {
        if (!cancelledRef.current) {
          console.error("Failed to load playlist:", err);
          setError(err?.message || String(err));
        }
      } finally {
        if (!cancelledRef.current) setLoading(false);
      }
    };

    loadFirstPage();
    return () => {
      cancelledRef.current = true;
    };
  }, [playlistId]);

  // Fetch initial batch of recommendations when playlist changes
  useEffect(() => {
    setRecPool([]);
    setRecPageIndex(0);
    setRecApiOffset(0);
    fetchRecBatch(0).then((tracks) => {
      setRecPool(tracks);
    });
  }, [playlistId, fetchRecBatch]);

  // Fetch all remaining pages in the background
  const fetchRemaining = useCallback(async () => {
    if (bgFetchingRef.current || !hasMoreRef.current) return;

    bgFetchingRef.current = true;
    try {
      while (hasMoreRef.current && !cancelledRef.current) {
        const page = await getPlaylistTracksPage(
          playlistId,
          offsetRef.current,
          PAGE_SIZE,
        );
        if (cancelledRef.current) return;

        startTransition(() => {
          setAllTracks((prev) => {
            const seen = new Set(prev.map((t) => t.id));
            return [...prev, ...page.items.filter((t) => !seen.has(t.id))];
          });
          setTotalTracks(page.totalNumberOfItems);
        });
        offsetRef.current += page.items.length;
        hasMoreRef.current = offsetRef.current < page.totalNumberOfItems;
      }
    } catch (err) {
      console.error("Failed to background-fetch playlist tracks:", err);
    } finally {
      bgFetchingRef.current = false;
    }
  }, [playlistId]);

  // Manual load-more for infinite scroll
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMoreRef.current || bgFetchingRef.current) return;

    setLoadingMore(true);
    try {
      const page = await getPlaylistTracksPage(
        playlistId,
        offsetRef.current,
        PAGE_SIZE,
      );
      setAllTracks((prev) => {
        const seen = new Set(prev.map((t) => t.id));
        return [...prev, ...page.items.filter((t) => !seen.has(t.id))];
      });
      setTotalTracks(page.totalNumberOfItems);
      offsetRef.current += page.items.length;
      hasMoreRef.current = offsetRef.current < page.totalNumberOfItems;
    } catch (err) {
      console.error("Failed to load more playlist tracks:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, playlistId]);

  const tracks = allTracks;
  const hasMore = allTracks.length < totalTracks;

  // Local search / filter (debounce handled inside DebouncedFilterInput)
  const [searchQuery, setSearchQuery] = useState("");
  const isFiltering = searchQuery.trim().length > 0;

  const { filteredTracks, displayNumbers } = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return { filteredTracks: tracks, displayNumbers: undefined };
    const filtered: Track[] = [];
    const numbers: number[] = [];
    tracks.forEach((t, i) => {
      if (
        t.title.toLowerCase().includes(q) ||
        (t.artist?.name?.toLowerCase().includes(q) ||
          t.artists?.some((a) => a.name?.toLowerCase().includes(q))) ||
        t.album?.title?.toLowerCase().includes(q)
      ) {
        filtered.push(t);
        numbers.push(i + 1);
      }
    });
    return { filteredTracks: filtered, displayNumbers: numbers };
  }, [tracks, searchQuery]);

  const handleSearchFocus = useCallback(() => {
    if (hasMoreRef.current && !bgFetchingRef.current) {
      setTimeout(() => fetchRemaining(), 0);
    }
  }, [fetchRemaining]);

  const trackIds = useMemo(
    () => new Set(tracks.map((track) => track.id)),
    [tracks],
  );

  const playlistSource = (allTracks: Track[]) => ({
    type: "playlist" as const,
    id: playlistId,
    name: effectiveInfo?.title || "Playlist",
    image: effectiveInfo?.image,
    allTracks,
  });

  const handlePlayTrack = async (track: Track, _index: number) => {
    try {
      await playFromSource(track, tracks, { source: playlistSource(tracks) });

      // Kick off background fetch for the rest if needed
      if (hasMoreRef.current && !bgFetchingRef.current) {
        await fetchRemaining();
        const full = allTracksRef.current;
        const playedIndex = full.findIndex((t) => t.id === track.id);
        if (playedIndex >= 0) {
          const rest = [
            ...full.slice(playedIndex + 1),
            ...full.slice(0, playedIndex),
          ];
          if (store.get(shuffleAtom)) {
            setShuffledQueue(rest, { source: playlistSource(full) });
          } else {
            setQueueTracks(rest, { source: playlistSource(full) });
          }
        }
      }
    } catch (err) {
      console.error("Failed to play playlist track:", err);
    }
  };

  const handlePlayAll = async () => {
    if (tracks.length === 0) return;

    const currentTrack = store.get(currentTrackAtom);
    const isPlaying = store.get(isPlayingAtom);
    if (currentTrack && trackIds.has(currentTrack.id)) {
      if (isPlaying) {
        await pauseTrack();
      } else {
        await resumeTrack();
      }
      return;
    }

    try {
      await playAllFromSource(tracks, { source: playlistSource(tracks) });

      if (hasMoreRef.current && !bgFetchingRef.current) {
        await fetchRemaining();
        const full = allTracksRef.current;
        const current = store.get(currentTrackAtom);
        if (full.length > 1 && current) {
          const idx = full.findIndex((t) => t.id === current.id);
          const rest =
            idx >= 0
              ? [...full.slice(idx + 1), ...full.slice(0, idx)]
              : full.filter((t) => t.id !== current.id);
          if (store.get(shuffleAtom)) {
            setShuffledQueue(rest, { source: playlistSource(full) });
          } else {
            setQueueTracks(rest, { source: playlistSource(full) });
          }
        }
      }
    } catch (err) {
      console.error("Failed to play playlist:", err);
    }
  };

  const handleShuffle = async () => {
    if (tracks.length === 0) return;

    // If we have more pages, fetch everything first so shuffle includes all tracks
    if (hasMoreRef.current && !bgFetchingRef.current) {
      await fetchRemaining();
    }

    const all = allTracksRef.current.length > 0 ? allTracksRef.current : tracks;
    const firstIdx = Math.floor(Math.random() * all.length);
    const first = all[firstIdx];
    const rest = all.filter((_, i) => i !== firstIdx);
    try {
      setShuffledQueue(rest, { source: playlistSource(all) });
      await playTrack(first);
    } catch (err) {
      console.error("Failed to shuffle play:", err);
    }
  };

  const playlistPlaying = (() => {
    const ct = store.get(currentTrackAtom);
    return !!(ct && trackIds.has(ct.id) && store.get(isPlayingAtom));
  })();

  // Favorite state — driven by atom for instant updates everywhere
  const { favoritePlaylistUuids, addFavoritePlaylist, removeFavoritePlaylist } =
    useFavorites();
  const playlistFavorited = favoritePlaylistUuids.has(playlistId);

  const handleToggleFavorite = async () => {
    try {
      if (playlistFavorited) {
        await removeFavoritePlaylist(playlistId);
      } else {
        await addFavoritePlaylist(playlistId);
      }
    } catch (err) {
      console.error("Failed to toggle playlist favorite:", err);
    }
  };

  // Context menu
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const [showDescriptionModal, setShowDescriptionModal] = useState(false);

  const displayTitle = effectiveInfo?.title || "Playlist";
  const displayDescription = effectiveInfo?.description;
  // Show "You" for user's own playlists, actual creator name for public ones
  const displayCreator = effectiveInfo?.isUserPlaylist
    ? "You"
    : effectiveInfo?.creatorName || undefined;
  const displayTrackCount =
    totalTracks > 0 ? totalTracks : (effectiveInfo?.numberOfTracks ?? 0);

  // Show "Read more" if description is long enough to be truncated
  const descriptionIsLong = (displayDescription?.length ?? 0) > 120;

  if (loading) {
    return <DetailPageSkeleton type="playlist" />;
  }

  if (error) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center px-8">
          <Music size={48} className="text-th-text-disabled" />
          <p className="text-th-text-primary font-semibold text-lg">
            Couldn't load playlist
          </p>
          <p className="text-th-text-muted text-sm max-w-md">{error}</p>
          <button
            onClick={onBack}
            className="mt-2 px-6 py-2 bg-th-text-primary text-th-base rounded-full text-sm font-bold hover:scale-105 transition-transform"
          >
            Go back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-linear-to-b from-th-surface to-th-base overflow-y-auto scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent">
      <PageContainer>
      <div className="px-8 pb-8 pt-8 flex items-end gap-7">
        <div className="w-[232px] h-[232px] shrink-0 rounded-lg overflow-hidden shadow-2xl bg-th-surface-hover flex items-center justify-center">
          {effectiveInfo?.image ? (
            <TidalImage
              src={getTidalImageUrl(effectiveInfo!.image, 640)}
              alt={displayTitle}
              type="playlist"
              className="w-full h-full"
            />
          ) : (
            <Music size={56} className="text-th-text-faint" />
          )}
        </div>
        <div className="flex flex-col gap-2 pb-2 min-w-0">
          <span className="text-[12px] font-bold text-th-text-secondary uppercase tracking-widest">
            Playlist
          </span>
          <h1 className="text-[48px] font-extrabold text-th-text-primary leading-none tracking-tight line-clamp-2">
            {displayTitle}
          </h1>
          {displayDescription && (
            <div className="mt-1 max-w-[800px]">
              <p className="text-[14px] text-th-text-muted line-clamp-2">
                {displayDescription}
              </p>
              {descriptionIsLong && (
                <button
                  onClick={() => setShowDescriptionModal(true)}
                  className="text-[13px] text-th-text-primary font-semibold hover:underline mt-1"
                >
                  Read more
                </button>
              )}
            </div>
          )}
          <div className="flex items-center gap-1.5 text-[14px] text-th-text-muted mt-2">
            {displayCreator && (
              <>
                <span className="text-th-text-primary font-semibold">
                  {displayCreator}
                </span>
                <span className="mx-1">•</span>
              </>
            )}
            <span>
              {displayTrackCount} TRACK{displayTrackCount !== 1 ? "S" : ""}
            </span>
          </div>
        </div>
      </div>

      {/* Play Controls */}
      <div className="px-8 py-5 flex items-center justify-between">
        {/* Left — Play & Shuffle buttons */}
        <div className="flex items-center gap-3">
          <button
            onClick={handlePlayAll}
            className="flex items-center gap-2 px-6 py-2.5 bg-th-accent text-black font-bold text-sm rounded-full shadow-lg hover:brightness-110 hover:scale-[1.03] transition-[transform,filter] duration-150"
          >
            {playlistPlaying ? (
              <Pause size={18} fill="black" className="text-black" />
            ) : (
              <Play size={18} fill="black" className="text-black" />
            )}
            {playlistPlaying ? "Pause" : "Play"}
          </button>
          <button
            onClick={handleShuffle}
            className="flex items-center gap-2 px-6 py-2.5 bg-th-button text-th-text-primary font-bold text-sm rounded-full hover:bg-th-button-hover hover:scale-[1.03] transition-[transform,filter,background-color] duration-150"
          >
            <Shuffle size={18} />
            Shuffle
          </button>
        </div>
        {/* Right — Heart & More icons */}
        <div className="flex items-center gap-2 relative">
          <button
            onClick={handleToggleFavorite}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-[color,filter] duration-150 ${
              playlistFavorited
                ? "text-th-accent hover:brightness-110"
                : "text-th-text-muted hover:text-th-text-primary hover:bg-th-hl-med"
            }`}
            title={
              playlistFavorited ? "Remove from favorites" : "Add to favorites"
            }
          >
            <Heart
              size={20}
              fill={playlistFavorited ? "currentColor" : "none"}
              strokeWidth={playlistFavorited ? 0 : 2}
            />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setContextMenu({ x: e.clientX, y: e.clientY });
            }}
            className="w-10 h-10 rounded-full flex items-center justify-center text-th-text-muted hover:text-th-text-primary hover:bg-th-hl-med transition-colors"
            title="More options"
          >
            <MoreHorizontal size={20} />
          </button>
          {contextMenu && (
            <MediaContextMenu
              cursorPosition={contextMenu}
              item={{
                type: "playlist",
                uuid: playlistId,
                title: displayTitle,
                image: effectiveInfo?.image,
                creatorName: effectiveInfo?.creatorName,
              }}
              onClose={() => setContextMenu(null)}
            />
          )}
        </div>
      </div>

      {/* Search / Filter bar */}
      <div className="px-8 pb-4">
        <DebouncedFilterInput
          placeholder="Filter playlist on title, artist or album"
          onChange={setSearchQuery}
          onFocus={handleSearchFocus}
        />
      </div>

      <div className="px-8 pb-8">
        <TrackList
          tracks={filteredTracks}
          onPlay={handlePlayTrack}
          onLoadMore={isFiltering ? undefined : loadMore}
          hasMore={isFiltering ? false : hasMore}
          loadingMore={isFiltering ? false : loadingMore}
          trackDisplayNumbers={displayNumbers}
          showDateAdded={!!effectiveInfo?.isUserPlaylist}
          showArtist={true}
          showAlbum={true}
          showCover={true}
          context="playlist"
          playlistId={playlistId}
          isUserPlaylist={effectiveInfo?.isUserPlaylist}
          onTrackRemoved={(index) => {
            setAllTracks((prev) => prev.filter((_, i) => i !== index));
          }}
        />

        {/* Recommended Tracks */}
        {tracks.length > 0 && !hasMore && visibleRecs.length > 0 && (
          <div className="mt-10">
            <h2 className="text-[18px] font-bold text-th-text-primary mb-4">
              Recommended Tracks
            </h2>
            <TrackList
              tracks={visibleRecs}
              onPlay={handlePlayTrack}
              showArtist={true}
              showAlbum={true}
              showCover={true}
              context="playlist"
              onAddToCurrentPlaylist={handleAddRecToPlaylist}
            />
            <div className="flex justify-end mt-6">
              <button
                onClick={handleRefreshRecs}
                disabled={loadingRecs}
                className="flex items-center gap-2 px-5 py-2 bg-th-button text-th-text-primary font-semibold text-sm rounded-full hover:bg-th-button-hover hover:scale-[1.03] transition-[transform,background-color] duration-150 disabled:opacity-50"
              >
                <RefreshCw size={16} className={loadingRecs ? "animate-spin" : ""} />
                Refresh suggestions
              </button>
            </div>
          </div>
        )}

        {tracks.length === 0 && (
          <div className="py-16 text-center">
            <Music size={48} className="text-th-text-disabled mx-auto mb-4" />
            <p className="text-th-text-primary font-semibold text-lg mb-2">
              This playlist is empty
            </p>
            <p className="text-th-text-muted text-sm">
              Add tracks in TIDAL to see them here.
            </p>
          </div>
        )}
      </div>

      </PageContainer>

      {/* Description Modal */}
      {showDescriptionModal && displayDescription && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowDescriptionModal(false)}
        >
          <div
            className="bg-th-elevated rounded-xl shadow-2xl max-w-[700px] w-[90%] max-h-[80vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: "slideUp 0.2s ease-out" }}
          >
            {/* Header: cover + title + close */}
            <div className="flex items-center gap-3 px-6 pt-5 pb-4">
              <div className="w-11 h-11 shrink-0 rounded overflow-hidden bg-th-surface-hover">
                {effectiveInfo?.image ? (
                  <TidalImage
                    src={getTidalImageUrl(effectiveInfo!.image, 160)}
                    alt={displayTitle}
                    type="playlist"
                    className="w-full h-full"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Music size={20} className="text-th-text-faint" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-[15px] font-bold text-th-text-primary leading-tight truncate">
                  {displayTitle}
                </h3>
                <p className="text-[13px] text-th-text-muted">Description</p>
              </div>
              <button
                onClick={() => setShowDescriptionModal(false)}
                className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center hover:bg-th-inset transition-colors text-th-text-muted hover:text-th-text-primary"
              >
                <X size={18} />
              </button>
            </div>

            {/* Description text */}
            <div className="px-6 pb-6 overflow-y-auto custom-scrollbar">
              {displayDescription
                .split(/\n\n|\n/)
                .filter((p) => p.trim())
                .map((paragraph, i) => (
                  <p
                    key={i}
                    className="text-[14px] text-th-text-secondary leading-[1.7] mb-4 last:mb-0"
                  >
                    {paragraph}
                  </p>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
