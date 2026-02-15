import { Play, Pause, Music, Shuffle, MoreHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { usePlayback } from "../hooks/usePlayback";
import { getMixItems } from "../api/tidal";
import { type Track } from "../types";
import TrackList from "./TrackList";
import MediaContextMenu from "./MediaContextMenu";
import { DetailPageSkeleton } from "./PageSkeleton";

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
      console.error("Failed to shuffle play:", err);
    }
  };

  const mixPlaying = !!(
    currentTrack &&
    trackIds.has(currentTrack.id) &&
    isPlaying
  );

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const displayTitle = mixInfo?.title || "Mix";
  const displaySubtitle = mixInfo?.subtitle;

  if (loading) {
    return <DetailPageSkeleton type="mix" />;
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
              {tracks.length} TRACK{tracks.length !== 1 ? "S" : ""}
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
            {mixPlaying ? (
              <Pause size={18} fill="black" className="text-black" />
            ) : (
              <Play size={18} fill="black" className="text-black" />
            )}
            {mixPlaying ? "Pause" : "Play"}
          </button>
          <button
            onClick={handleShuffle}
            className="flex items-center gap-2 px-6 py-2.5 bg-th-button text-white font-bold text-sm rounded-full hover:bg-th-button-hover hover:scale-[1.03] transition-[transform,filter,background-color] duration-150"
          >
            <Shuffle size={18} />
            Shuffle
          </button>
        </div>
        {/* Right — More icon */}
        <div className="flex items-center gap-2 relative">
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
                type: "mix",
                mixId,
                title: displayTitle,
                image: mixInfo?.image,
                subtitle: mixInfo?.subtitle,
              }}
              onClose={() => setContextMenu(null)}
            />
          )}
        </div>
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
