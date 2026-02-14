import { Play, Pause, User, Music, X } from "lucide-react";
import { useEffect, useMemo, useState, useCallback } from "react";
import { usePlayback } from "../hooks/usePlayback";
import { useNavigation } from "../hooks/useNavigation";
import {
  getArtistDetail,
  getArtistTopTracks,
  getArtistAlbums,
  getArtistBio,
} from "../api/tidal";
import {
  getTidalImageUrl,
  type Track,
  type AlbumDetail,
  type MediaItemType,
} from "../types";
import TidalImage from "./TidalImage";
import MediaContextMenu from "./MediaContextMenu";

interface ArtistPageProps {
  artistId: number;
  artistInfo?: { name: string; picture?: string };
  onBack: () => void;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/** Strip Tidal's wimpLink markup and HTML tags from bio text */
function cleanBio(raw: string): string {
  return (
    raw
      // [wimpLink artistId="123"]Name[/wimpLink] → Name
      .replace(/\[wimpLink[^\]]*\]/g, "")
      .replace(/\[\/wimpLink\]/g, "")
      // [wimpLink albumId="123"]Title[/wimpLink] → Title
      // catch any remaining wimpLink variants
      .replace(/\[[^\]]*\]/g, "")
      // Strip HTML tags
      .replace(/<[^>]*>/g, "")
      .trim()
  );
}

