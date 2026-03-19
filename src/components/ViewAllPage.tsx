import { useState, useEffect, useRef, useCallback } from "react";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useMediaPlay } from "../hooks/useMediaPlay";
import { useNavigation } from "../hooks/useNavigation";
import { useFavorites } from "../hooks/useFavorites";
import { getPageSection, getArtistViewAll } from "../api/tidal";
import { type MediaItemType } from "../types";
import MediaContextMenu from "./MediaContextMenu";
import MediaCard from "./MediaCard";
import MediaGrid, {
  MediaGridSkeleton,
  MediaGridError,
  MediaGridEmpty,
} from "./MediaGrid";
import PageContainer from "./PageContainer";
import {
  getItemTitle,
  getItemSubtitle,
  getItemImage,
  getItemId,
  isArtistItem,
  isTrackItem,
  isMixItem,
  buildMediaItem,
} from "../utils/itemHelpers";

interface ViewAllPageProps {
  title: string;
  apiPath: string;
  artistId?: number;
  onBack: () => void;
}

export default function ViewAllPage({
  title,
  apiPath,
  artistId,
}: ViewAllPageProps) {
  const { playFromSource } = usePlaybackActions();
  const playMedia = useMediaPlay();
  const {
    navigateToAlbum,
    navigateToPlaylist,
    navigateToArtist,
    navigateToMix,
  } = useNavigation();
  const {
    favoriteAlbumIds,
    addFavoriteAlbum,
    removeFavoriteAlbum,
    followedArtistIds,
    followArtist,
    unfollowArtist,
    favoritePlaylistUuids,
    addFavoritePlaylist,
    removeFavoritePlaylist,
    favoriteMixIds,
    addFavoriteMix,
    removeFavoriteMix,
  } = useFavorites();

  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    item: MediaItemType;
    position: { x: number; y: number };
  } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent, item: any) => {
    const mediaItem = buildMediaItem(item);
    if (mediaItem) {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        item: mediaItem,
        position: { x: e.clientX, y: e.clientY },
      });
    }
  }, []);

  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    const loadData = async () => {
      try {
        if (artistId) {
          const allItems = await getArtistViewAll(artistId, apiPath);
          setItems(allItems);
        } else {
          const result = await getPageSection(apiPath);
          const allItems = result.sections.flatMap((s) =>
            Array.isArray(s.items) ? s.items : [],
          );
          setItems(allItems);
        }
      } catch (err: any) {
        console.error("Failed to load page section:", err);
        setError(err.toString());
      }
      setLoading(false);
    };

    loadData();
  }, [apiPath, artistId]);

  const handleItemClick = (item: any) => {
    if (isTrackItem(item)) {
      const allTrackItems = items.filter((t) => isTrackItem(t));
      playFromSource(item, allTrackItems, {
        source: {
          type: "view-all",
          id: title,
          name: title,
          allTracks: allTrackItems,
        },
      });
    } else if (isArtistItem(item)) {
      navigateToArtist(item.id, {
        name: item.name || getItemTitle(item),
        picture: item.picture,
      });
    } else if (isMixItem(item)) {
      const mixId = item.mixId || item.id?.toString();
      if (mixId) {
        navigateToMix(mixId, {
          title: getItemTitle(item),
          image: getItemImage(item),
          subtitle: getItemSubtitle(item),
        });
      }
    } else if (item.uuid) {
      navigateToPlaylist(item.uuid, {
        title: item.title,
        image: item.squareImage || item.image,
        description: item.description,
        creatorName:
          item.creator?.name || (item.creator?.id === 0 ? "TIDAL" : undefined),
        numberOfTracks: item.numberOfTracks,
      });
    } else if (item.id) {
      navigateToAlbum(item.id, {
        title: item.title,
        cover: item.cover,
        artistName: item.artist?.name || item.artists?.[0]?.name,
      });
    }
  };

  const hasArtists =
    items.length > 0 && items.every((item) => isArtistItem(item));
  const hasMixes = items.length > 0 && items.every((item) => isMixItem(item));

  const getFavoriteProps = (item: any) => {
    if (isArtistItem(item) && item.id) {
      return {
        isFavorited: followedArtistIds.has(item.id),
        onFavoriteToggle: (e: React.MouseEvent) => {
          e.stopPropagation();
          if (followedArtistIds.has(item.id)) unfollowArtist(item.id);
          else
            followArtist(item.id, {
              id: item.id,
              name: item.name,
              picture: item.picture,
            });
        },
      };
    }
    if (isMixItem(item)) {
      const mixId = item.mixId || item.id?.toString();
      if (mixId) {
        return {
          isFavorited: favoriteMixIds.has(mixId),
          onFavoriteToggle: (e: React.MouseEvent) => {
            e.stopPropagation();
            if (favoriteMixIds.has(mixId)) removeFavoriteMix(mixId);
            else addFavoriteMix(mixId);
          },
        };
      }
    }
    if (item.uuid) {
      return {
        isFavorited: favoritePlaylistUuids.has(item.uuid),
        onFavoriteToggle: (e: React.MouseEvent) => {
          e.stopPropagation();
          if (favoritePlaylistUuids.has(item.uuid))
            removeFavoritePlaylist(item.uuid);
          else addFavoritePlaylist(item.uuid, item);
        },
      };
    }
    if (!isTrackItem(item) && item.id) {
      return {
        isFavorited: favoriteAlbumIds.has(item.id),
        onFavoriteToggle: (e: React.MouseEvent) => {
          e.stopPropagation();
          if (favoriteAlbumIds.has(item.id)) removeFavoriteAlbum(item.id);
          else addFavoriteAlbum(item.id, item);
        },
      };
    }
    return {};
  };

  return (
    <div className="flex-1 bg-gradient-to-b from-th-surface to-th-base min-h-full">
      <PageContainer className="px-6 py-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <h1 className="text-[32px] font-bold text-th-text-primary tracking-tight">
            {title}
          </h1>
        </div>

        {loading && <MediaGridSkeleton />}

        {error && <MediaGridError error={error} />}

        {!loading && !error && items.length === 0 && <MediaGridEmpty />}

        {!loading && !error && items.length > 0 && (
          <MediaGrid>
            {items.map((item: any) => {
              const favProps = getFavoriteProps(item);
              const mediaItem = buildMediaItem(item);
              return (
                <MediaCard
                  key={getItemId(item)}
                  item={item}
                  onClick={() => handleItemClick(item)}
                  onContextMenu={(e) => handleContextMenu(e, item)}
                  onPlay={
                    !hasArtists && !hasMixes && mediaItem
                      ? (e) => {
                          e.stopPropagation();
                          playMedia(mediaItem);
                        }
                      : undefined
                  }
                  isArtist={isArtistItem(item) || hasArtists}
                  showPlayButton={!hasArtists && !hasMixes}
                  isFavorited={favProps.isFavorited}
                  onFavoriteToggle={favProps.onFavoriteToggle}
                />
              );
            })}
          </MediaGrid>
        )}

        {/* Media context menu */}
        {contextMenu && (
          <MediaContextMenu
            item={contextMenu.item}
            cursorPosition={contextMenu.position}
            onClose={() => setContextMenu(null)}
          />
        )}
      </PageContainer>
    </div>
  );
}
