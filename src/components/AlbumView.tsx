import { ChevronLeft, Play, Clock, Pause, Music, Loader2 } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { useAudioContext } from "../contexts/AudioContext";
import {
  getTidalImageUrl,
  type Track,
  type AlbumDetail,
} from "../hooks/useAudio";
import TidalImage from "./TidalImage";

interface AlbumViewProps {
  albumId: number;
  albumInfo?: { title: string; cover?: string; artistName?: string };
  onBack: () => void;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
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
    getAlbumDetail,
    getAlbumTracks,
    playTrack,
    setQueueTracks,
    currentTrack,
    isPlaying,
    pauseTrack,
    resumeTrack,
  } = useAudioContext();

  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [totalTracks, setTotalTracks] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const offsetRef = useRef(0);
  const hasMoreRef = useRef(true);

  const hasMore = tracks.length < totalTracks;

  // Load album detail + first page of tracks
  useEffect(() => {
    let cancelled = false;

    const loadAlbum = async () => {
      setLoading(true);
      setError(null);
      setTracks([]);
      offsetRef.current = 0;
      hasMoreRef.current = true;

      try {
        const [detail, firstPage] = await Promise.all([
          getAlbumDetail(albumId),
          getAlbumTracks(albumId, 0, PAGE_SIZE),
        ]);

        if (cancelled) return;

        setAlbum(detail);
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
        if (!cancelled) setLoading(false);
      }
    };

    loadAlbum();
    return () => {
      cancelled = true;
    };
  }, [albumId, getAlbumDetail, getAlbumTracks]);

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
  }, [albumId, loadingMore, getAlbumTracks]);

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    if (loading) return;

    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMoreRef.current) {
          loadMore();
        }
      },
      { threshold: 0.1 }
    );

    if (sentinelRef.current) {
      observerRef.current.observe(sentinelRef.current);
    }

    return () => observerRef.current?.disconnect();
  }, [loading, loadMore]);

  // Re-observe sentinel when tracks change (sentinel re-renders)
  useEffect(() => {
    if (observerRef.current && sentinelRef.current && hasMore) {
      observerRef.current.disconnect();
      observerRef.current.observe(sentinelRef.current);
    }
  }, [tracks.length, hasMore]);

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

  const isTrackFromThisAlbum = (track: Track) => {
    return track.album?.id === albumId;
  };

  const isCurrentlyPlaying = (track: Track) => {
    return currentTrack?.id === track.id && isPlaying;
  };

  const isCurrentTrackRow = (track: Track) => {
    return currentTrack?.id === track.id;
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
      <div className="flex-1 bg-gradient-to-b from-[#1a1a1a] to-[#121212] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-[#00FFFF] border-t-transparent rounded-full animate-spin" />
          <p className="text-[#a6a6a6] text-sm">Loading album...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 bg-gradient-to-b from-[#1a1a1a] to-[#121212] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center px-8">
          <Music size={48} className="text-[#535353]" />
          <p className="text-white font-semibold text-lg">
            Couldn't load album
          </p>
          <p className="text-[#a6a6a6] text-sm max-w-md">{error}</p>
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
    <div className="flex-1 bg-gradient-to-b from-[#1a1a1a] to-[#121212] overflow-y-auto scrollbar-thin scrollbar-thumb-[#333] scrollbar-track-transparent">
      {/* Top Bar */}
      <div className="sticky top-0 z-20 px-6 py-4 flex items-center bg-[#121212]/50 backdrop-blur-xl">
        <button
          onClick={onBack}
          className="w-8 h-8 rounded-full bg-black/40 flex items-center justify-center text-[#a6a6a6] hover:text-white transition-colors"
        >
          <ChevronLeft size={20} />
        </button>
      </div>

      {/* Album Header */}
      <div className="px-8 pb-8 flex items-end gap-7">
        <div className="w-[232px] h-[232px] flex-shrink-0 rounded-lg overflow-hidden shadow-2xl bg-[#282828]">
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
          <div className="flex items-center gap-1.5 text-[14px] text-[#a6a6a6] mt-2">
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
          className="w-14 h-14 bg-[#00FFFF] rounded-full flex items-center justify-center shadow-xl hover:scale-105 hover:brightness-110 transition-all"
        >
          {albumPlaying ? (
            <Pause size={24} fill="black" className="text-black" />
          ) : (
            <Play size={24} fill="black" className="text-black ml-1" />
          )}
        </button>
      </div>

      {/* Track List */}
      <div className="px-8 pb-8">
        {/* Header Row */}
        <div className="grid grid-cols-[36px_1fr_72px] gap-4 px-4 py-3 border-b border-[#2a2a2a] text-[12px] text-[#a6a6a6] uppercase tracking-widest mb-2">
          <span className="text-right">#</span>
          <span>Title</span>
          <span className="flex justify-end">
            <Clock size={15} />
          </span>
        </div>

        {/* Track Rows */}
        <div className="flex flex-col">
          {tracks.map((track, index) => {
            const isActive = isCurrentTrackRow(track);
            const playing = isCurrentlyPlaying(track);

            return (
              <div
                key={`${track.id}-${index}`}
                onClick={() => handlePlayTrack(track, index)}
                className={`grid grid-cols-[36px_1fr_72px] gap-4 px-4 py-2.5 rounded-md cursor-pointer group transition-colors ${
                  isActive ? "bg-[#ffffff0a]" : "hover:bg-[#ffffff08]"
                }`}
              >
                {/* Track Number / Playing Indicator */}
                <div className="flex items-center justify-end">
                  {playing ? (
                    <div className="flex items-center gap-[3px]">
                      <span className="w-[3px] h-3 bg-[#00FFFF] rounded-full animate-pulse" />
                      <span
                        className="w-[3px] h-4 bg-[#00FFFF] rounded-full animate-pulse"
                        style={{ animationDelay: "0.15s" }}
                      />
                      <span
                        className="w-[3px] h-2.5 bg-[#00FFFF] rounded-full animate-pulse"
                        style={{ animationDelay: "0.3s" }}
                      />
                    </div>
                  ) : (
                    <>
                      <span
                        className={`text-[15px] tabular-nums group-hover:hidden ${
                          isActive ? "text-[#00FFFF]" : "text-[#a6a6a6]"
                        }`}
                      >
                        {track.trackNumber ?? index + 1}
                      </span>
                      <Play
                        size={14}
                        fill="white"
                        className="text-white hidden group-hover:block"
                      />
                    </>
                  )}
                </div>

                {/* Title + Artist */}
                <div className="flex flex-col justify-center min-w-0">
                  <span
                    className={`text-[15px] font-medium truncate leading-snug ${
                      isActive ? "text-[#00FFFF]" : "text-white"
                    }`}
                  >
                    {track.title}
                  </span>
                  <span className="text-[13px] text-[#a6a6a6] truncate leading-snug group-hover:text-white transition-colors">
                    {track.artist?.name || displayArtist}
                  </span>
                </div>

                {/* Duration */}
                <div className="flex items-center justify-end text-[14px] text-[#a6a6a6] tabular-nums">
                  {formatDuration(track.duration)}
                </div>
              </div>
            );
          })}
        </div>

        {/* Infinite Scroll Sentinel */}
        {hasMore && (
          <div
            ref={sentinelRef}
            className="flex items-center justify-center py-8"
          >
            {loadingMore ? (
              <div className="flex items-center gap-3 text-[#a6a6a6]">
                <Loader2 size={20} className="animate-spin" />
                <span className="text-sm">Loading more tracks...</span>
              </div>
            ) : (
              <div className="h-8" />
            )}
          </div>
        )}

        {/* End of list */}
        {!hasMore && tracks.length > 0 && (
          <div className="py-6 text-center text-[13px] text-[#535353]">
            {totalTracks} song{totalTracks !== 1 ? "s" : ""}
          </div>
        )}
      </div>
    </div>
  );
}
