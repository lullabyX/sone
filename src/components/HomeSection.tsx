import { useRef, useState, useCallback } from "react";
import { Play, ChevronLeft, ChevronRight, Music } from "lucide-react";
import { usePlayback } from "../hooks/usePlayback";
import { useNavigation } from "../hooks/useNavigation";
import {
  type HomeSection as HomeSectionType,
  type MediaItemType,
} from "../types";
import MediaContextMenu from "./MediaContextMenu";
import MediaCard from "./MediaCard";
import {
  getItemImage,
  getItemTitle,
  getItemSubtitle,
  getItemId,
  isArtistItem,
  isTrackItem,
  isMixItem,
} from "../utils/itemHelpers";

interface HomeSectionProps {
  section: HomeSectionType;
}

export default function HomeSection({ section }: HomeSectionProps) {
  const { playTrack, setQueueTracks } = usePlayback();
  const {
    navigateToAlbum,
    navigateToPlaylist,
    navigateToViewAll,
    navigateToArtist,
    navigateToMix,
  } = useNavigation();
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
      // Build a MediaItemType from the raw item
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
        // Artists don't get a context menu
        return;
      } else if (item.uuid) {
        // Playlist
        mediaItem = {
          type: "playlist",
          uuid: item.uuid,
          title: item.title || getItemTitle(item),
          image: item.squareImage || item.image,
          creatorName:
            item.creator?.name ||
            (item.creator?.id === 0 ? "TIDAL" : undefined),
        };
      } else if (item.id && !isTrackItem(item, section.sectionType)) {
        // Album
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
    },
    [section.sectionType]
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
    const scrollAmount = el.clientWidth * 0.8;
    el.scrollBy({
      left: direction === "left" ? -scrollAmount : scrollAmount,
      behavior: "smooth",
    });
  };

  const handleItemClick = (item: any) => {
    if (isTrackItem(item, section.sectionType)) {
      // Play the track
      const trackIndex = items.indexOf(item);
      const remainingTracks = items
        .slice(trackIndex + 1)
        .filter((t: any) => isTrackItem(t, section.sectionType));
      setQueueTracks(remainingTracks);
      playTrack(item);
    } else if (isMixItem(item, section.sectionType)) {
      // Mix or radio station - navigate to mix page
      const mixId = item.mixId || item.id?.toString();
      if (mixId) {
        navigateToMix(mixId, {
          title: getItemTitle(item),
          image: getItemImage(item),
          subtitle: getItemSubtitle(item),
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

  if (isTrackSection) {
    return <TrackListSection section={section} items={items} />;
  }

  return (
    <section className="mb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[22px] font-bold text-white tracking-tight hover:underline cursor-pointer">
          {section.title}
        </h2>
        <div className="flex items-center gap-2">
          {/* Scroll arrows */}
          <button
            onClick={() => scroll("left")}
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
              canScrollLeft
                ? "bg-[#2a2a2a] hover:bg-[#3a3a3a] text-white"
                : "text-[#4a4a4a] cursor-default"
            }`}
            disabled={!canScrollLeft}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            onClick={() => scroll("right")}
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
              canScrollRight
                ? "bg-[#2a2a2a] hover:bg-[#3a3a3a] text-white"
                : "text-[#4a4a4a] cursor-default"
            }`}
            disabled={!canScrollRight}
          >
            <ChevronRight size={18} />
          </button>
          {section.hasMore && section.apiPath && (
            <button
              onClick={() => navigateToViewAll(section.title, section.apiPath!)}
              className="text-[13px] font-bold text-[#a6a6a6] hover:text-white uppercase tracking-wider transition-colors ml-2"
            >
              View all
            </button>
          )}
        </div>
      </div>

      {/* Horizontal scroll row */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex gap-4 overflow-x-auto no-scrollbar scroll-smooth pb-2"
      >
        {items.map((item: any) => (
          <MediaCard
            key={getItemId(item)}
            item={item}
            onClick={() => handleItemClick(item)}
            onContextMenu={(e) => handleContextMenu(e, item)}
            isArtist={isArtistItem(item, section.sectionType)}
            widthClass="w-[180px] flex-shrink-0"
          />
        ))}
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
  const { playTrack, setQueueTracks } = usePlayback();
  const { navigateToAlbum, navigateToViewAll } = useNavigation();

  const handlePlayTrack = (item: any, index: number) => {
    const remainingTracks = items.slice(index + 1);
    setQueueTracks(remainingTracks);
    playTrack(item);
  };

  // Display as a 2-column grid of track rows
  const displayItems = items.slice(0, 8);
  const midpoint = Math.ceil(displayItems.length / 2);
  const col1 = displayItems.slice(0, midpoint);
  const col2 = displayItems.slice(midpoint);

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[22px] font-bold text-white tracking-tight hover:underline cursor-pointer">
          {section.title}
        </h2>
        {section.hasMore && section.apiPath && (
          <button
            onClick={() => navigateToViewAll(section.title, section.apiPath!)}
            className="text-[13px] font-bold text-[#a6a6a6] hover:text-white uppercase tracking-wider transition-colors"
          >
            View all
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-1">
        {[col1, col2].map((col, colIdx) => (
          <div key={colIdx} className="flex flex-col">
            {col.map((item: any, idx: number) => {
              const globalIdx = colIdx === 0 ? idx : midpoint + idx;
              return (
                <div
                  key={getItemId(item)}
                  onClick={() => handlePlayTrack(item, globalIdx)}
                  className="flex items-center gap-3 p-2 rounded-md hover:bg-[#2a2a2a] cursor-pointer group transition-colors"
                >
                  <div className="w-10 h-10 flex-shrink-0 rounded bg-[#282828] overflow-hidden relative">
                    {getItemImage(item, 160) ? (
                      <img
                        src={getItemImage(item, 160)}
                        alt={getItemTitle(item)}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Music size={16} className="text-gray-600" />
                      </div>
                    )}
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <Play
                        size={14}
                        fill="white"
                        className="text-white ml-0.5"
                      />
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[14px] text-white truncate font-medium">
                      {getItemTitle(item)}
                    </p>
                    <p className="text-[12px] text-[#a6a6a6] truncate">
                      {item.artist?.name || item.artists?.[0]?.name || ""}
                      {item.followInfo && (
                        <span className="ml-1 text-[#00FFFF]">+</span>
                      )}
                    </p>
                  </div>
                  {item.album && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigateToAlbum(item.album.id, {
                          title: item.album.title,
                          cover: item.album.cover,
                        });
                      }}
                      className="text-[12px] text-[#666] hover:text-white truncate max-w-[120px] transition-colors hidden sm:block"
                    >
                      {item.album.title}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
