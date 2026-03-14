import {
  Play,
  Pause,
  Music,
  Shuffle,
  Heart,
  MoreHorizontal,
  Radio,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { isPlayingAtom, currentTrackAtom } from "../atoms/playback";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useFavorites } from "../hooks/useFavorites";
import { getMixItems } from "../api/tidal";
import { type Track } from "../types";
import TrackList from "./TrackList";
import MediaContextMenu from "./MediaContextMenu";
import PageContainer from "./PageContainer";
import { DetailPageSkeleton } from "./PageSkeleton";

interface MixPageProps {
  mixId: string;
  mixInfo?: { title: string; image?: string; subtitle?: string; mixType?: string };
  onBack: () => void;
}

export default function MixPage({ mixId, mixInfo, onBack }: MixPageProps) {
  const isPlaying = useAtomValue(isPlayingAtom);
  const currentTrack = useAtomValue(currentTrackAtom);
  const {
    playTrack,
    pauseTrack,
    resumeTrack,
    setShuffledQueue,
    playFromSource,
    playAllFromSource,
  } = usePlaybackActions();

  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mixType, setMixType] = useState<string | null>(mixInfo?.mixType ?? null);
  const [fetchedTitle, setFetchedTitle] = useState<string | null>(null);
  const [fetchedSubtitle, setFetchedSubtitle] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadMix = async () => {
      setLoading(true);
      setError(null);

      try {
        const result = await getMixItems(mixId);
        if (!cancelled) {
          setTracks(result.tracks);
          if (result.mixType) setMixType(result.mixType);
          if (result.title) setFetchedTitle(result.title);
          if (result.subtitle) setFetchedSubtitle(result.subtitle);
        }
      } catch (err: any) {
        if (!cancelled) {
          console.error("Failed to load mix:", err);
          const msg =
            typeof err === "string"
              ? err
              : typeof err?.message === "string"
                ? err.message
                : "Failed to load mix";
          setError(msg);
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
    [tracks],
  );

  const isTrackRadio = mixType === "TRACK_MIX";

  const mixSource = {
    type: isTrackRadio ? ("radio" as const) : ("mix" as const),
    id: mixId,
    name: mixInfo?.title || (isTrackRadio ? "Track Radio" : "Mix"),
    image: mixInfo?.image,
    subtitle: mixInfo?.subtitle,
    mixType: mixInfo?.mixType,
    allTracks: tracks,
  };

  const handlePlayTrack = async (track: Track, _index: number) => {
    try {
      await playFromSource(track, tracks, { source: mixSource });
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
      await playAllFromSource(tracks, { source: mixSource });
    } catch (err) {
      console.error("Failed to play mix:", err);
    }
  };

  const handleShuffle = async () => {
    if (tracks.length === 0) return;
    const firstIdx = Math.floor(Math.random() * tracks.length);
    const first = tracks[firstIdx];
    const rest = tracks.filter((_, i) => i !== firstIdx);
    try {
      setShuffledQueue(rest, { source: mixSource });
      await playTrack(first);
    } catch (err) {
      console.error("Failed to shuffle play:", err);
    }
  };

  const mixPlaying = !!(
    currentTrack &&
    trackIds.has(currentTrack.id) &&
    isPlaying
  );

  // Favorite state
  const { favoriteMixIds, addFavoriteMix, removeFavoriteMix } = useFavorites();
  const mixFavorited = favoriteMixIds.has(mixId);

  const handleToggleFavorite = async () => {
    try {
      if (mixFavorited) {
        await removeFavoriteMix(mixId);
      } else {
        await addFavoriteMix(mixId, {
          id: mixId,
          title: displayTitle,
          subTitle: displaySubtitle || "",
          mixType: mixType ?? undefined,
          images: mixInfo?.image ? { SMALL: { url: mixInfo.image }, MEDIUM: { url: mixInfo.image } } : undefined,
        });
      }
    } catch (err) {
      console.error("Failed to toggle mix favorite:", err);
    }
  };

  // Context menu
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const displayTitle = mixInfo?.title || fetchedTitle || "Mix";
  const displaySubtitle = mixInfo?.subtitle || fetchedSubtitle;

  if (loading) {
    return <DetailPageSkeleton type="mix" />;
  }

  if (error) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center px-8">
          {isTrackRadio ? (
            <Radio size={48} className="text-th-text-disabled" />
          ) : (
            <Music size={48} className="text-th-text-disabled" />
          )}
          <p className="text-th-text-primary font-semibold text-lg">
            {isTrackRadio ? "Couldn't load track radio" : "Couldn't load mix"}
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
        <div className="w-[232px] h-[232px] shrink-0 rounded-lg overflow-hidden shadow-2xl bg-th-surface-hover flex items-center justify-center relative">
          {mixInfo?.image ? (
            <>
              <img
                src={mixInfo.image}
                alt={displayTitle}
                className="w-full h-full object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
              {isTrackRadio && (
                <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                  <Radio size={64} className="text-white/80" />
                </div>
              )}
            </>
          ) : (
            isTrackRadio ? (
              <Radio size={56} className="text-th-accent" />
            ) : (
              <Music size={56} className="text-th-text-faint" />
            )
          )}
        </div>
        <div className="flex flex-col gap-2 pb-2 min-w-0">
          <span className="text-[12px] font-bold text-th-text-secondary uppercase tracking-widest">
            {isTrackRadio ? "Track Radio" : "Mix"}
          </span>
          <h1 className="text-[48px] font-extrabold text-th-text-primary leading-none tracking-tight line-clamp-2">
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
              mixFavorited
                ? "text-th-accent hover:brightness-110"
                : "text-th-text-muted hover:text-th-text-primary hover:bg-th-hl-med"
            }`}
            title={mixFavorited ? "Remove from favorites" : "Add to favorites"}
          >
            <Heart
              size={20}
              fill={mixFavorited ? "currentColor" : "none"}
              strokeWidth={mixFavorited ? 0 : 2}
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
            {isTrackRadio ? (
              <Radio size={48} className="text-th-text-disabled mx-auto mb-4" />
            ) : (
              <Music size={48} className="text-th-text-disabled mx-auto mb-4" />
            )}
            <p className="text-th-text-primary font-semibold text-lg mb-2">
              {isTrackRadio ? "No radio tracks found" : "This mix is empty"}
            </p>
            <p className="text-th-text-muted text-sm">
              {isTrackRadio
                ? "We couldn't find similar tracks for this track."
                : "No tracks found in this mix."}
            </p>
            <button
              onClick={onBack}
              className="mt-4 px-6 py-2 bg-th-text-primary text-th-base rounded-full text-sm font-bold hover:scale-105 transition-transform"
            >
              Go back
            </button>
          </div>
        )}
      </div>
      </PageContainer>
    </div>
  );
}
