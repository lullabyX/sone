import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRef, useState, useCallback } from "react";
import MediaCard from "./MediaCard";
import { getItemId, buildMediaItem } from "../utils/itemHelpers";
import { useMediaPlay } from "../hooks/useMediaPlay";

interface SectionData {
  title: string;
  type?: string;
  sectionType?: string;
  items: any[];
  apiPath?: string;
}

interface CardScrollSectionProps {
  section: SectionData;
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
}

export default function CardScrollSection({
  section,
  onCardClick,
  onContextMenu,
  onViewAll,
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
}: CardScrollSectionProps) {
  const playMedia = useMediaPlay();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 10);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 10);
  }, []);

  const scroll = useCallback((direction: "left" | "right") => {
    const el = scrollRef.current;
    if (!el) return;
    const scrollAmount = el.clientWidth + 16; // one full page + gap for exact card alignment
    el.scrollBy({
      left: direction === "left" ? -scrollAmount : scrollAmount,
      behavior: "smooth",
    });
  }, []);

  const sectionType = section.type || section.sectionType || "";
  const isArtistSection = sectionType === "ARTIST_LIST";

  return (
    <div className="px-8 pb-8">
      <div className="flex items-center justify-between mb-4">
        {section.title && (
          <h2 className="text-[22px] font-bold text-th-text-primary tracking-tight">
            {section.title}
          </h2>
        )}
        <div className="flex items-center gap-2">
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
          {onViewAll && (
            <button
              onClick={onViewAll}
              className="px-3 py-1.5 text-[13px] font-bold text-th-text-muted hover:text-th-text-primary transition-colors"
            >
              View all
            </button>
          )}
        </div>
      </div>

      <div className="card-scroll">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="card-scroll-track pb-2"
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
                else
                  followArtist(item.id, {
                    id: item.id,
                    name: item.name,
                    picture: item.picture,
                  });
              };
            } else if (sectionType === "PLAYLIST_LIST" && item.uuid) {
              isFavorited = favoritePlaylistUuids.has(item.uuid);
              onFavoriteToggle = (e) => {
                e.stopPropagation();
                if (favoritePlaylistUuids.has(item.uuid))
                  removeFavoritePlaylist(item.uuid);
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

            const mediaItem = buildMediaItem(item, sectionType);

            return (
              <MediaCard
                key={getItemId(item)}
                item={item}
                onClick={() => onCardClick(item, sectionType)}
                onContextMenu={(e) => onContextMenu(e, item, sectionType)}
                onPlay={
                  mediaItem
                    ? (e) => {
                        e.stopPropagation();
                        playMedia(mediaItem);
                      }
                    : undefined
                }
                isArtist={isArtistSection}
                showPlayButton
                isFavorited={isFavorited}
                onFavoriteToggle={onFavoriteToggle}
                widthClass="card-scroll-item"
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
