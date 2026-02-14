import { Play, Pause, Music, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { usePlayback } from "../hooks/usePlayback";
import { getPlaylistTracks } from "../api/tidal";
import { getTidalImageUrl, type Track } from "../types";
import TidalImage from "./TidalImage";
import TrackList from "./TrackList";

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

    const loadPlaylist = async () => {
      setLoading(true);
      setError(null);

      try {
        const playlistTracks = await getPlaylistTracks(playlistId);
        if (!cancelled) {
          setTracks(playlistTracks);
        }
      } catch (err: any) {
        if (!cancelled) {
          console.error("Failed to load playlist:", err);
          setError(err?.message || String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadPlaylist();

    return () => {
      cancelled = true;
    };
  }, [playlistId]);

  const trackIds = useMemo(() => new Set(tracks.map((track) => track.id)), [tracks]);

  const handlePlayTrack = async (track: Track, index: number) => {
    try {
      setQueueTracks(tracks.slice(index + 1));
      await playTrack(track);
    } catch (err) {
      console.error("Failed to play playlist track:", err);
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
      console.error("Failed to play playlist:", err);
    }
  };

  const playlistPlaying = !!(currentTrack && trackIds.has(currentTrack.id) && isPlaying);

  const [showDescriptionModal, setShowDescriptionModal] = useState(false);

  const displayTitle = playlistInfo?.title || "Playlist";
  const displayDescription = playlistInfo?.description;
  // Show "You" for user's own playlists, actual creator name for public ones
  const displayCreator = playlistInfo?.isUserPlaylist
    ? "You"
    : playlistInfo?.creatorName || undefined;
  const displayTrackCount =
    tracks.length > 0 ? tracks.length : (playlistInfo?.numberOfTracks ?? 0);

  // Show "Read more" if description is long enough to be truncated
  const descriptionIsLong = (displayDescription?.length ?? 0) > 120;

  if (loading) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-th-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-th-text-muted text-sm">Loading playlist...</p>
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
                <span className="text-white font-semibold">{displayCreator}</span>
                <span className="mx-1">•</span>
              </>
            )}
            <span>
              {displayTrackCount} song{displayTrackCount !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
      </div>

      <div className="px-8 py-5 flex items-center gap-5">
        <button
          onClick={handlePlayAll}
          className="w-14 h-14 bg-th-accent rounded-full flex items-center justify-center shadow-xl hover:scale-105 hover:brightness-110 transition-[transform,filter] duration-150"
        >
          {playlistPlaying ? (
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
          showDateAdded={!!playlistInfo?.isUserPlaylist}
          showArtist={true}
          showAlbum={true}
          showCover={true}
          context="playlist"
          playlistId={playlistId}
          isUserPlaylist={playlistInfo?.isUserPlaylist}
          onTrackRemoved={(index) => {
            setTracks((prev) => prev.filter((_, i) => i !== index));
          }}
        />

        {tracks.length === 0 && (
          <div className="py-16 text-center">
            <Music size={48} className="text-th-text-disabled mx-auto mb-4" />
            <p className="text-white font-semibold text-lg mb-2">
              This playlist is empty
            </p>
            <p className="text-th-text-muted text-sm">
              Add tracks in Tidal to see them here.
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
