import {
  Play,
  Pause,
  Music,
  Loader2,
  Heart,
  Shuffle,
  MoreHorizontal,
} from "lucide-react";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useAtomValue } from "jotai";
import { isPlayingAtom, currentTrackAtom } from "../atoms/playback";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useFavorites } from "../hooks/useFavorites";
import { useNavigation } from "../hooks/useNavigation";
import { getAlbumPage } from "../api/tidal";
import {
  getTidalImageUrl,
  type Track,
  type AlbumPageResponse,
  type MediaItemType,
} from "../types";
import TidalImage from "./TidalImage";
import TrackList from "./TrackList";
import { TrackArtists } from "./TrackArtists";
import MediaContextMenu from "./MediaContextMenu";
import { DetailPageSkeleton } from "./PageSkeleton";
import CardScrollSection from "./CardScrollSection";
import PageContainer from "./PageContainer";
import {
  getItemTitle,
  getItemSubtitle,
  getItemImage,
  isMixItem,
} from "../utils/itemHelpers";

interface AlbumViewProps {
  albumId: number;
  albumInfo?: { title: string; cover?: string; artistName?: string };
  onBack: () => void;
}

function formatTotalDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, "0")}:${String(secs).padStart(
      2,
      "0",
    )}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function formatReleaseDateLong(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d
      .toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })
      .toUpperCase();
  } catch {
    return dateStr.toUpperCase();
  }
}