export default function ArtistPage({
  artistId,
  artistInfo,
  onBack,
}: ArtistPageProps) {
  const {
    playTrack,
    setQueueTracks,
    currentTrack,
    isPlaying,
    pauseTrack,
    resumeTrack,
  } = usePlayback();
  const { navigateToAlbum } = useNavigation();

  const [topTracks, setTopTracks] = useState<Track[]>([]);
  const [albums, setAlbums] = useState<AlbumDetail[]>([]);
  const [bio, setBio] = useState<string>("");
  const [picture, setPicture] = useState<string | undefined>(
    artistInfo?.picture
  );
  const [artistName, setArtistName] = useState<string>(
    artistInfo?.name || "Artist"
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllTracks, setShowAllTracks] = useState(false);
  const [showBioModal, setShowBioModal] = useState(false);

  // Context menu state for album cards
  const [contextMenu, setContextMenu] = useState<{
    item: MediaItemType;
    position: { x: number; y: number };
  } | null>(null);

  const handleAlbumContextMenu = useCallback(
    (e: React.MouseEvent, album: AlbumDetail) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        item: {
          type: "album",
          id: album.id,
          title: album.title,
          cover: album.cover,
          artistName: album.artist?.name,
        },
        position: { x: e.clientX, y: e.clientY },
      });
    },
    []
  );

  useEffect(() => {
    let cancelled = false;

    const loadArtist = async () => {
      setLoading(true);
      setError(null);

      try {
        const [detail, tracks, artistAlbums, artistBio] = await Promise.all([
          getArtistDetail(artistId).catch(() => null),
          getArtistTopTracks(artistId, 20),
          getArtistAlbums(artistId, 20),
          getArtistBio(artistId).catch(() => ""),
        ]);

        if (!cancelled) {
          // Use the artist detail for the most accurate picture/name
          if (detail) {
            if (detail.picture) setPicture(detail.picture);
            if (detail.name) setArtistName(detail.name);
          }
          setTopTracks(tracks);
          setAlbums(artistAlbums);
          setBio(artistBio);
        }
      } catch (err: any) {
        if (!cancelled) {
          console.error("Failed to load artist:", err);
          setError(err?.message || String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadArtist();

    return () => {
      cancelled = true;
    };
  }, [
    artistId,
    getArtistDetail,
    getArtistTopTracks,
    getArtistAlbums,
    getArtistBio,
  ]);

  const trackIds = useMemo(
    () => new Set(topTracks.map((track) => track.id)),
    [topTracks]
  );

  const handlePlayTrack = async (track: Track, index: number) => {
    try {
      setQueueTracks(topTracks.slice(index + 1));
      await playTrack(track);
    } catch (err) {
      console.error("Failed to play artist track:", err);
    }
  };

  const handlePlayAll = async () => {
    if (topTracks.length === 0) return;

    if (currentTrack && trackIds.has(currentTrack.id)) {
      if (isPlaying) {
        await pauseTrack();
      } else {
        await resumeTrack();
      }
      return;
    }

    try {
      setQueueTracks(topTracks.slice(1));
      await playTrack(topTracks[0]);
    } catch (err) {
      console.error("Failed to play artist tracks:", err);
    }
  };

  const isCurrentlyPlaying = (track: Track) =>
    currentTrack?.id === track.id && isPlaying;
  const isCurrentTrackRow = (track: Track) => currentTrack?.id === track.id;
  const artistPlaying = !!(
    currentTrack &&
    trackIds.has(currentTrack.id) &&
    isPlaying
  );

  const displayName = artistName;
  const displayTracks = showAllTracks ? topTracks : topTracks.slice(0, 5);

  if (loading) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-th-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-th-text-muted text-sm">Loading artist...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center px-8">
          <User size={48} className="text-th-text-disabled" />
          <p className="text-white font-semibold text-lg">
            Couldn't load artist
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
      {/* Artist Header */}
      <div className="px-8 pb-8 pt-8 flex items-end gap-7">
        <div className="w-[232px] h-[232px] shrink-0 rounded-full overflow-hidden shadow-2xl bg-th-surface-hover flex items-center justify-center">
          {picture ? (
            <img
              src={getTidalImageUrl(picture, 640)}
              alt={displayName}
              className="w-full h-full object-cover"
              onError={(e) => {
                // Try 320 as fallback if 640 fails
                const img = e.target as HTMLImageElement;
                const fallback = getTidalImageUrl(picture, 320);
                if (img.src !== fallback) {
                  img.src = fallback;
                } else {
                  img.style.display = "none";
                }
              }}
            />
          ) : (
            <User size={72} className="text-th-text-faint" />
          )}
        </div>
        <div className="flex flex-col gap-2 pb-2 min-w-0">
          <span className="text-[12px] font-bold text-white/70 uppercase tracking-widest">
            Artist
          </span>
          <h1 className="text-[48px] font-extrabold text-white leading-none tracking-tight line-clamp-2">
            {displayName}
          </h1>
          {bio && (
            <div className="mt-1 max-w-[800px]">
              <p className="text-[14px] text-th-text-muted line-clamp-2">
                {cleanBio(bio)}
              </p>
              <button
                onClick={() => setShowBioModal(true)}
                className="text-[13px] text-white font-semibold hover:underline mt-1"
              >
                Read more
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Bio Modal */}
      {showBioModal && bio && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowBioModal(false)}
        >
          <div
            className="bg-th-elevated rounded-xl shadow-2xl max-w-[700px] w-[90%] max-h-[80vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header: avatar + name + close */}
            <div className="flex items-center gap-3 px-6 pt-5 pb-4">
              <div className="w-11 h-11 shrink-0 rounded-full overflow-hidden bg-th-surface-hover">
                {picture ? (
                  <img
                    src={getTidalImageUrl(picture, 160)}
                    alt={displayName}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <User size={20} className="text-th-text-faint" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-[15px] font-bold text-white leading-tight">
                  {displayName}
                </h3>
                <p className="text-[13px] text-th-text-muted">Biography</p>
              </div>
              <button
                onClick={() => setShowBioModal(false)}
                className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center hover:bg-th-inset transition-colors text-th-text-muted hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            {/* Bio text */}
            <div className="px-6 pb-6 overflow-y-auto scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent">
              {cleanBio(bio)
                .split(/\n\n|\n/)
                .filter((p) => p.trim())
                .map((paragraph, i) => (
                  <p
                    key={i}
                    className="text-[14px] text-th-text-secondary leading-[1.7] mb-4 last:mb-0"
                  >
                    {paragraph.trim()}
                  </p>
                ))}
              <p className="text-[12px] text-th-text-faint mt-6 italic">
                Artist bio from TiVo
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Play button */}
      <div className="px-8 py-5 flex items-center gap-5">
        <button
          onClick={handlePlayAll}
          className="w-14 h-14 bg-th-accent rounded-full flex items-center justify-center shadow-xl hover:scale-105 hover:brightness-110 transition-[transform,filter] duration-150"
        >
          {artistPlaying ? (
            <Pause size={24} fill="black" className="text-black" />
          ) : (
            <Play size={24} fill="black" className="text-black ml-1" />
          )}
        </button>
      </div>

      {/* Top Tracks */}
      {topTracks.length > 0 && (
        <div className="px-8 pb-6">
          <h2 className="text-[22px] font-bold text-white mb-4">
            Popular tracks
          </h2>
          <div className="flex flex-col">
            {displayTracks.map((track, index) => {
              const isActive = isCurrentTrackRow(track);
              const playing = isCurrentlyPlaying(track);

              return (
                <div
                  key={`${track.id}-${index}`}
                  onClick={() => handlePlayTrack(track, index)}
                  className={`grid grid-cols-[36px_1fr_minmax(140px,1fr)_72px] gap-4 px-4 py-2.5 rounded-md cursor-pointer group transition-colors ${
                    isActive ? "bg-[#ffffff0a]" : "hover:bg-[#ffffff08]"
                  }`}
                >
                  <div className="flex items-center justify-end">
                    {playing ? (
                      <div className="flex items-end gap-[3px] h-4">
                        <span className="w-[3px] h-full bg-th-accent rounded-full playing-bar" />
                        <span
                          className="w-[3px] h-full bg-th-accent rounded-full playing-bar"
                          style={{ animationDelay: "0.2s" }}
                        />
                        <span
                          className="w-[3px] h-full bg-th-accent rounded-full playing-bar"
                          style={{ animationDelay: "0.4s" }}
                        />
                      </div>
                    ) : (
                      <>
                        <span
                          className={`text-[15px] tabular-nums group-hover:hidden ${
                            isActive ? "text-th-accent" : "text-th-text-muted"
                          }`}
                        >
                          {index + 1}
                        </span>
                        <Play
                          size={14}
                          fill="white"
                          className="text-white hidden group-hover:block"
                        />
                      </>
                    )}
                  </div>

                  <div className="flex items-center gap-3 min-w-0">
                    <div className="relative w-10 h-10 shrink-0 rounded bg-th-surface-hover overflow-hidden">
                      <TidalImage
                        src={getTidalImageUrl(track.album?.cover, 160)}
                        alt={track.album?.title || track.title}
                        className="w-full h-full"
                      />
                    </div>
                    <div className="flex flex-col justify-center min-w-0">
                      <span
                        className={`text-[15px] font-medium truncate leading-snug ${
                          isActive ? "text-th-accent" : "text-white"
                        }`}
                      >
                        {track.title}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center min-w-0">
                    <span
                      className="text-[14px] text-th-text-muted truncate hover:text-white hover:underline transition-colors cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (track.album?.id) {
                          navigateToAlbum(track.album.id, {
                            title: track.album.title,
                            cover: track.album.cover,
                            artistName: track.artist?.name,
                          });
                        }
                      }}
                    >
                      {track.album?.title || ""}
                    </span>
                  </div>

                  <div className="flex items-center justify-end text-[14px] text-th-text-muted tabular-nums">
                    {formatDuration(track.duration)}
                  </div>
                </div>
              );
            })}
          </div>
          {topTracks.length > 5 && (
            <button
              onClick={() => setShowAllTracks(!showAllTracks)}
              className="mt-3 px-4 py-2 text-[13px] font-bold text-th-text-muted hover:text-white transition-colors"
            >
              {showAllTracks
                ? "Show less"
                : `See all ${topTracks.length} tracks`}
            </button>
          )}
        </div>
      )}

      {/* Albums / Discography */}
      {albums.length > 0 && (
        <div className="px-8 pb-8">
          <h2 className="text-[22px] font-bold text-white mb-4">Discography</h2>
          <div className="flex gap-4 overflow-x-auto no-scrollbar scroll-smooth pb-2">
            {albums.map((album) => (
              <div
                key={album.id}
                onClick={() =>
                  navigateToAlbum(album.id, {
                    title: album.title,
                    cover: album.cover,
                    artistName: album.artist?.name,
                  })
                }
                onContextMenu={(e) => handleAlbumContextMenu(e, album)}
                className="flex-shrink-0 w-[180px] p-3 bg-th-elevated hover:bg-th-surface-hover rounded-lg cursor-pointer group transition-[background-color] duration-300"
              >
                <div className="w-full aspect-square mb-3 relative overflow-hidden shadow-lg bg-th-surface-hover rounded-md">
                  {album.cover ? (
                    <TidalImage
                      src={getTidalImageUrl(album.cover, 320)}
                      alt={album.title}
                      className="w-full h-full"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-th-button to-th-surface">
                      <Music size={40} className="text-gray-600" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigateToAlbum(album.id, {
                        title: album.title,
                        cover: album.cover,
                        artistName: album.artist?.name,
                      });
                    }}
                    className="absolute bottom-2 right-2 w-10 h-10 bg-th-accent rounded-full flex items-center justify-center shadow-xl opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-[opacity,transform] duration-300 scale-90 group-hover:scale-100 hover:scale-110"
                  >
                    <Play size={20} fill="black" className="text-black ml-1" />
                  </button>
                </div>
                <h4 className="font-bold text-[14px] text-white truncate mb-1">
                  {album.title}
                </h4>
                <p className="text-[12px] text-th-text-muted">
                  {album.releaseDate
                    ? new Date(album.releaseDate).getFullYear()
                    : ""}
                  {album.numberOfTracks
                    ? ` · ${album.numberOfTracks} tracks`
                    : ""}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {topTracks.length === 0 && albums.length === 0 && (
        <div className="px-8 py-16 text-center">
          <User size={48} className="text-th-text-disabled mx-auto mb-4" />
          <p className="text-white font-semibold text-lg mb-2">
            No content available
          </p>
          <p className="text-th-text-muted text-sm">
            This artist doesn't have any tracks or albums yet.
          </p>
        </div>
      )}

      {/* Media context menu */}
      {contextMenu && (
        <MediaContextMenu
          item={contextMenu.item}
          cursorPosition={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
