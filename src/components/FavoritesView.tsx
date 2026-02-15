import { Heart } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { usePlayback } from "../hooks/usePlayback";
import { useAuth } from "../hooks/useAuth";
import { getFavoriteTracks } from "../api/tidal";
import { type Track } from "../types";
import TrackList from "./TrackList";
import { DetailPageSkeleton } from "./PageSkeleton";

interface FavoritesViewProps {
  onBack: () => void;
}

const PAGE_SIZE = 50;

export default function FavoritesView({ onBack }: FavoritesViewProps) {
  const { authTokens } = useAuth();
  const { playTrack, setQueueTracks } = usePlayback();

  const [tracks, setTracks] = useState<Track[]>([]);
  const [totalTracks, setTotalTracks] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offsetRef = useRef(0);
  const hasMoreRef = useRef(true);

  const hasMore = tracks.length < totalTracks;

  // Load first page
  useEffect(() => {
    let cancelled = false;

    const loadFavorites = async () => {
      const userId = authTokens?.user_id;
      if (userId == null) {
        setLoading(false);
        setError("Not authenticated");
        return;
      }

      setLoading(true);
      setError(null);
      setTracks([]);
      offsetRef.current = 0;
      hasMoreRef.current = true;

      try {
        const firstPage = await getFavoriteTracks(
          userId,
          0,
          PAGE_SIZE
        );

        if (cancelled) return;

        setTracks(firstPage.items);
        setTotalTracks(firstPage.totalNumberOfItems);
        offsetRef.current = firstPage.items.length;
        hasMoreRef.current =
          firstPage.items.length < firstPage.totalNumberOfItems;
      } catch (err: any) {
        if (!cancelled) {
          console.error("Failed to load favorites:", err);
          setError(err?.message || String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadFavorites();
    return () => {
      cancelled = true;
    };
  }, [authTokens?.user_id]);

  // Load more tracks
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMoreRef.current) return;
    const userId = authTokens?.user_id;
    if (userId == null) return;

    setLoadingMore(true);
    try {
      const page = await getFavoriteTracks(userId, offsetRef.current, PAGE_SIZE);
      setTracks((prev) => [...prev, ...page.items]);
      setTotalTracks(page.totalNumberOfItems);
      offsetRef.current += page.items.length;
      hasMoreRef.current = offsetRef.current < page.totalNumberOfItems;
    } catch (err) {
      console.error("Failed to load more favorites:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, authTokens?.user_id]);

  const handlePlayTrack = async (track: Track, index: number) => {
    try {
      const remaining = tracks.slice(index + 1);
      setQueueTracks(remaining);
      await playTrack(track);
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
          <p className="text-white font-semibold text-lg">
            Couldn't load favorites
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
      {/* Favorites Header */}
      <div className="px-8 py-8 flex items-end gap-7">
        <div className="w-[232px] h-[232px] shrink-0 rounded-lg overflow-hidden shadow-2xl bg-linear-to-br from-[#450af5] via-[#8e2de2] to-[#00d2ff] flex items-center justify-center">
          <Heart size={80} className="text-white drop-shadow-lg" fill="white" />
        </div>
        <div className="flex flex-col gap-2 pb-2 min-w-0">
          <span className="text-[12px] font-bold text-white/70 uppercase tracking-widest">
            Collection
          </span>
          <h1 className="text-[48px] font-extrabold text-white leading-none tracking-tight">
            Loved Tracks
          </h1>
          <div className="flex items-center gap-1.5 text-[14px] text-th-text-muted mt-2">
            <span>
              {totalTracks} TRACK{totalTracks !== 1 ? "S" : ""}
            </span>
          </div>
        </div>
      </div>

      {/* Track List */}
      <div className="px-8 pb-8">
        <TrackList
          tracks={tracks}
          onPlay={handlePlayTrack}
          onLoadMore={loadMore}
          hasMore={hasMore}
          loadingMore={loadingMore}
          showDateAdded={true}
          showArtist={true}
          showAlbum={true}
          showCover={true}
          context="favorites"
        />

        {/* End of list */}
        {!hasMore && tracks.length > 0 && (
          <div className="py-6 text-center text-[13px] text-th-text-disabled">
            {totalTracks} TRACK{totalTracks !== 1 ? "S" : ""}
          </div>
        )}

        {/* Empty state */}
        {!hasMore && tracks.length === 0 && (
          <div className="py-16 text-center">
            <Heart size={48} className="text-th-text-disabled mx-auto mb-4" />
            <p className="text-white font-semibold text-lg mb-2">
              No loved tracks yet
            </p>
            <p className="text-th-text-muted text-sm">
              Heart tracks on Tidal to see them here.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
