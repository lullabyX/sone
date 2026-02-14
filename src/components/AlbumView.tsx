import {
  Play,
  Pause,
  Music,
  Loader2,
  Heart,
} from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { usePlayback } from "../hooks/usePlayback";
import { useFavorites } from "../hooks/useFavorites";
import { getAlbumDetail, getAlbumTracks } from "../api/tidal";
import { getTidalImageUrl, type Track, type AlbumDetail } from "../types";
import TidalImage from "./TidalImage";
import TrackList from "./TrackList";

interface AlbumViewProps {
  albumId: number;
  albumInfo?: { title: string; cover?: string; artistName?: string };
  onBack: () => void;
}

function formatTotalDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours} hr ${mins} min`;
  }
  return `${mins} min`;
}

const PAGE_SIZE = 50;

export default function AlbumView({
  albumId,
  albumInfo,
  onBack,
}: AlbumViewProps) {
  const {
    playTrack,
    setQueueTracks,
    currentTrack,
    isPlaying,
    pauseTrack,
    resumeTrack,
  } = usePlayback();
  const { isAlbumFavorited, addFavoriteAlbum, removeFavoriteAlbum } =
    useFavorites();

  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [totalTracks, setTotalTracks] = useState(0);
  const [loading, setLoading] = useState(true);
  const [favoriteLoading, setFavoriteLoading] = useState(true);
  const [albumFavorited, setAlbumFavorited] = useState(false);
  const [favoritePending, setFavoritePending] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offsetRef = useRef(0);
  const hasMoreRef = useRef(true);

  const hasMore = tracks.length < totalTracks;

  // Load album detail + first page of tracks
  useEffect(() => {
    let cancelled = false;

    const loadAlbum = async () => {
      setLoading(true);
      setFavoriteLoading(true);
      setError(null);
      setTracks([]);
      offsetRef.current = 0;
      hasMoreRef.current = true;

      try {
        const [detail, firstPage, favorited] = await Promise.all([
          getAlbumDetail(albumId),
          getAlbumTracks(albumId, 0, PAGE_SIZE),
          isAlbumFavorited(albumId).catch((favoriteErr) => {
            console.error("Failed to fetch album favorite state:", favoriteErr);
            return false;
          }),
        ]);

        if (cancelled) return;

        setAlbum(detail);
        setAlbumFavorited(favorited);
        setTracks(firstPage.items);
        setTotalTracks(firstPage.totalNumberOfItems);
        offsetRef.current = firstPage.items.length;
        hasMoreRef.current =
          firstPage.items.length < firstPage.totalNumberOfItems;
      } catch (err: any) {
        if (!cancelled) {
          console.error("Failed to load album:", err);
          setError(err?.message || String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setFavoriteLoading(false);
        }
      }
    };

    loadAlbum();
    return () => {
      cancelled = true;
    };
  }, [albumId, isAlbumFavorited]);

  // Load more tracks (infinite scroll)
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMoreRef.current) return;

    setLoadingMore(true);
    try {
      const page = await getAlbumTracks(albumId, offsetRef.current, PAGE_SIZE);
      setTracks((prev) => [...prev, ...page.items]);
      setTotalTracks(page.totalNumberOfItems);
      offsetRef.current += page.items.length;
      hasMoreRef.current = offsetRef.current < page.totalNumberOfItems;
    } catch (err) {
      console.error("Failed to load more tracks:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [albumId, loadingMore]);

  const handlePlayTrack = async (track: Track, index: number) => {
    try {
      // Set remaining tracks as queue
      const remaining = tracks.slice(index + 1);
      setQueueTracks(remaining);
      await playTrack(track);
    } catch (err) {
      console.error("Failed to play track:", err);
    }
  };

  const handlePlayAll = async () => {
    if (tracks.length === 0) return;

    // If already playing a track from this album, toggle pause
    if (currentTrack && isTrackFromThisAlbum(currentTrack)) {
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
    } catch (err) {
      console.error("Failed to play all:", err);
    }
  };

  const handleToggleFavorite = async () => {
    if (favoriteLoading || favoritePending) return;

    const nextFavoriteState = !albumFavorited;
    setFavoritePending(true);

    try {
      if (nextFavoriteState) {
        await addFavoriteAlbum(albumId);
      } else {
        await removeFavoriteAlbum(albumId);
      }
      setAlbumFavorited(nextFavoriteState);
    } catch (err) {
      console.error("Failed to toggle album favorite:", err);
    } finally {
      setFavoritePending(false);
    }
  };

  const isTrackFromThisAlbum = (track: Track) => {
    return track.album?.id === albumId;
  };

  const albumPlaying =
    currentTrack && isTrackFromThisAlbum(currentTrack) && isPlaying;

  // Use album detail or fallback to passed info
  const displayTitle = album?.title || albumInfo?.title || "Album";
  const displayCover = album?.cover || albumInfo?.cover;
  const displayArtist =
    album?.artist?.name || albumInfo?.artistName || "Unknown Artist";

  if (loading) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-th-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-th-text-muted text-sm">Loading album...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center px-8">
          <Music size={48} className="text-th-text-disabled" />
          <p className="text-white font-semibold text-lg">
            Couldn't load album
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
      {/* Album Header */}
      <div className="px-8 pb-8 pt-8 flex items-end gap-7">
        <div className="w-[232px] h-[232px] shrink-0 rounded-lg overflow-hidden shadow-2xl bg-th-surface-hover">
          <TidalImage
            src={getTidalImageUrl(displayCover, 640)}
            alt={displayTitle}
            className="w-full h-full"
          />
        </div>
        <div className="flex flex-col gap-2 pb-2 min-w-0">
          <span className="text-[12px] font-bold text-white/70 uppercase tracking-widest">
            Album
          </span>
          <h1 className="text-[48px] font-extrabold text-white leading-none tracking-tight line-clamp-2">
            {displayTitle}
          </h1>
          <div className="flex items-center gap-1.5 text-[14px] text-th-text-muted mt-2">
            <span className="text-white font-semibold hover:underline cursor-pointer">
              {displayArtist}
            </span>
            {album?.releaseDate && (
              <>
                <span className="mx-1">•</span>
                <span>{new Date(album.releaseDate).getFullYear()}</span>
              </>
            )}
            {album?.numberOfTracks != null && (
              <>
                <span className="mx-1">•</span>
                <span>
                  {album.numberOfTracks} song
                  {album.numberOfTracks !== 1 ? "s" : ""}
                </span>
              </>
            )}
            {album?.duration != null && album.duration > 0 && (
              <>
                <span className="mx-1">•</span>
                <span>{formatTotalDuration(album.duration)}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Play Controls */}
      <div className="px-8 py-5 flex items-center gap-5">
        <button
          onClick={handlePlayAll}
          className="w-14 h-14 bg-th-accent rounded-full flex items-center justify-center shadow-xl hover:scale-105 hover:brightness-110 transition-[transform,filter] duration-150"
        >
          {albumPlaying ? (
            <Pause size={24} fill="black" className="text-black" />
          ) : (
            <Play size={24} fill="black" className="text-black ml-1" />
          )}
        </button>
        <button
          onClick={handleToggleFavorite}
          disabled={favoriteLoading || favoritePending}
          className={`w-10 h-10 rounded-full flex items-center justify-center transition-[color,filter] duration-150 ${
            albumFavorited
              ? "text-th-accent hover:brightness-110"
              : "text-th-text-muted hover:text-white hover:bg-white/8"
          } disabled:opacity-60 disabled:cursor-not-allowed`}
          title={albumFavorited ? "Remove from favorites" : "Add to favorites"}
          aria-label={albumFavorited ? "Unfavorite album" : "Favorite album"}
        >
          {favoriteLoading || favoritePending ? (
            <Loader2 size={18} className="animate-spin" />
          ) : (
            <Heart
              size={20}
              fill={albumFavorited ? "currentColor" : "none"}
              strokeWidth={albumFavorited ? 0 : 2}
            />
          )}
        </button>
      </div>

      {/* Track List */}
      <div className="px-8 pb-8">
        <TrackList
          tracks={tracks}
          onPlay={handlePlayTrack}
          onLoadMore={loadMore}
          hasMore={hasMore}
          loadingMore={loadingMore}
          showDateAdded={false}
          showArtist={true}
          showAlbum={false}
          showCover={false}
          context="album"
        />

        {/* End of list */}
        {!hasMore && tracks.length > 0 && (
          <div className="py-6 text-center text-[13px] text-th-text-disabled">
            {totalTracks} song{totalTracks !== 1 ? "s" : ""}
          </div>
        )}
      </div>
    </div>
  );
}
