import { Play, Pause, User, X, Shuffle, UserPlus, UserCheck, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import { useAtomValue } from "jotai";
import { isPlayingAtom, currentTrackAtom } from "../atoms/playback";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useFavorites } from "../hooks/useFavorites";
import { useNavigation } from "../hooks/useNavigation";
import { getArtistPage } from "../api/tidal";
import {
  getTidalImageUrl,
  type ArtistPageData,
  type ArtistPageSection,
  type MediaItemType,
} from "../types";
import MediaCard from "./MediaCard";
import MediaContextMenu from "./MediaContextMenu";
import TrackContextMenu from "./TrackContextMenu";
import TrackList from "./TrackList";
import { ArtistPageSkeleton } from "./PageSkeleton";
import {
  getItemImage,
  getItemTitle,
  getItemSubtitle,
  getItemId,
  isMixItem,
} from "../utils/itemHelpers";

interface ArtistPageProps {
  artistId: number;
  artistInfo?: { name: string; picture?: string };
  onBack: () => void;
}



/** Strip Tidal's wimpLink markup and HTML tags from bio text */
function cleanBio(raw: string): string {
  return (
    raw
      .replace(/\[wimpLink[^\]]*\]/g, "")
      .replace(/\[\/wimpLink\]/g, "")
      .replace(/\[[^\]]*\]/g, "")
      .replace(/<[^>]*>/g, "")
      .trim()
  );
}

