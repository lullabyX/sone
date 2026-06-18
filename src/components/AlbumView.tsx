import {
  Music,
  Loader2,
  Heart,
  Shuffle,
  MoreHorizontal,
  Share,
} from "lucide-react";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useToast } from "../contexts/ToastContext";
import SourcePlayButton from "./SourcePlayButton";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useFavorites } from "../hooks/useFavorites";
import { useNavigation } from "../hooks/useNavigation";
import { getAlbumPage } from "../api/tidal";
import { getApiStatus, safeErrorMessage } from "../lib/errorUtils";
import NotFoundPage from "./NotFoundPage";
import {
  type Track,
  type AlbumPageResponse,
  type MediaItemType,
} from "../types";
import TidalVideoCover from "./TidalVideoCover";
import CoverBanner from "./CoverBanner";
import { getTidalImageUrl, getTidalArtistImageUrl } from "../types";
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
  getShareUrl,
  getMediaQualityBadge,
  formatTotalDuration,
} from "../utils/itemHelpers";

interface AlbumViewProps {
  albumId: number;
  albumInfo?: { title: string; cover?: string; artistName?: string };
  onBack: () => void;
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
  const { playTrack, setShuffledQueue, playFromSource, playAllFromSource } =
    usePlaybackActions();
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
  const { showToast } = useToast();

