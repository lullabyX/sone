import { Shuffle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import SourcePlayButton from "./SourcePlayButton";
import { usePlaySource } from "../hooks/usePlaySource";
import { useRestoreLoader } from "../hooks/useRestoreLoader";
import { getArtistTopTracksAll } from "../api/tidal";
import type { Track } from "../types";
import TrackList from "./TrackList";
import PageContainer from "./PageContainer";
import {
  ARTIST_TRACKS_PAGE_SIZE,
  artistTopTracksPager,
  type PlayableSource,
} from "../lib/trackSources";

interface ArtistTracksPageProps {
  artistId: number;
  artistName: string;
}

export default function ArtistTracksPage({
  artistId,
  artistName,
}: ArtistTracksPageProps) {
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
        const data = await getArtistTopTracksAll(
          artistId,
          0,
          ARTIST_TRACKS_PAGE_SIZE,
        );
        if (!cancelled) {
          setTracks(data.items);
          setHasMore(data.hasMore);
        }
      } catch (err: any) {
        if (!cancelled) {
          console.error("[ArtistTracksPage] load error:", err);
          const parsed =
            typeof err === "string"
              ? (() => {
                  try {
                    return JSON.parse(err);
                  } catch {
                    return null;
                  }
                })()
              : err;
          const msg = parsed?.message;
          if (typeof msg === "string") {
            setError(msg);
          } else if (msg && typeof msg === "object") {
            setError(
              `API ${msg.status}: ${typeof msg.body === "string" ? msg.body.slice(0, 200) : JSON.stringify(msg.body).slice(0, 200)}`,
            );
          } else {
            setError(typeof err === "string" ? err : "Failed to load tracks");
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [artistId]);

  const handleLoadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMore) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const data = await getArtistTopTracksAll(
        artistId,
        tracks.length,
        ARTIST_TRACKS_PAGE_SIZE,
      );
      setTracks((prev) => [...prev, ...data.items]);
      setHasMore(data.hasMore);
    } catch (err) {
      console.error("[ArtistTracksPage] load more error:", err);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [artistId, tracks.length, hasMore]);

  // Lets an in-flight scroll restore pull the pages it needs directly, rather
  // than the viewport tripping the pagination sentinel page by page.
  useRestoreLoader(handleLoadMore, hasMore);

  const playSource = usePlaySource();

  const playable = (): PlayableSource => ({
    meta: { type: "artist-tracks", id: artistId, name: artistName },
    loaded: tracks,
    hasMore,
    fetchPage: artistTopTracksPager(artistId),
    dedupe: true,
  });

  const handlePlayTrack = (track: Track, _index: number) => {
    void playSource(playable(), { startAt: track });
  };
  const handlePlayAll = () => {
    void playSource(playable());
  };
  const handleShuffle = () => {
    void playSource(playable(), { shuffle: true });
  };

  if (loading) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base overflow-y-auto">
        <PageContainer>
          <div className="px-8 pt-6 pb-4">
            <div className="h-8 w-48 bg-th-surface-hover rounded animate-pulse mb-6" />
          </div>
          <div className="px-8 flex flex-col gap-1">
            {Array.from({ length: 10 }).map((_, i) => (
              <div
                key={i}
                className="h-14 bg-th-surface-hover/50 rounded animate-pulse"
              />
            ))}
          </div>
        </PageContainer>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center px-8">
          <p className="text-th-text-primary font-semibold text-lg">
            Couldn't load tracks
          </p>
          <p className="text-th-text-muted text-sm max-w-md">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-linear-to-b from-th-surface to-th-base overflow-y-auto scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent">
      <PageContainer>
        <div className="px-8 pt-6 pb-4">
          <h1 className="text-[32px] font-extrabold text-th-text-primary leading-tight mb-1">
            Popular tracks
          </h1>
          <p className="text-th-text-muted text-sm">{artistName}</p>
        </div>

        <div className="px-8 py-4 flex items-center gap-3">
          <SourcePlayButton
            sourceType="artist-tracks"
            sourceId={artistId}
            onPlay={handlePlayAll}
          />
          <button
            onClick={handleShuffle}
            className="flex items-center gap-2 px-6 py-2.5 bg-th-button/40 backdrop-blur-md text-th-text-primary font-bold text-sm rounded-full hover:bg-th-button/60 hover:scale-[1.03] transition-[transform,filter,background-color] duration-150"
          >
            <Shuffle size={18} />
            Shuffle
          </button>
        </div>

        <div className="px-8 pb-8">
          {tracks.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-th-text-primary font-semibold text-lg mb-2">
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
      </PageContainer>
    </div>
  );
}
