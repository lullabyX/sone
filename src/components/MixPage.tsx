import { Play, Pause, Music } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { usePlayback } from "../hooks/usePlayback";
import { getMixItems } from "../api/tidal";
import { type Track } from "../types";
import TrackList from "./TrackList";

interface MixPageProps {
  mixId: string;
  mixInfo?: { title: string; image?: string; subtitle?: string };
  onBack: () => void;
}

export default function MixPage({ mixId, mixInfo, onBack }: MixPageProps) {
  const {
    playTrack,
    setQueueTracks,
    currentTrack,
    isPlaying,
    pauseTrack,
    resumeTrack,
  } = usePlayback();

  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadMix = async () => {
      setLoading(true);
      setError(null);

      try {
        const mixTracks = await getMixItems(mixId);
        if (!cancelled) {
          setTracks(mixTracks);
        }
      } catch (err: any) {
        if (!cancelled) {
          console.error("Failed to load mix:", err);
          setError(err?.message || String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadMix();

    return () => {
      cancelled = true;
    };
  }, [mixId]);

  const trackIds = useMemo(
    () => new Set(tracks.map((track) => track.id)),
    [tracks]
  );

  const handlePlayTrack = async (track: Track, index: number) => {
    try {
      setQueueTracks(tracks.slice(index + 1));
      await playTrack(track);
    } catch (err) {
      console.error("Failed to play mix track:", err);
    }
  };

  const handlePlayAll = async () => {
    if (tracks.length === 0) return;

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
    } catch (err) {
      console.error("Failed to play mix:", err);
    }
  };

  const mixPlaying = !!(
    currentTrack &&
    trackIds.has(currentTrack.id) &&
    isPlaying
  );

  const displayTitle = mixInfo?.title || "Mix";
  const displaySubtitle = mixInfo?.subtitle;

  if (loading) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-th-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-th-text-muted text-sm">Loading mix...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center px-8">
          <Music size={48} className="text-th-text-disabled" />
          <p className="text-white font-semibold text-lg">Couldn't load mix</p>
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
          {mixInfo?.image ? (
            <img
              src={mixInfo.image}
              alt={displayTitle}
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <Music size={56} className="text-th-text-faint" />
          )}
        </div>
        <div className="flex flex-col gap-2 pb-2 min-w-0">
          <span className="text-[12px] font-bold text-white/70 uppercase tracking-widest">
            Mix
          </span>
          <h1 className="text-[48px] font-extrabold text-white leading-none tracking-tight line-clamp-2">
            {displayTitle}
          </h1>
          {displaySubtitle && (
            <p className="text-[14px] text-th-text-muted mt-1 line-clamp-2 max-w-[800px]">
              {displaySubtitle}
            </p>
          )}
          <div className="flex items-center gap-1.5 text-[14px] text-th-text-muted mt-2">
            <span>
              {tracks.length} song{tracks.length !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
      </div>

      <div className="px-8 py-5 flex items-center gap-5">
        <button
          onClick={handlePlayAll}
          className="w-14 h-14 bg-th-accent rounded-full flex items-center justify-center shadow-xl hover:scale-105 hover:brightness-110 transition-[transform,filter] duration-150"
        >
          {mixPlaying ? (
            <Pause size={24} fill="black" className="text-black" />
          ) : (
            <Play size={24} fill="black" className="text-black ml-1" />
          )}
        </button>
      </div>

      <div className="px-8 pb-8">
        <TrackList
          tracks={tracks}
          onPlay={handlePlayTrack}
          showDateAdded={false}
          showArtist={true}
          showAlbum={true}
          showCover={true}
          context="playlist"
        />

        {tracks.length === 0 && (
          <div className="py-16 text-center">
            <Music size={48} className="text-th-text-disabled mx-auto mb-4" />
            <p className="text-white font-semibold text-lg mb-2">
              This mix is empty
            </p>
            <p className="text-th-text-muted text-sm">
              No tracks found in this mix.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