  const [pageData, setPageData] = useState<AlbumPageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [favoritePending, setFavoritePending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const albumFavorited = favoriteAlbumIds.has(albumId);

  useEffect(() => {
    let cancelled = false;

    const loadAlbum = async () => {
      setLoading(true);
      setError(null);
      setNotFound(false);

      try {
        const { page } = await getAlbumPage(albumId);
        if (!cancelled) {
          setPageData(page);
        }
      } catch (err: any) {
        if (!cancelled) {
          console.error("Failed to load album:", err);
          if (getApiStatus(err) === 404) {
            setNotFound(true);
          } else {
            setError(safeErrorMessage(err, "Failed to load album"));
          }
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

  const displayTitle = album?.title || albumInfo?.title || "Album";
  const displayCover = album?.cover || albumInfo?.cover;
  const artistPicture = album?.artists?.[0]?.picture ?? album?.artist?.picture;
  const releaseYear = album?.releaseDate
    ? new Date(album.releaseDate).getFullYear()
    : null;
  const totalDuration = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  const headerDuration = album?.duration ?? totalDuration;
  const qualityBadge = getMediaQualityBadge(
    album?.mediaMetadata,
    album?.audioQuality,
  );
  const qualityBadgeClass =
    qualityBadge?.tier === "max"
      ? "bg-th-accent text-black"
      : qualityBadge?.tier === "hifi"
        ? "bg-th-accent/70 text-black"
        : "bg-th-button-hover text-th-text-primary";

  const albumMediaItem: MediaItemType = {
    id: albumId,
    title: displayTitle,
    type: "album",
    cover: displayCover,
    artistName:
      album?.artist?.name || album?.artists?.[0]?.name || albumInfo?.artistName,
  };

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(getShareUrl(albumMediaItem));
      showToast("Copied share link to clipboard");
    } catch {
      showToast("Failed to copy link", "error");
    }
  };

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

  if (notFound) {
    return <NotFoundPage />;
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

  return (
    <div className="flex-1 bg-linear-to-b from-th-surface to-th-base overflow-y-auto scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent">
      {/* Album Header */}
      <div className="relative">
        <CoverBanner
          src={getTidalImageUrl(displayCover, 1280)}
          variant="dark"
        />
        <PageContainer>
          <div className="px-8 pb-8 pt-8 flex items-end gap-7 relative z-10">
            <div className="w-[232px] h-[232px] shrink-0 rounded-lg overflow-hidden shadow-[0_16px_48px_8px_rgba(0,0,0,0.55)] bg-th-surface-hover">
              <TidalVideoCover
                cover={displayCover}
                videoCover={album?.videoCover}
                size={640}
                alt={displayTitle}
                className="w-full h-full"
              />
            </div>
            <div className="flex flex-col gap-2 pb-2 min-w-0">
              <span className="text-[12px] font-bold text-th-text-secondary uppercase tracking-widest">
                Album
              </span>
              <h1 className="text-[42px] font-extrabold text-th-text-primary leading-none tracking-tight line-clamp-2">
                {displayTitle}
              </h1>
              <div className="flex items-center gap-2 mt-2 min-w-0 text-[14px]">
                {artistPicture && (
                  <img
                    src={getTidalArtistImageUrl(artistPicture, 160)}
                    alt=""
                    className="w-6 h-6 rounded-full object-cover shrink-0 bg-th-surface-hover"
                  />
                )}
                <span className="text-th-text-primary font-semibold truncate">
                  <TrackArtists
                    artists={album?.artists}
                    artist={album?.artist}
                    className="hover:underline cursor-pointer"
                    fallback={albumInfo?.artistName || "Unknown Artist"}
                  />
                </span>
              </div>

              {(album?.numberOfTracks != null || headerDuration > 0) && (
                <div className="text-[12px] text-th-text-muted uppercase tracking-wide">
                  {album?.numberOfTracks != null && (
                    <span>
                      {album.numberOfTracks} TRACK
                      {album.numberOfTracks !== 1 ? "S" : ""}
                    </span>
                  )}
                  {headerDuration > 0 && (
                    <span> ({formatTotalDuration(headerDuration)})</span>
                  )}
                </div>
              )}

              {(releaseYear || qualityBadge) && (
                <div className="flex items-center gap-2 text-[12px] text-th-text-muted">
                  {releaseYear && <span>{releaseYear}</span>}
                  {qualityBadge && (
                    <span
                      className={`px-2 py-0.5 text-[10px] font-black rounded tracking-wider leading-none ${qualityBadgeClass}`}
                    >
                      {qualityBadge.label}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Play Controls */}
          <div className="px-8 py-5 flex items-center justify-between relative z-10">
            <div className="flex items-center gap-3">
              <SourcePlayButton
                sourceType="album"
                sourceId={albumId}
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
            <div className="flex items-end gap-6 relative">
              <button
                onClick={handleToggleFavorite}
                disabled={favoritePending}
                className={`flex flex-col items-center gap-1.5 transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                  albumFavorited
                    ? "text-th-accent hover:brightness-110"
                    : "text-th-text-muted hover:text-th-text-primary"
                }`}
                title={
                  albumFavorited ? "Remove from favorites" : "Add to favorites"
                }
                aria-label={
                  albumFavorited ? "Unfavorite album" : "Favorite album"
                }
              >
                {favoritePending ? (
                  <Loader2 size={22} className="animate-spin" />
                ) : (
                  <Heart
                    size={22}
                    fill={albumFavorited ? "currentColor" : "none"}
                    strokeWidth={albumFavorited ? 0 : 2}
                  />
                )}
                <span className="text-[11px] font-medium">
                  {albumFavorited ? "Added" : "Add"}
                </span>
              </button>

              <button
                onClick={handleShare}
                className="flex flex-col items-center gap-1.5 text-th-text-muted hover:text-th-text-primary transition-colors"
                title="Copy share link"
                aria-label="Share album"
              >
                <Share size={22} />
                <span className="text-[11px] font-medium">Share</span>
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setContextMenu({ x: e.clientX, y: e.clientY });
                }}
                className="flex flex-col items-center gap-1.5 text-th-text-muted hover:text-th-text-primary transition-colors"
                title="More options"
                aria-label="More options"
              >
                <MoreHorizontal size={22} />
                <span className="text-[11px] font-medium">More</span>
              </button>

              {contextMenu && (
                <MediaContextMenu
                  cursorPosition={contextMenu}
                  item={albumMediaItem}
                  onClose={() => setContextMenu(null)}
                />
              )}
            </div>
          </div>
        </PageContainer>
      </div>

      <PageContainer>
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
                {totalDuration > 0 &&
                  ` (${formatTotalDuration(totalDuration)})`}
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
