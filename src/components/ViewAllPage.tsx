import { useState, useEffect, useRef, useCallback } from "react";
import { usePlayback } from "../hooks/usePlayback";
import { useNavigation } from "../hooks/useNavigation";
import { getPageSection } from "../api/tidal";
import { type MediaItemType } from "../types";
import MediaContextMenu from "./MediaContextMenu";
import MediaCard from "./MediaCard";
import MediaGrid, { MediaGridSkeleton, MediaGridError, MediaGridEmpty } from "./MediaGrid";
import {
  getItemTitle,
  getItemId,
  isArtistItem,
  isTrackItem,
} from "../utils/itemHelpers";

interface ViewAllPageProps {
  title: string;
  apiPath: string;
  onBack: () => void;
}

export default function ViewAllPage({
  title,
  apiPath,
}: ViewAllPageProps) {
  const { playTrack, setQueueTracks } = usePlayback();
  const { navigateToAlbum, navigateToPlaylist } = useNavigation();

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
    let mediaItem: MediaItemType | null = null;

    if (isArtistItem(item)) {
      return; // Artists don't get a context menu
    } else if (item.uuid) {
      mediaItem = {
        type: "playlist",
        uuid: item.uuid,
        title: item.title || getItemTitle(item),
        image: item.squareImage || item.image,
        creatorName:
          item.creator?.name || (item.creator?.id === 0 ? "TIDAL" : undefined),
      };
    } else if (item.id && !isTrackItem(item)) {
      mediaItem = {
        type: "album",
        id: item.id,
        title: item.title || getItemTitle(item),
        cover: item.cover,
        artistName: item.artist?.name || item.artists?.[0]?.name,
      };
    }

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
        const result = await getPageSection(apiPath);
        // Collect all items from all sections
        const allItems = result.sections.flatMap((s) =>
          Array.isArray(s.items) ? s.items : []
        );
        setItems(allItems);
      } catch (err: any) {
        console.error("Failed to load page section:", err);
        setError(err.toString());
      }
      setLoading(false);
    };

    loadData();
  }, [apiPath, getPageSection]);

  const handleItemClick = (item: any) => {
    if (isTrackItem(item)) {
      const idx = items.indexOf(item);
      setQueueTracks(items.slice(idx + 1).filter((t) => isTrackItem(t)));
      playTrack(item);
    } else if (item.uuid) {
      navigateToPlaylist(item.uuid, {
        title: item.title,
        image: item.squareImage || item.image,
        description: item.description,
        creatorName:
          item.creator?.name || (item.creator?.id === 0 ? "TIDAL" : undefined),
        numberOfTracks: item.numberOfTracks,
      });
    } else if (item.id && !isArtistItem(item)) {
      navigateToAlbum(item.id, {
        title: item.title,
        cover: item.cover,
        artistName: item.artist?.name || item.artists?.[0]?.name,
      });
    }
  };

  const hasArtists = items.length > 0 && items.every((item) => isArtistItem(item));

  return (
    <div className="flex-1 bg-gradient-to-b from-th-surface to-th-base min-h-full">
      <div className="px-6 py-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <h1 className="text-[32px] font-bold text-white tracking-tight">
            {title}
          </h1>
        </div>

        {loading && <MediaGridSkeleton />}

        {error && <MediaGridError error={error} />}

        {!loading && !error && items.length === 0 && <MediaGridEmpty />}

        {!loading && !error && items.length > 0 && (
          <MediaGrid>
            {items.map((item: any) => (
              <MediaCard
                key={getItemId(item)}
                item={item}
                onClick={() => handleItemClick(item)}
                onContextMenu={(e) => handleContextMenu(e, item)}
                isArtist={isArtistItem(item) || hasArtists}
                showPlayButton={!hasArtists}
              />
            ))}
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
      </div>
    </div>
  );
}
