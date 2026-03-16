import { useRef, useState, useCallback } from "react";
import {
  Play,
  ChevronLeft,
  ChevronRight,
  Music,
  Heart,
  MoreHorizontal,
} from "lucide-react";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useMediaPlay } from "../hooks/useMediaPlay";
import { useNavigation } from "../hooks/useNavigation";
import { useFavorites } from "../hooks/useFavorites";
import {
  type HomeSection as HomeSectionType,
  type MediaItemType,
} from "../types";
import MediaContextMenu from "./MediaContextMenu";
import TrackContextMenu from "./TrackContextMenu";
import MediaCard from "./MediaCard";
import { TrackArtists } from "./TrackArtists";
import {
  getItemImage,
  getItemTitle,
  getItemSubtitle,
  getItemId,
  isArtistItem,
  isTrackItem,
  isMixItem,
  isMyTracksItem,
  buildMediaItem,
} from "../utils/itemHelpers";

interface HomeSectionProps {
  section: HomeSectionType;
}

export default function HomeSection({ section }: HomeSectionProps) {
  const { playFromSource } = usePlaybackActions();
  const playMedia = useMediaPlay();
  const {
    navigateToAlbum,
    navigateToPlaylist,
    navigateToViewAll,
    navigateToArtist,
    navigateToMix,
    navigateToFavorites,
  } = useNavigation();
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    item: MediaItemType;
    position: { x: number; y: number };
  } | null>(null);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, item: any) => {
      const mediaItem = buildMediaItem(item, section.sectionType);
      if (mediaItem) {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({
          item: mediaItem,
          position: { x: e.clientX, y: e.clientY },
        });
      }
    },
    [section.sectionType],
  );

  const items = Array.isArray(section.items) ? section.items : [];
  if (items.length === 0) return null;

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 10);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 10);
  };

  const scroll = (direction: "left" | "right") => {
    const el = scrollRef.current;
    if (!el) return;
    const scrollAmount = el.clientWidth + 16; // one full page + gap for exact card alignment
    el.scrollBy({
      left: direction === "left" ? -scrollAmount : scrollAmount,
      behavior: "smooth",
    });
  };

  const handleItemClick = (item: any) => {
    if (isMyTracksItem(item)) {
      navigateToFavorites();
      return;
    }
    if (isTrackItem(item, section.sectionType)) {
      const allTrackItems = items.filter((t: any) =>
        isTrackItem(t, section.sectionType),
      );
      playFromSource(item, allTrackItems, {
        source: {
          type: "home-section",
          id: section.title,
          name: section.title,
          allTracks: allTrackItems,
        },
      });
    } else if (isMixItem(item, section.sectionType)) {
      // Mix or radio station - navigate to mix page
      const mixId = item.mixId || item.id?.toString();
      if (mixId) {
        navigateToMix(mixId, {
          title: getItemTitle(item),
          image: getItemImage(item),
          subtitle: getItemSubtitle(item),
          mixType: item.type || item.mixType,
        });
      }
    } else if (isArtistItem(item, section.sectionType)) {
      // Artist - navigate to artist page
      const artistId = item.id;
      if (artistId) {
        navigateToArtist(artistId, {
          name: item.name || getItemTitle(item),
          picture: item.picture,
        });
      }
    } else if (item.uuid) {
      // Playlist
      navigateToPlaylist(item.uuid, {
        title: item.title,
        image: item.squareImage || item.image,
        description: item.description,
        creatorName:
          item.creator?.name || (item.creator?.id === 0 ? "TIDAL" : undefined),
        numberOfTracks: item.numberOfTracks,
      });
    } else if (item.id) {
      // Album (fallback for items with id that aren't mix/artist)
      navigateToAlbum(item.id, {
        title: item.title,
        cover: item.cover,
        artistName: item.artist?.name || item.artists?.[0]?.name,
      });
    }
  };

  const isTrackSection = section.sectionType === "TRACK_LIST";
  const isCompactGrid =
    section.sectionType === "COMPACT_GRID_CARD" ||
    section.title === "Recently played";

  if (isTrackSection) {
    return <TrackListSection section={section} items={items} />;
  }

  if (isCompactGrid) {
    return (
      <CompactGridSection
        section={section}
        items={items}
        onItemClick={handleItemClick}
      />
    );
  }

  return (
    <section className="mb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[22px] font-bold text-th-text-primary tracking-tight hover:underline cursor-pointer">
          {section.title}
        </h2>
        <div className="flex items-center gap-2">
          {/* Scroll arrows */}
          <button
            onClick={() => scroll("left")}
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
              canScrollLeft
                ? "bg-th-inset hover:bg-th-inset-hover text-th-text-primary"
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
                ? "bg-th-inset hover:bg-th-inset-hover text-th-text-primary"
                : "text-th-text-disabled cursor-default"
            }`}
            disabled={!canScrollRight}
          >
            <ChevronRight size={18} />
          </button>
          {section.hasMore && section.apiPath && (
            <button
              onClick={() => navigateToViewAll(section.title, section.apiPath!)}
              className="text-[13px] font-bold text-th-text-muted hover:text-th-text-primary uppercase tracking-wider transition-colors ml-2"
            >
              View all
            </button>
          )}
        </div>
      </div>

      {/* Horizontal scroll row */}
      <div className="card-scroll">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="card-scroll-track pb-2"
        >
          {items.map((item: any) => {
            const isArtist = isArtistItem(item, section.sectionType);
            const isMix = isMixItem(item, section.sectionType);
            const isTrack = isTrackItem(item, section.sectionType);
            const isPlaylist = !isArtist && !isMix && !isTrack && !!item.uuid;
            const isAlbum =
              !isArtist && !isMix && !isTrack && !item.uuid && item.id;

            let isFavorited: boolean | undefined;
            let onFavoriteToggle: ((e: React.MouseEvent) => void) | undefined;

            if (isAlbum) {
              isFavorited = favoriteAlbumIds.has(item.id);
              onFavoriteToggle = (e) => {
                e.stopPropagation();
                if (favoriteAlbumIds.has(item.id)) {
                  removeFavoriteAlbum(item.id);
                } else {
                  addFavoriteAlbum(item.id, item);
                }
              };
            } else if (isArtist && item.id) {
              isFavorited = followedArtistIds.has(item.id);
              onFavoriteToggle = (e) => {
                e.stopPropagation();
                if (followedArtistIds.has(item.id)) {
                  unfollowArtist(item.id);
                } else {
                  followArtist(item.id, {
                    id: item.id,
                    name: item.name,
                    picture: item.picture,
                  });
                }
              };
            } else if (isPlaylist && item.uuid) {
              isFavorited = favoritePlaylistUuids.has(item.uuid);
              onFavoriteToggle = (e) => {
                e.stopPropagation();
                if (favoritePlaylistUuids.has(item.uuid)) {
                  removeFavoritePlaylist(item.uuid);
                } else {
                  addFavoritePlaylist(item.uuid, item);
                }
              };
            } else if (isMix) {
              const mixId = item.mixId || item.id?.toString();
              if (mixId) {
                isFavorited = favoriteMixIds.has(mixId);
                onFavoriteToggle = (e) => {
                  e.stopPropagation();
                  if (favoriteMixIds.has(mixId)) {
                    removeFavoriteMix(mixId);
                  } else {
                    const img = getItemImage(item);
                    addFavoriteMix(mixId, {
                      id: mixId,
                      title: getItemTitle(item),
                      subTitle: getItemSubtitle(item),
                      mixType: item.type || item.mixType,
                      images: img
                        ? { SMALL: { url: img }, MEDIUM: { url: img } }
                        : undefined,
                    });
                  }
                };
              }
            }

            const mediaItem = buildMediaItem(item, section.sectionType);
            const myTracks = isMyTracksItem(item);

            return (
              <MediaCard
                key={getItemId(item)}
                item={item}
                onClick={() => handleItemClick(item)}
                onContextMenu={
                  myTracks ? undefined : (e) => handleContextMenu(e, item)
                }
                onPlay={
                  mediaItem
                    ? (e) => {
                        e.stopPropagation();
                        playMedia(mediaItem);
                      }
                    : undefined
                }
                isArtist={isArtist}
                isFavorited={isFavorited}
                onFavoriteToggle={onFavoriteToggle}
                widthClass="card-scroll-item"
                {...(myTracks && {
                  titleOverride: "Loved Tracks",
                  imageOverride: (
                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#450af5] via-[#8e2de2] to-[#00d2ff]">
                      <Heart size={40} className="text-white" fill="white" />
                    </div>
                  ),
                  showPlayButton: false,
                })}
              />
            );
          })}
        </div>
      </div>

      {/* Media context menu */}
      {contextMenu && (
        <MediaContextMenu
          item={contextMenu.item}
          cursorPosition={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}
    </section>
  );
}

// Track list section - displayed as rows instead of cards
function TrackListSection({
  section,
  items,
}: {
  section: HomeSectionType;
  items: any[];
}) {
  const { playFromSource } = usePlaybackActions();
  const { navigateToAlbum, navigateToViewAll } = useNavigation();
  const [trackContextMenu, setTrackContextMenu] = useState<{
    track: any;
    index: number;
    position: { x: number; y: number };
  } | null>(null);

  const handlePlayTrack = (item: any, _index: number) => {
    playFromSource(item, items, {
      source: {
        type: "home-section",
        id: section.title,
        name: section.title,
        allTracks: items,
      },
    });
  };

  const openTrackMenu = (e: React.MouseEvent, item: any, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    setTrackContextMenu({
      track: item,
      index,
      position: { x: e.clientX, y: e.clientY },
    });
  };

  // Display up to 16 items in a multi-column grid
  const displayItems = items.slice(0, 16);

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[22px] font-bold text-th-text-primary tracking-tight hover:underline cursor-pointer">
          {section.title}
        </h2>
        {section.hasMore && section.apiPath && (
          <button
            onClick={() => navigateToViewAll(section.title, section.apiPath!)}
            className="text-[13px] font-bold text-th-text-muted hover:text-th-text-primary uppercase tracking-wider transition-colors"
          >
            View all
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-6 gap-y-1">
        {displayItems.map((item: any, idx: number) => (
          <div
            key={getItemId(item)}
            onClick={() => handlePlayTrack(item, idx)}
            onContextMenu={(e) => openTrackMenu(e, item, idx)}
            className="flex items-center gap-3 p-2 rounded-md hover:bg-th-inset cursor-pointer group transition-colors"
          >
            <div className="w-10 h-10 flex-shrink-0 rounded bg-th-surface-hover overflow-hidden relative">
              {getItemImage(item, 160) ? (
                <img
                  src={getItemImage(item, 160)}
                  alt={getItemTitle(item)}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Music size={16} className="text-th-text-faint" />
                </div>
              )}
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <Play size={14} fill="white" className="text-white ml-0.5" />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[14px] text-th-text-primary truncate font-medium">
                {item.album ? (
                  <span
                    className="hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigateToAlbum(item.album.id, {
                        title: item.album.title,
                        cover: item.album.cover,
                      });
                    }}
                  >
                    {getItemTitle(item)}
                  </span>
                ) : (
                  getItemTitle(item)
                )}
              </p>
              <p className="text-[12px] text-th-text-muted truncate">
                {(item.artist || item.artists?.[0]) && (
                  <TrackArtists
                    artists={item.artists}
                    artist={item.artist}
                    className="hover:underline cursor-pointer"
                    fallback=""
                  />
                )}
                {item.followInfo && (
                  <span className="ml-1 text-th-accent">+</span>
                )}
              </p>
            </div>
            {/* Three-dots on hover */}
            <button
              onClick={(e) => openTrackMenu(e, item, idx)}
              className="w-8 h-8 flex-shrink-0 rounded-full flex items-center justify-center text-th-text-muted hover:text-th-text-primary hover:bg-th-hl-strong opacity-0 group-hover:opacity-100 transition-[opacity,colors]"
            >
              <MoreHorizontal size={16} />
            </button>
          </div>
        ))}
      </div>

      {/* Track context menu */}
      {trackContextMenu && (
        <TrackContextMenu
          track={trackContextMenu.track}
          index={trackContextMenu.index}
          cursorPosition={trackContextMenu.position}
          anchorRef={{ current: null }}
          onClose={() => setTrackContextMenu(null)}
        />
      )}
    </section>
  );
}

// Compact grid section — displayed as a multi-column grid of small cards (like "Continue listening")
function CompactGridSection({
  section,
  items,
  onItemClick,
}: {
  section: HomeSectionType;
  items: any[];
  onItemClick: (item: any) => void;
}) {
  const { navigateToViewAll, navigateToAlbum } = useNavigation();
  const displayItems = items.slice(0, 16);

  // Track context menu (for track items)
  const [trackContextMenu, setTrackContextMenu] = useState<{
    track: any;
    index: number;
    position: { x: number; y: number };
  } | null>(null);

  // Media context menu (for non-track items)
  const [mediaContextMenu, setMediaContextMenu] = useState<{
    item: MediaItemType;
    position: { x: number; y: number };
  } | null>(null);

  const openMenu = useCallback(
    (e: React.MouseEvent, item: any, index: number) => {
      e.preventDefault();
      e.stopPropagation();
      const position = { x: e.clientX, y: e.clientY };

      if (isTrackItem(item, section.sectionType)) {
        setTrackContextMenu({ track: item, index, position });
        return;
      }

      // Build MediaItemType for non-track items
      let mediaItem: MediaItemType | null = null;
      if (isMixItem(item, section.sectionType)) {
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
      } else if (isArtistItem(item, section.sectionType)) {
        if (item.id) {
          mediaItem = {
            type: "artist",
            id: item.id,
            name: item.name || getItemTitle(item),
            picture: item.picture,
          };
        }
      } else if (item.uuid) {
        mediaItem = {
          type: "playlist",
          uuid: item.uuid,
          title: item.title || getItemTitle(item),
          image: item.squareImage || item.image,
          creatorName:
            item.creator?.name ||
            (item.creator?.id === 0 ? "TIDAL" : undefined),
        };
      } else if (item.id) {
        mediaItem = {
          type: "album",
          id: item.id,
          title: item.title || getItemTitle(item),
          cover: item.cover,
          artistName: item.artist?.name || item.artists?.[0]?.name,
        };
      }

      if (mediaItem) {
        setMediaContextMenu({ item: mediaItem, position });
      }
    },
    [section.sectionType],
  );

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[22px] font-bold text-th-text-primary tracking-tight hover:underline cursor-pointer">
          {section.title}
        </h2>
        {section.hasMore && section.apiPath && (
          <button
            onClick={() => navigateToViewAll(section.title, section.apiPath!)}
            className="text-[13px] font-bold text-th-text-muted hover:text-th-text-primary uppercase tracking-wider transition-colors"
          >
            View all
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-x-6 gap-y-1">
        {displayItems.map((item: any, idx: number) => {
          const isTrack = isTrackItem(item, section.sectionType);
          const myTracks = isMyTracksItem(item);
          return (
            <div
              key={getItemId(item)}
              onClick={() => onItemClick(item)}
              onContextMenu={
                myTracks ? undefined : (e) => openMenu(e, item, idx)
              }
              className="flex items-center gap-3 p-2 rounded-md hover:bg-th-inset cursor-pointer group transition-colors"
            >
              <div className="w-10 h-10 flex-shrink-0 rounded bg-th-surface-hover overflow-hidden relative">
                {myTracks ? (
                  <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#450af5] via-[#8e2de2] to-[#00d2ff]">
                    <Heart size={16} className="text-white" fill="white" />
                  </div>
                ) : getItemImage(item, 160) ? (
                  <img
                    src={getItemImage(item, 160)}
                    alt={getItemTitle(item)}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Music size={16} className="text-th-text-faint" />
                  </div>
                )}
                {!myTracks && (
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <Play
                      size={14}
                      fill="white"
                      className="text-white ml-0.5"
                    />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[14px] text-th-text-primary truncate font-medium">
                  {myTracks ? (
                    "Loved Tracks"
                  ) : isTrack && item.album ? (
                    <span
                      className="hover:underline"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigateToAlbum(item.album.id, {
                          title: item.album.title,
                          cover: item.album.cover,
                        });
                      }}
                    >
                      {getItemTitle(item)}
                    </span>
                  ) : (
                    getItemTitle(item)
                  )}
                </p>
                <p className="text-[12px] text-th-text-muted truncate">
                  {myTracks ? (
                    "Collection"
                  ) : isTrack && (item.artist || item.artists?.[0]) ? (
                    <TrackArtists
                      artists={item.artists}
                      artist={item.artist}
                      className="hover:underline cursor-pointer"
                      fallback=""
                    />
                  ) : (
                    getItemSubtitle(item)
                  )}
                </p>
              </div>
              {/* Three-dots on hover */}
              {!myTracks && (
                <button
                  onClick={(e) => openMenu(e, item, idx)}
                  className="w-8 h-8 flex-shrink-0 rounded-full flex items-center justify-center text-th-text-muted hover:text-th-text-primary hover:bg-th-hl-strong opacity-0 group-hover:opacity-100 transition-[opacity,colors]"
                >
                  <MoreHorizontal size={16} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Track context menu */}
      {trackContextMenu && (
        <TrackContextMenu
          track={trackContextMenu.track}
          index={trackContextMenu.index}
          cursorPosition={trackContextMenu.position}
          anchorRef={{ current: null }}
          onClose={() => setTrackContextMenu(null)}
        />
      )}

      {/* Media context menu (albums, playlists, mixes, artists) */}
      {mediaContextMenu && (
        <MediaContextMenu
          item={mediaContextMenu.item}
          cursorPosition={mediaContextMenu.position}
          onClose={() => setMediaContextMenu(null)}
        />
      )}
    </section>
  );
}