export default function AlbumView({
  albumId,
  albumInfo,
  onBack,
}: AlbumViewProps) {
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
  const {
    favoriteAlbumIds,
    addFavoriteAlbum,
    removeFavoriteAlbum,
    favoritePlaylistUuids,
    addFavoritePlaylist,
    removeFavoritePlaylist,
    followedArtistIds,
    followArtist,
    unfollowArtist,
    favoriteMixIds,
    addFavoriteMix,
    removeFavoriteMix,
  } = useFavorites();
  const {
    navigateToAlbum,
    navigateToArtist,
    navigateToPlaylist,
    navigateToMix,
    navigateToViewAll,
  } = useNavigation();

  const [pageData, setPageData] = useState<AlbumPageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [favoritePending, setFavoritePending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const albumFavorited = favoriteAlbumIds.has(albumId);

  useEffect(() => {
    let cancelled = false;

    const loadAlbum = async () => {
      setLoading(true);
      setError(null);

      try {
        const { page } = await getAlbumPage(albumId);
        if (!cancelled) {
          setPageData(page);
        }
      } catch (err: any) {
        if (!cancelled) {
          console.error("Failed to load album:", err);
          const msg = err?.message;
          setError(typeof msg === "string" ? msg : "Failed to load album");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadAlbum();
    return () => {
      cancelled = true;
    };
  }, [albumId]);

  const album = pageData?.album ?? null;
  const tracks = pageData?.tracks ?? [];
  const sections = pageData?.sections ?? [];
  const copyright = pageData?.copyright;

  // Group tracks by volume for multi-disc albums
  const volumeGroups = useMemo(() => {
    const groups = new Map<number, Track[]>();
    for (const track of tracks) {
      const vol = track.volumeNumber ?? 1;
      let group = groups.get(vol);
      if (!group) {
        group = [];
        groups.set(vol, group);
      }
      group.push(track);
    }
    return groups;
  }, [tracks]);
  const isMultiVolume = volumeGroups.size > 1;

  const albumSource = {
    type: "album" as const,
    id: albumId,
    name: album?.title || albumInfo?.title || "Album",
    allTracks: tracks,
  };

  const handlePlayTrack = async (track: Track, _index: number) => {
    try {
      await playFromSource(track, tracks, {
        albumMode: true,
        source: albumSource,
      });
    } catch (err) {
      console.error("Failed to play track:", err);
    }
  };

  const handlePlayAll = async () => {
    if (tracks.length === 0) return;

    if (currentTrack && currentTrack.album?.id === albumId) {
      if (isPlaying) {
        await pauseTrack();
      } else {
        await resumeTrack();
      }
      return;
    }

    try {
      await playAllFromSource(tracks, { albumMode: true, source: albumSource });
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
    const [first, ...rest] = shuffled;
    try {
      setShuffledQueue(rest, { source: albumSource, albumMode: true });
      await playTrack(first);
    } catch (err) {
      console.error("Failed to shuffle play:", err);
    }
  };

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const handleToggleFavorite = async () => {
    if (favoritePending) return;

    setFavoritePending(true);
    try {
      if (albumFavorited) {
        await removeFavoriteAlbum(albumId);
      } else {
        await addFavoriteAlbum(albumId, album ?? undefined);
      }
    } catch (err) {
      console.error("Failed to toggle album favorite:", err);
    } finally {
      setFavoritePending(false);
    }
  };

  const albumPlaying =
    currentTrack && currentTrack.album?.id === albumId && isPlaying;

  const displayTitle = album?.title || albumInfo?.title || "Album";
  const displayCover = album?.cover || albumInfo?.cover;
  const [sectionContextMenu, setSectionContextMenu] = useState<{
    item: MediaItemType;
    position: { x: number; y: number };
  } | null>(null);

  const handleCardClick = useCallback(
    (item: any, sectionType: string) => {
      if (sectionType === "ALBUM_LIST") {
        navigateToAlbum(item.id, {
          title: item.title,
          cover: item.cover,
          artistName: item.artist?.name || item.artists?.[0]?.name,
        });
      } else if (sectionType === "ARTIST_LIST") {
        navigateToArtist(item.id, {
          name: item.name || getItemTitle(item),
          picture: item.picture,
        });
      } else if (sectionType === "PLAYLIST_LIST") {
        navigateToPlaylist(item.uuid, {
          title: item.title,
          image: item.squareImage || item.image,
          description: item.description,
          creatorName: item.creator?.name,
          numberOfTracks: item.numberOfTracks,
        });
      } else if (isMixItem(item, sectionType)) {
        const mixId = item.mixId || item.id?.toString();
        if (mixId) {
          navigateToMix(mixId, {
            title: getItemTitle(item),
            image: getItemImage(item),
            subtitle: getItemSubtitle(item),
          });
        }
      }
    },
    [navigateToAlbum, navigateToArtist, navigateToPlaylist, navigateToMix],
  );

  const handleCardContextMenu = useCallback(
    (e: React.MouseEvent, item: any, sectionType: string) => {
      e.preventDefault();
      e.stopPropagation();
      let mediaItem: MediaItemType | null = null;

      if (sectionType === "ALBUM_LIST") {
        mediaItem = {
          type: "album",
          id: item.id,
          title: item.title || getItemTitle(item),
          cover: item.cover,
          artistName: item.artist?.name || item.artists?.[0]?.name,
        };
      } else if (sectionType === "ARTIST_LIST") {
        mediaItem = {
          type: "artist",
          id: item.id,
          name: item.name || getItemTitle(item),
          picture: item.picture,
        };
      } else if (sectionType === "PLAYLIST_LIST") {
        mediaItem = {
          type: "playlist",
          uuid: item.uuid,
          title: item.title || getItemTitle(item),
          image: item.squareImage || item.image,
          creatorName: item.creator?.name,
        };
      } else if (isMixItem(item, sectionType)) {
        const mixId = item.mixId || item.id?.toString();
        if (mixId) {
          mediaItem = {
            type: "mix",
            mixId,
            title: getItemTitle(item),
            image: getItemImage(item),
            subtitle: getItemSubtitle(item),
          };
        }
      }

      if (mediaItem) {
        setSectionContextMenu({
          item: mediaItem,
          position: { x: e.clientX, y: e.clientY },
        });
      }
    },
    [],
  );

  if (loading) {
    return <DetailPageSkeleton type="album" />;
  }

  if (error) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center px-8">
          <Music size={48} className="text-th-text-disabled" />
          <p className="text-th-text-primary font-semibold text-lg">
            Couldn't load album
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

  const totalDuration = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);

  return (
    <div className="flex-1 bg-linear-to-b from-th-surface to-th-base overflow-y-auto scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent">
      <PageContainer>
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
          <span className="text-[12px] font-bold text-th-text-secondary uppercase tracking-widest">
            Album
          </span>
          <h1 className="text-[48px] font-extrabold text-th-text-primary leading-none tracking-tight line-clamp-2">
            {displayTitle}
          </h1>
          <div className="flex items-center gap-1.5 text-[14px] text-th-text-muted mt-2">
            <TrackArtists
              artists={album?.artists}
              artist={album?.artist}
              className="text-th-text-primary font-semibold hover:underline cursor-pointer"
              fallback={albumInfo?.artistName || "Unknown Artist"}
            />
            {album?.releaseDate && (
              <>
                <span className="mx-1">&bull;</span>
                <span>{new Date(album.releaseDate).getFullYear()}</span>
              </>
            )}
            {album?.numberOfTracks != null && (
              <>
                <span className="mx-1">&bull;</span>
                <span>
                  {album.numberOfTracks} TRACK
                  {album.numberOfTracks !== 1 ? "S" : ""}
                </span>
              </>
            )}
            {album?.duration != null && album.duration > 0 && (
              <>
                <span className="mx-1">&bull;</span>
                <span>{formatTotalDuration(album.duration)}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Play Controls */}
      <div className="px-8 py-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={handlePlayAll}
            className="flex items-center gap-2 px-6 py-2.5 bg-th-accent text-black font-bold text-sm rounded-full shadow-lg hover:brightness-110 hover:scale-[1.03] transition-[transform,filter] duration-150"
          >
            {albumPlaying ? (
              <Pause size={18} fill="black" className="text-black" />
            ) : (
              <Play size={18} fill="black" className="text-black" />
            )}
            {albumPlaying ? "Pause" : "Play"}
          </button>
          <button
            onClick={handleShuffle}
            className="flex items-center gap-2 px-6 py-2.5 bg-th-button text-th-text-primary font-bold text-sm rounded-full hover:bg-th-button-hover hover:scale-[1.03] transition-[transform,filter,background-color] duration-150"
          >
            <Shuffle size={18} />
            Shuffle
          </button>
        </div>
        <div className="flex items-center gap-2 relative">
          <button
            onClick={handleToggleFavorite}
            disabled={favoritePending}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-[color,filter] duration-150 ${
              albumFavorited
                ? "text-th-accent hover:brightness-110"
                : "text-th-text-muted hover:text-th-text-primary hover:bg-th-hl-med"
            } disabled:opacity-60 disabled:cursor-not-allowed`}
            title={
              albumFavorited ? "Remove from favorites" : "Add to favorites"
            }
            aria-label={albumFavorited ? "Unfavorite album" : "Favorite album"}
          >
            {favoritePending ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <Heart
                size={20}
                fill={albumFavorited ? "currentColor" : "none"}
                strokeWidth={albumFavorited ? 0 : 2}
              />
            )}
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
                id: albumId,
                title: displayTitle,
                type: "album",
                cover: displayCover,
                artistName: album?.artist?.name || album?.artists?.[0]?.name || albumInfo?.artistName,
              }}
              onClose={() => setContextMenu(null)}
            />
          )}
        </div>
      </div>

      {/* Track List */}
      <div className="px-8 pt-4 pb-2">
        {isMultiVolume ? (
          (() => {
            let flatOffset = 0;
            return [...volumeGroups.entries()].map(([vol, volTracks]) => {
              const startOffset = flatOffset;
              flatOffset += volTracks.length;
              return (
                <div key={vol}>
                  <h3
                    className={`text-md font-semibold text-th-text-primary mb-2${
                      vol > 1 ? " mt-6" : ""
                    }`}
                  >
                    Volume {vol}
                  </h3>
                  <TrackList
                    tracks={volTracks}
                    onPlay={(track, localIndex) =>
                      handlePlayTrack(track, startOffset + localIndex)
                    }
                    showDateAdded={false}
                    showArtist={true}
                    showAlbum={false}
                    showCover={false}
                    context="album"
                  />
                </div>
              );
            });
          })()
        ) : (
          <TrackList
            tracks={tracks}
            onPlay={handlePlayTrack}
            showDateAdded={false}
            showArtist={true}
            showAlbum={false}
            showCover={false}
            context="album"
          />
        )}
      </div>

      {/* Album Footer */}
      {tracks.length > 0 && (
        <div className="px-8 pt-4 pb-8">
          <div className="text-[13px] text-th-text-disabled">
            {album?.releaseDate && (
              <span>{formatReleaseDateLong(album.releaseDate)}</span>
            )}
            {album?.releaseDate && <span className="mx-1.5">&bull;</span>}
            <span>
              {tracks.length} TRACK{tracks.length !== 1 ? "S" : ""}
              {totalDuration > 0 && ` (${formatTotalDuration(totalDuration)})`}
            </span>
          </div>
          {copyright && (
            <div className="text-[12px] text-th-text-disabled mt-1 uppercase">
              {copyright}
            </div>
          )}
        </div>
      )}

      {/* Related Sections */}
      {sections.map((section, idx) => {
        if (!section.items || section.items.length === 0) return null;

        return (
          <CardScrollSection
            key={idx}
            section={section}
            onCardClick={handleCardClick}
            onContextMenu={handleCardContextMenu}
            onViewAll={
              section.apiPath
                ? () => navigateToViewAll(section.title, section.apiPath!)
                : undefined
            }
            favoriteAlbumIds={favoriteAlbumIds}
            addFavoriteAlbum={addFavoriteAlbum}
            removeFavoriteAlbum={removeFavoriteAlbum}
            favoritePlaylistUuids={favoritePlaylistUuids}
            addFavoritePlaylist={addFavoritePlaylist}
            removeFavoritePlaylist={removeFavoritePlaylist}
            followedArtistIds={followedArtistIds}
            followArtist={followArtist}
            unfollowArtist={unfollowArtist}
            favoriteMixIds={favoriteMixIds}
            addFavoriteMix={addFavoriteMix}
            removeFavoriteMix={removeFavoriteMix}
          />
        );
      })}

      </PageContainer>

      {sectionContextMenu && (
        <MediaContextMenu
          item={sectionContextMenu.item}
          cursorPosition={sectionContextMenu.position}
          onClose={() => setSectionContextMenu(null)}
        />
      )}
    </div>
  );
}