export default function ArtistPage({
  artistId,
  artistInfo,
  onBack,
}: ArtistPageProps) {
  const isPlaying = useAtomValue(isPlayingAtom);
  const currentTrack = useAtomValue(currentTrackAtom);
  const { playTrack, setQueueTracks, pauseTrack, resumeTrack } =
    usePlaybackActions();
  const { followedArtistIds, followArtist, unfollowArtist,
    favoriteAlbumIds, addFavoriteAlbum, removeFavoriteAlbum,
    favoritePlaylistUuids, addFavoritePlaylist, removeFavoritePlaylist,
    favoriteMixIds, addFavoriteMix, removeFavoriteMix,
  } = useFavorites();
  const { navigateToAlbum, navigateToArtist, navigateToArtistTracks, navigateToPlaylist, navigateToMix, navigateToViewAll } = useNavigation();
  const isFollowed = followedArtistIds.has(artistId);

  const [pageData, setPageData] = useState<ArtistPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showBioModal, setShowBioModal] = useState(false);

  const [contextMenu, setContextMenu] = useState<{
    item: MediaItemType;
    position: { x: number; y: number };
  } | null>(null);

  const [trackContextMenu, setTrackContextMenu] = useState<{
    track: any;
    index: number;
    position: { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadArtist = async () => {
      setLoading(true);
      setError(null);

      try {
        const data = await getArtistPage(artistId);
        if (!cancelled) {
          setPageData(data);
        }
      } catch (err: any) {
        if (!cancelled) {
          console.error("Failed to load artist:", err);
          const msg = err?.message;
          setError(typeof msg === "string" ? msg : "Failed to load artist");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadArtist();
    return () => { cancelled = true; };
  }, [artistId]);

  // Derived state from pageData
  const displayName = pageData?.artistName || artistInfo?.name || "Artist";
  const picture = pageData?.picture || artistInfo?.picture;
  const bio = pageData?.bio || "";
  const bioSource = pageData?.bioSource;
  const topTracks = pageData?.topTracks || [];

  const trackIds = useMemo(
    () => new Set(topTracks.map((t: any) => t.id).filter(Boolean)),
    [topTracks]
  );

  const handlePlayTrack = async (track: any, index: number, trackList: any[]) => {
    try {
      setQueueTracks(trackList.slice(index + 1));
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

  const handleShuffle = async () => {
    if (topTracks.length === 0) return;
    const shuffled = [...topTracks];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    try {
      setQueueTracks(shuffled.slice(1));
      await playTrack(shuffled[0]);
    } catch (err) {
      console.error("Failed to shuffle artist tracks:", err);
    }
  };

  const handleToggleFollow = async () => {
    try {
      if (isFollowed) {
        await unfollowArtist(artistId);
      } else {
        await followArtist(artistId, { id: artistId, name: displayName, picture });
      }
    } catch (err) {
      console.error("Failed to toggle follow:", err);
    }
  };

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
      } else if (sectionType === "PLAYLIST_LIST") {
        mediaItem = {
          type: "playlist",
          uuid: item.uuid,
          title: item.title || getItemTitle(item),
          image: item.squareImage || item.image,
          creatorName: item.creator?.name,
        };
      } else if (sectionType === "ARTIST_LIST") {
        mediaItem = {
          type: "artist",
          id: item.id,
          name: item.name || getItemTitle(item),
          picture: item.picture,
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
        setContextMenu({ item: mediaItem, position: { x: e.clientX, y: e.clientY } });
      }
    },
    []
  );

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
    [navigateToAlbum, navigateToArtist, navigateToPlaylist, navigateToMix]
  );

  const artistPlaying = !!(
    currentTrack &&
    trackIds.has(currentTrack.id) &&
    isPlaying
  );

  if (loading) {
    return <ArtistPageSkeleton />;
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
              {bioSource && (
                <p className="text-[12px] text-th-text-faint mt-6 italic">
                  Artist bio from {bioSource}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Play Controls */}
      <div className="px-8 py-5 flex items-center gap-3">
        <button
          onClick={handlePlayAll}
          className="flex items-center gap-2 px-6 py-2.5 bg-th-accent text-black font-bold text-sm rounded-full shadow-lg hover:brightness-110 hover:scale-[1.03] transition-[transform,filter] duration-150"
        >
          {artistPlaying ? (
            <Pause size={18} fill="black" className="text-black" />
          ) : (
            <Play size={18} fill="black" className="text-black" />
          )}
          {artistPlaying ? "Pause" : "Play"}
        </button>
        <button
          onClick={handleShuffle}
          className="flex items-center gap-2 px-6 py-2.5 bg-th-button text-white font-bold text-sm rounded-full hover:bg-th-button-hover hover:scale-[1.03] transition-[transform,filter,background-color] duration-150"
        >
          <Shuffle size={18} />
          Shuffle
        </button>
        <button
          onClick={handleToggleFollow}
          className={`flex items-center justify-center gap-2 min-w-[120px] px-5 py-2.5 font-bold text-sm rounded-full transition-[transform,filter,background-color] duration-150 hover:scale-[1.03] ${
            isFollowed
              ? "bg-th-accent/15 text-th-accent border border-th-accent/30 hover:brightness-110"
              : "bg-th-button text-white border border-transparent hover:bg-th-button-hover"
          }`}
        >
          {isFollowed ? <UserCheck size={18} /> : <UserPlus size={18} />}
          {isFollowed ? "Following" : "Follow"}
        </button>
      </div>

      {/* Dynamic Sections */}
      {pageData?.sections.map((section, sectionIdx) => {
        if (!section.items || section.items.length === 0) return null;

        if (section.type === "TRACK_LIST") {
          return (
            <TrackSection
              key={sectionIdx}
              section={section}
              onPlayTrack={handlePlayTrack}
              onViewAll={() => navigateToArtistTracks(artistId, displayName)}
            />
          );
        }

        if (["ALBUM_LIST", "ARTIST_LIST", "PLAYLIST_LIST", "MIX_LIST"].includes(section.type)) {
          return (
            <CardScrollSection
              key={sectionIdx}
              section={section}
              onCardClick={handleCardClick}
              onContextMenu={handleCardContextMenu}
              onViewAll={section.apiPath ? () => navigateToViewAll(section.title, section.apiPath!, artistId) : undefined}
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
        }

        return null;
      })}

      {/* Empty state */}
      {pageData && pageData.sections.length === 0 && topTracks.length === 0 && (
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

      {contextMenu && (
        <MediaContextMenu
          item={contextMenu.item}
          cursorPosition={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}

      {trackContextMenu && (
        <TrackContextMenu
          track={trackContextMenu.track}
          index={trackContextMenu.index}
          cursorPosition={trackContextMenu.position}
          anchorRef={{ current: null }}
          onClose={() => setTrackContextMenu(null)}
        />
      )}
    </div>
  );
}

// ==================== Track Section ====================

function TrackSection({
  section,
  onPlayTrack,
  onViewAll,
}: {
  section: ArtistPageSection;
  onPlayTrack: (track: any, index: number, trackList: any[]) => void;
  onViewAll: () => void;
}) {
  const items = section.items || [];
  const displayTracks = useMemo(() => items.slice(0, 10).map((t: any) => {
    if (!t.artist && t.artists?.[0]) return { ...t, artist: t.artists[0] };
    return t;
  }), [items]);

  const handlePlay = useCallback(
    (track: any, index: number) => onPlayTrack(track, index, items),
    [onPlayTrack, items]
  );

  return (
    <div className="px-8 pb-6">
      <div className="flex items-center justify-between mb-4">
        {section.title && (
          <h2 className="text-[22px] font-bold text-white tracking-tight">
            {section.title}
          </h2>
        )}
        {section.apiPath && (
          <button
            onClick={onViewAll}
            className="px-3 py-1.5 text-[13px] font-bold text-th-text-muted hover:text-white transition-colors"
          >
            View all
          </button>
        )}
      </div>
      <TrackList
        tracks={displayTracks}
        onPlay={handlePlay}
        showAlbum={true}
        showCover={true}
        showArtist={false}
        showDateAdded={false}
      />
    </div>
  );
}

// ==================== Card Scroll Section ====================

function CardScrollSection({
  section,
  onCardClick,
  onContextMenu,
  onViewAll,
  favoriteAlbumIds, addFavoriteAlbum, removeFavoriteAlbum,
  favoritePlaylistUuids, addFavoritePlaylist, removeFavoritePlaylist,
  followedArtistIds, followArtist, unfollowArtist,
  favoriteMixIds, addFavoriteMix, removeFavoriteMix,
}: {
  section: ArtistPageSection;
  onCardClick: (item: any, sectionType: string) => void;
  onContextMenu: (e: React.MouseEvent, item: any, sectionType: string) => void;
  onViewAll?: () => void;
  favoriteAlbumIds: Set<number>;
  addFavoriteAlbum: (id: number, album: any) => void;
  removeFavoriteAlbum: (id: number) => void;
  favoritePlaylistUuids: Set<string>;
  addFavoritePlaylist: (uuid: string, playlist: any) => void;
  removeFavoritePlaylist: (uuid: string) => void;
  followedArtistIds: Set<number>;
  followArtist: (id: number, detail: any) => void;
  unfollowArtist: (id: number) => void;
  favoriteMixIds: Set<string>;
  addFavoriteMix: (id: string) => void;
  removeFavoriteMix: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 10);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 10);
  };

  const scroll = (direction: "left" | "right") => {
    const el = scrollRef.current;
    if (!el) return;
    const scrollAmount = el.clientWidth * 0.8;
    el.scrollBy({
      left: direction === "left" ? -scrollAmount : scrollAmount,
      behavior: "smooth",
    });
  };

  const sectionType = section.type;
  const isArtistSection = sectionType === "ARTIST_LIST";

  return (
    <div className="px-8 pb-8">
      <div className="flex items-center justify-between mb-4">
        {section.title && (
          <h2 className="text-[22px] font-bold text-white tracking-tight">
            {section.title}
          </h2>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={() => scroll("left")}
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
              canScrollLeft
                ? "bg-th-inset hover:bg-th-inset-hover text-white"
                : "text-th-text-disabled cursor-default"
            }`}
            disabled={!canScrollLeft}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            onClick={() => scroll("right")}
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
              canScrollRight
                ? "bg-th-inset hover:bg-th-inset-hover text-white"
                : "text-th-text-disabled cursor-default"
            }`}
            disabled={!canScrollRight}
          >
            <ChevronRight size={18} />
          </button>
          {onViewAll && (
            <button
              onClick={onViewAll}
              className="px-3 py-1.5 text-[13px] font-bold text-th-text-muted hover:text-white transition-colors"
            >
              View all
            </button>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex gap-4 overflow-x-auto no-scrollbar scroll-smooth pb-2"
      >
        {section.items.map((item: any) => {
          let isFavorited: boolean | undefined;
          let onFavoriteToggle: ((e: React.MouseEvent) => void) | undefined;

          if (sectionType === "ALBUM_LIST" && item.id) {
            isFavorited = favoriteAlbumIds.has(item.id);
            onFavoriteToggle = (e) => {
              e.stopPropagation();
              if (favoriteAlbumIds.has(item.id)) removeFavoriteAlbum(item.id);
              else addFavoriteAlbum(item.id, item);
            };
          } else if (sectionType === "ARTIST_LIST" && item.id) {
            isFavorited = followedArtistIds.has(item.id);
            onFavoriteToggle = (e) => {
              e.stopPropagation();
              if (followedArtistIds.has(item.id)) unfollowArtist(item.id);
              else followArtist(item.id, { id: item.id, name: item.name, picture: item.picture });
            };
          } else if (sectionType === "PLAYLIST_LIST" && item.uuid) {
            isFavorited = favoritePlaylistUuids.has(item.uuid);
            onFavoriteToggle = (e) => {
              e.stopPropagation();
              if (favoritePlaylistUuids.has(item.uuid)) removeFavoritePlaylist(item.uuid);
              else addFavoritePlaylist(item.uuid, item);
            };
          } else if (sectionType === "MIX_LIST") {
            const mixId = item.mixId || item.id?.toString();
            if (mixId) {
              isFavorited = favoriteMixIds.has(mixId);
              onFavoriteToggle = (e) => {
                e.stopPropagation();
                if (favoriteMixIds.has(mixId)) removeFavoriteMix(mixId);
                else addFavoriteMix(mixId);
              };
            }
          }

          return (
            <MediaCard
              key={getItemId(item)}
              item={item}
              onClick={() => onCardClick(item, sectionType)}
              onContextMenu={(e) => onContextMenu(e, item, sectionType)}
              isArtist={isArtistSection}
              showPlayButton
              isFavorited={isFavorited}
              onFavoriteToggle={onFavoriteToggle}
              widthClass="w-[180px] flex-shrink-0"
            />
          );
        })}
      </div>
    </div>
  );
}
