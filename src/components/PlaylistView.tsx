import {
  Play,
  Pause,
  Music,
  X,
  Shuffle,
  Heart,
  MoreHorizontal,
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
import { isPlayingAtom, currentTrackAtom } from "../atoms/playback";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useFavorites } from "../hooks/useFavorites";
import { getPlaylistTracksPage } from "../api/tidal";
import { getTidalImageUrl, type Track } from "../types";
import TidalImage from "./TidalImage";
import TrackList from "./TrackList";
import MediaContextMenu from "./MediaContextMenu";
import DebouncedFilterInput from "./DebouncedFilterInput";
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
  const { playTrack, setQueueTracks, pauseTrack, resumeTrack } =
    usePlaybackActions();

  const PAGE_SIZE = 100;

  const [allTracks, setAllTracks] = useState<Track[]>([]);
  const [totalTracks, setTotalTracks] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offsetRef = useRef(0);
  const hasMoreRef = useRef(true);
  const bgFetchingRef = useRef(false);
  const cancelledRef = useRef(false);
  const allTracksRef = useRef<Track[]>([]);

  useEffect(() => {
    allTracksRef.current = allTracks;
  }, [allTracks]);

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
        t.artist?.name?.toLowerCase().includes(q) ||
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

  const handlePlayTrack = async (track: Track, _index: number) => {
    try {
      // Always queue from the full unfiltered list based on the track's original position
      const originalIndex = tracks.findIndex((t) => t.id === track.id);
      const queueStart = originalIndex >= 0 ? originalIndex + 1 : 0;
      setQueueTracks(tracks.slice(queueStart));
      await playTrack(track);

      // Kick off background fetch for the rest if needed
      if (hasMoreRef.current && !bgFetchingRef.current) {
        await fetchRemaining();
        const full = allTracksRef.current;
        const playedIndex = full.findIndex((t) => t.id === track.id);
        if (playedIndex >= 0) {
          setQueueTracks(full.slice(playedIndex + 1));
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
      setQueueTracks(tracks.slice(1));
      await playTrack(tracks[0]);

      if (hasMoreRef.current && !bgFetchingRef.current) {
        await fetchRemaining();
        const full = allTracksRef.current;
        if (full.length > 1) {
          setQueueTracks(full.slice(1));
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
    const shuffled = [...all];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    try {
      setQueueTracks(shuffled.slice(1));
      await playTrack(shuffled[0]);
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

  const displayTitle = playlistInfo?.title || "Playlist";
  const displayDescription = playlistInfo?.description;
  // Show "You" for user's own playlists, actual creator name for public ones
  const displayCreator = playlistInfo?.isUserPlaylist
    ? "You"
    : playlistInfo?.creatorName || undefined;
  const displayTrackCount =
    totalTracks > 0 ? totalTracks : (playlistInfo?.numberOfTracks ?? 0);

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
          <p className="text-white font-semibold text-lg">
            Couldn't load playlist
          </p>
          <p className="text-th-text-muted text-sm max-w-md">{error}</p>
          <button
            onClick={onBack}
            className="mt-2 px-6 py-2 bg-white text-black rounded-full text-sm font-bold hover:scale-105 transition-transform"
          >
            Go back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-linear-to-b from-th-surface to-th-base overflow-y-auto scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent">
      <div className="px-8 pb-8 pt-8 flex items-end gap-7">
        <div className="w-[232px] h-[232px] shrink-0 rounded-lg overflow-hidden shadow-2xl bg-th-surface-hover flex items-center justify-center">
          {playlistInfo?.image ? (
            <TidalImage
              src={getTidalImageUrl(playlistInfo.image, 640)}
              alt={displayTitle}
              type="playlist"
              className="w-full h-full"
            />
          ) : (
            <Music size={56} className="text-th-text-faint" />
          )}
        </div>
        <div className="flex flex-col gap-2 pb-2 min-w-0">
          <span className="text-[12px] font-bold text-white/70 uppercase tracking-widest">
            Playlist
          </span>
          <h1 className="text-[48px] font-extrabold text-white leading-none tracking-tight line-clamp-2">
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
                  className="text-[13px] text-white font-semibold hover:underline mt-1"
                >
                  Read more
                </button>
              )}
            </div>
          )}
          <div className="flex items-center gap-1.5 text-[14px] text-th-text-muted mt-2">
            {displayCreator && (
              <>
                <span className="text-white font-semibold">
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
            className="flex items-center gap-2 px-6 py-2.5 bg-th-button text-white font-bold text-sm rounded-full hover:bg-th-button-hover hover:scale-[1.03] transition-[transform,filter,background-color] duration-150"
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
                : "text-th-text-muted hover:text-white hover:bg-white/8"
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
            className="w-10 h-10 rounded-full flex items-center justify-center text-th-text-muted hover:text-white hover:bg-white/8 transition-colors"
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
                image: playlistInfo?.image,
                creatorName: playlistInfo?.creatorName,
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
          showDateAdded={!!playlistInfo?.isUserPlaylist}
          showArtist={true}
          showAlbum={true}
          showCover={true}
          context="playlist"
          playlistId={playlistId}
          isUserPlaylist={playlistInfo?.isUserPlaylist}
          onTrackRemoved={(index) => {
            setAllTracks((prev) => prev.filter((_, i) => i !== index));
          }}
        />

        {/* End of list */}
        {tracks.length > 0 && !hasMore && (
          <div className="py-6 text-center text-[13px] text-th-text-disabled">
            {displayTrackCount} TRACK{displayTrackCount !== 1 ? "S" : ""}
          </div>
        )}

        {tracks.length === 0 && (
          <div className="py-16 text-center">
            <Music size={48} className="text-th-text-disabled mx-auto mb-4" />
            <p className="text-white font-semibold text-lg mb-2">
              This playlist is empty
            </p>
            <p className="text-th-text-muted text-sm">
              Add tracks in TIDAL to see them here.
            </p>
          </div>
        )}
      </div>

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
                {playlistInfo?.image ? (
                  <TidalImage
                    src={getTidalImageUrl(playlistInfo.image, 160)}
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
                <h3 className="text-[15px] font-bold text-white leading-tight truncate">
                  {displayTitle}
                </h3>
                <p className="text-[13px] text-th-text-muted">Description</p>
              </div>
              <button
                onClick={() => setShowDescriptionModal(false)}
                className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center hover:bg-th-inset transition-colors text-th-text-muted hover:text-white"
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
