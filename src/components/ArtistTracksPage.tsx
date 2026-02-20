import { Play, Pause, Shuffle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { isPlayingAtom, currentTrackAtom } from "../atoms/playback";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { getArtistTopTracksAll } from "../api/tidal";
import type { Track } from "../types";
import TrackList from "./TrackList";

const PAGE_SIZE = 50;

interface ArtistTracksPageProps {
  artistId: number;
  artistName: string;
}

export default function ArtistTracksPage({
  artistId,
  artistName,
}: ArtistTracksPageProps) {
  const isPlaying = useAtomValue(isPlayingAtom);
  const currentTrack = useAtomValue(currentTrackAtom);
  const { playTrack, setQueueTracks, pauseTrack, resumeTrack } =
    usePlaybackActions();

  const [tracks, setTracks] = useState<Track[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getArtistTopTracksAll(artistId, 0, PAGE_SIZE);
        if (!cancelled) {
          setTracks(data.items);
          setHasMore(data.hasMore);
        }
      } catch (err: any) {
        if (!cancelled) {
          console.error("[ArtistTracksPage] load error:", err);
          const parsed = typeof err === "string" ? (() => { try { return JSON.parse(err); } catch { return null; } })() : err;
          const msg = parsed?.message;
          if (typeof msg === "string") {
            setError(msg);
          } else if (msg && typeof msg === "object") {
            setError(`API ${msg.status}: ${typeof msg.body === "string" ? msg.body.slice(0, 200) : JSON.stringify(msg.body).slice(0, 200)}`);
          } else {
            setError(typeof err === "string" ? err : "Failed to load tracks");
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [artistId]);

  const handleLoadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMore) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const data = await getArtistTopTracksAll(artistId, tracks.length, PAGE_SIZE);
      setTracks((prev) => [...prev, ...data.items]);
      setHasMore(data.hasMore);
    } catch (err) {
      console.error("[ArtistTracksPage] load more error:", err);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [artistId, tracks.length, hasMore]);

  const trackIds = useMemo(
    () => new Set(tracks.map((t) => t.id).filter(Boolean)),
    [tracks]
  );

  const handlePlayTrack = async (track: Track, index: number) => {
    try {
      setQueueTracks(tracks.slice(index + 1));
      await playTrack(track);
    } catch (err) {
      console.error("Failed to play track:", err);
    }
  };

  const handlePlayAll = async () => {
    if (tracks.length === 0) return;
    if (currentTrack && trackIds.has(currentTrack.id)) {
      if (isPlaying) await pauseTrack();
      else await resumeTrack();
      return;
    }
    try {
      setQueueTracks(tracks.slice(1));
      await playTrack(tracks[0]);
    } catch (err) {
      console.error("Failed to play all:", err);
    }
  };

  const handleShuffle = async () => {
    if (tracks.length === 0) return;
    const shuffled = [...tracks];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    try {
      setQueueTracks(shuffled.slice(1));
      await playTrack(shuffled[0]);
    } catch (err) {
      console.error("Failed to shuffle:", err);
    }
  };

  const allPlaying = !!(
    currentTrack && trackIds.has(currentTrack.id) && isPlaying
  );

  if (loading) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base overflow-y-auto">
        <div className="px-8 pt-6 pb-4">
          <div className="h-8 w-48 bg-th-surface-hover rounded animate-pulse mb-6" />
        </div>
        <div className="px-8 flex flex-col gap-1">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-14 bg-th-surface-hover/50 rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center px-8">
          <p className="text-white font-semibold text-lg">
            Couldn't load tracks
          </p>
          <p className="text-th-text-muted text-sm max-w-md">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-linear-to-b from-th-surface to-th-base overflow-y-auto scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent">
      <div className="px-8 pt-6 pb-4">
        <h1 className="text-[32px] font-extrabold text-white leading-tight mb-1">
          Popular tracks
        </h1>
        <p className="text-th-text-muted text-sm">{artistName}</p>
      </div>

      <div className="px-8 py-4 flex items-center gap-3">
        <button
          onClick={handlePlayAll}
          className="flex items-center gap-2 px-6 py-2.5 bg-th-accent text-black font-bold text-sm rounded-full shadow-lg hover:brightness-110 hover:scale-[1.03] transition-[transform,filter] duration-150"
        >
          {allPlaying ? (
            <Pause size={18} fill="black" className="text-black" />
          ) : (
            <Play size={18} fill="black" className="text-black" />
          )}
          {allPlaying ? "Pause" : "Play"}
        </button>
        <button
          onClick={handleShuffle}
          className="flex items-center gap-2 px-6 py-2.5 bg-th-button text-white font-bold text-sm rounded-full hover:bg-th-button-hover hover:scale-[1.03] transition-[transform,filter,background-color] duration-150"
        >
          <Shuffle size={18} />
          Shuffle
        </button>
      </div>

      <div className="px-8 pb-8">
        {tracks.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-white font-semibold text-lg mb-2">
              No tracks available
            </p>
            <p className="text-th-text-muted text-sm">
              This artist doesn't have any popular tracks yet.
            </p>
          </div>
        ) : (
          <TrackList
            tracks={tracks}
            onPlay={handlePlayTrack}
            showAlbum={true}
            showArtist={true}
            showCover={true}
            showDateAdded={false}
            onLoadMore={handleLoadMore}
            hasMore={hasMore}
            loadingMore={loadingMore}
          />
        )}
      </div>
    </div>
  );
}
