import { Heart } from "lucide-react";
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  startTransition,
} from "react";
import { useAtomValue, useStore } from "jotai";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useAuth } from "../hooks/useAuth";
import { getFavoriteTracks } from "../api/tidal";
import { favoriteTrackIdsAtom } from "../atoms/favorites";
import { shuffleAtom } from "../atoms/playback";
import { type Track } from "../types";
import TrackList from "./TrackList";
import DebouncedFilterInput from "./DebouncedFilterInput";
import PageContainer from "./PageContainer";
import { DetailPageSkeleton } from "./PageSkeleton";

interface FavoritesViewProps {
  onBack: () => void;
}

const PAGE_SIZE = 100;

export default function FavoritesView({ onBack }: FavoritesViewProps) {
  const store = useStore();
  const { authTokens } = useAuth();
  const { playFromSource, setQueueTracks, setShuffledQueue } =
    usePlaybackActions();
  const favoriteTrackIds = useAtomValue(favoriteTrackIdsAtom);

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

  // Keep ref in sync with state so async callbacks read the latest value
  useEffect(() => {
    allTracksRef.current = allTracks;
  }, [allTracks]);

  // Load first page only
  useEffect(() => {
    cancelledRef.current = false;
    bgFetchingRef.current = false;

    const loadFavorites = async () => {
      const userId = authTokens?.user_id;
      if (userId == null) {
        setLoading(false);
        setError("Not authenticated");
        return;
      }

      setLoading(true);
      setError(null);
      setAllTracks([]);
      offsetRef.current = 0;
      hasMoreRef.current = true;

      try {
        const firstPage = await getFavoriteTracks(userId, 0, PAGE_SIZE);
        if (cancelledRef.current) return;

        setAllTracks(firstPage.items);
        setTotalTracks(firstPage.totalNumberOfItems);
        offsetRef.current = firstPage.items.length;
        hasMoreRef.current =
          firstPage.items.length < firstPage.totalNumberOfItems;
      } catch (err: any) {
        if (!cancelledRef.current) {
          console.error("Failed to load favorites:", err);
          setError(err?.message || String(err));
        }
      } finally {
        if (!cancelledRef.current) setLoading(false);
      }
    };

    loadFavorites();
    return () => {
      cancelledRef.current = true;
    };
  }, [authTokens?.user_id]);

  // Fetch all remaining pages in the background, appending to state as they arrive
  const fetchRemaining = useCallback(async () => {
    if (bgFetchingRef.current || !hasMoreRef.current) return;
    const userId = authTokens?.user_id;
    if (userId == null) return;

    bgFetchingRef.current = true;
    try {
      while (hasMoreRef.current && !cancelledRef.current) {
        const page = await getFavoriteTracks(
          userId,
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
      console.error("Failed to background-fetch favorites:", err);
    } finally {
      bgFetchingRef.current = false;
    }
  }, [authTokens?.user_id]);

  // Manual load-more (infinite scroll trigger) — also kicks off full background fetch
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMoreRef.current) return;
    if (bgFetchingRef.current) return; // background fetch already running

    setLoadingMore(true);
    try {
      const userId = authTokens?.user_id;
      if (userId == null) return;
      const page = await getFavoriteTracks(
        userId,
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
      console.error("Failed to load more favorites:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, authTokens?.user_id]);

  const hasMore = allTracks.length < totalTracks;

  // Filter out unfavorited tracks in real-time
  const tracks = useMemo(
    () => allTracks.filter((t) => favoriteTrackIds.has(t.id)),
    [allTracks, favoriteTrackIds],
  );

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

  const favoritesSource = (allTracks: Track[]) => ({
    type: "favorites" as const,
    id: "favorites" as const,
    name: "Loved Tracks",
    allTracks,
  });

  const handlePlayTrack = async (track: Track, _index: number) => {
    try {
      await playFromSource(track, tracks, { source: favoritesSource(tracks) });

      // Kick off background fetch for the rest if needed
      if (hasMoreRef.current && !bgFetchingRef.current) {
        await fetchRemaining();
        const full = allTracksRef.current.filter((t) =>
          favoriteTrackIds.has(t.id),
        );
        const playedIndex = full.findIndex((t) => t.id === track.id);
        if (playedIndex >= 0) {
          const rest = [
            ...full.slice(playedIndex + 1),
            ...full.slice(0, playedIndex),
          ];
          if (store.get(shuffleAtom)) {
            setShuffledQueue(rest, { source: favoritesSource(full) });
          } else {
            setQueueTracks(rest, { source: favoritesSource(full) });
          }
        }
      }
    } catch (err) {
      console.error("Failed to play track:", err);
    }
  };

  if (loading) {
    return <DetailPageSkeleton type="favorites" />;
  }

  if (error) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center px-8">
          <Heart size={48} className="text-th-text-disabled" />
          <p className="text-th-text-primary font-semibold text-lg">
            Couldn't load favorites
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
      {/* Favorites Header */}
      <div className="px-8 py-8 flex items-end gap-7">
        <div className="w-[232px] h-[232px] shrink-0 rounded-lg overflow-hidden shadow-2xl bg-linear-to-br from-[#450af5] via-[#8e2de2] to-[#00d2ff] flex items-center justify-center">
          <Heart size={80} className="text-white drop-shadow-lg" fill="white" />
        </div>
        <div className="flex flex-col gap-2 pb-2 min-w-0">
          <span className="text-[12px] font-bold text-th-text-secondary uppercase tracking-widest">
            Collection
          </span>
          <h1 className="text-[48px] font-extrabold text-th-text-primary leading-none tracking-tight">
            Loved Tracks
          </h1>
          <div className="flex items-center gap-1.5 text-[14px] text-th-text-muted mt-2">
            <span>
              {totalTracks} TRACK{totalTracks !== 1 ? "S" : ""}
            </span>
          </div>
        </div>
      </div>

      {/* Search / Filter bar */}
      <div className="px-8 pb-4">
        <DebouncedFilterInput
          placeholder="Filter on title, artist or album"
          onChange={setSearchQuery}
          onFocus={handleSearchFocus}
        />
      </div>

      {/* Track List */}
      <div className="px-8 pb-8">
        <TrackList
          tracks={filteredTracks}
          onPlay={handlePlayTrack}
          onLoadMore={isFiltering ? undefined : loadMore}
          hasMore={isFiltering ? false : hasMore}
          loadingMore={isFiltering ? false : loadingMore}
          trackDisplayNumbers={displayNumbers}
          showDateAdded={true}
          showArtist={true}
          showAlbum={true}
          showCover={true}
          context="favorites"
        />

        {/* End of list */}
        {tracks.length > 0 && (
          <div className="py-6 text-center text-[13px] text-th-text-disabled">
            {totalTracks} TRACK{totalTracks !== 1 ? "S" : ""}
          </div>
        )}

        {/* Empty state */}
        {tracks.length === 0 && (
          <div className="py-16 text-center">
            <Heart size={48} className="text-th-text-disabled mx-auto mb-4" />
            <p className="text-th-text-primary font-semibold text-lg mb-2">
              No loved tracks yet
            </p>
            <p className="text-th-text-muted text-sm">
              Heart tracks on TIDAL to see them here.
            </p>
          </div>
        )}
      </div>
      </PageContainer>
    </div>
  );
}
