import { Play, Heart } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigation } from "../hooks/useNavigation";
import { getHomePage, refreshHomePage, getHomePageMore } from "../api/tidal";
import {
  type HomeSection as HomeSectionType,
  type MediaItemType,
} from "../types";
import HomeSection from "./HomeSection";
import MediaContextMenu from "./MediaContextMenu";
import {
  getItemImage,
  getItemTitle,
  getItemId,
  isArtistItem,
  isMixItem,
  isMyTracksItem,
} from "../utils/itemHelpers";

// Simple in-memory cache to prevent skeleton flash on navigation
let cachedHomeData: {
  sections: HomeSectionType[];
  cursor?: string | null;
} | null = null;

export default function Home() {
  const {
    navigateToPlaylist,
    navigateToFavorites,
    navigateToAlbum,
    navigateToArtist,
    navigateToMix,
  } = useNavigation();

  const [sections, setSections] = useState<HomeSectionType[]>(
    cachedHomeData?.sections || [],
  );
  // If we have cached data, don't show loading skeleton
  const [loading, setLoading] = useState(!cachedHomeData);
  const [greeting] = useState(() => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  });
  const hasLoadedRef = useRef(false);
  const [cursor, setCursor] = useState<string | null>(
    cachedHomeData?.cursor ?? null,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const hasPaginatedRef = useRef(false);

  // Context menu state for quick-access shortcut cards
  const [contextMenu, setContextMenu] = useState<{
    item: MediaItemType;
    position: { x: number; y: number };
  } | null>(null);

  const handleShortcutContextMenu = useCallback(
    (e: React.MouseEvent, item: any) => {
      e.preventDefault();
      e.stopPropagation();
      if (isMyTracksItem(item)) return;
      let mediaItem: MediaItemType | null = null;

      if (isMixItem(item, "SHORTCUT_LIST")) {
        const mixId = item.mixId || item.id?.toString();
        if (mixId) {
          mediaItem = {
            type: "mix",
            mixId,
            title: getItemTitle(item),
            image: getItemImage(item),
          };
        }
      } else if (isArtistItem(item, "SHORTCUT_LIST")) {
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
        setContextMenu({
          item: mediaItem,
          position: { x: e.clientX, y: e.clientY },
        });
      }
    },
    [],
  );

  const handleShortcutClick = useCallback(
    (item: any) => {
      if (isMyTracksItem(item)) {
        navigateToFavorites();
        return;
      }
      if (isMixItem(item, "SHORTCUT_LIST")) {
        const mixId = item.mixId || item.id?.toString();
        if (mixId) {
          navigateToMix(mixId, {
            title: getItemTitle(item),
            image: getItemImage(item),
          });
        }
      } else if (isArtistItem(item, "SHORTCUT_LIST")) {
        if (item.id) {
          navigateToArtist(item.id, {
            name: item.name || getItemTitle(item),
            picture: item.picture,
          });
        }
      } else if (item.uuid) {
        navigateToPlaylist(item.uuid, {
          title: item.title,
          image: item.squareImage || item.image,
          description: item.description,
          creatorName:
            item.creator?.name ||
            (item.creator?.id === 0 ? "TIDAL" : undefined),
          numberOfTracks: item.numberOfTracks,
        });
      } else if (item.id) {
        navigateToAlbum(item.id, {
          title: item.title,
          cover: item.cover,
          artistName: item.artist?.name || item.artists?.[0]?.name,
        });
      }
    },
    [
      navigateToFavorites,
      navigateToPlaylist,
      navigateToAlbum,
      navigateToArtist,
      navigateToMix,
    ],
  );

  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    const loadHomeData = async () => {
      try {
        // Load home page (cached or fresh)
        const result = await getHomePage();
        console.log(
          "[Home] Loaded sections:",
          result.home.sections.map(
            (s) =>
              `${s.sectionType}: "${s.title}" (${Array.isArray(s.items) ? s.items.length : 0} items)`,
          ),
          "isStale:",
          result.isStale,
        );
        setSections(result.home.sections);
        setCursor(result.home.cursor ?? null);

        // Update in-memory cache
        if (!cachedHomeData) cachedHomeData = { sections: [] };
        cachedHomeData.sections = result.home.sections;
        cachedHomeData.cursor = result.home.cursor ?? null;

        // If cache is stale, refresh in background
        if (result.isStale) {
          refreshHomePage()
            .then((fresh) => {
              // Don't replace sections if user has already paginated —
              // that would wipe out cursor-loaded sections
              if (!hasPaginatedRef.current) {
                setSections(fresh.sections);
                setCursor(fresh.cursor ?? null);
              }
              // Always update the in-memory cache for next visit
              if (cachedHomeData) {
                cachedHomeData.sections = hasPaginatedRef.current
                  ? cachedHomeData.sections
                  : fresh.sections;
                cachedHomeData.cursor = hasPaginatedRef.current
                  ? cachedHomeData.cursor
                  : (fresh.cursor ?? null);
              }
            })
            .catch((err) => {
              console.error("Background refresh failed:", err);
            });
        }
      } catch (err) {
        console.error("Failed to load home page:", err);
      }

      setLoading(false);
    };

    loadHomeData();
  }, []);

  // Infinite scroll: load more sections when sentinel becomes visible
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && cursor && !loadingMore) {
          setLoadingMore(true);
          hasPaginatedRef.current = true;
          getHomePageMore(cursor)
            .then((result) => {
              setSections((prev) => {
                const merged = [...prev, ...result.sections];
                if (cachedHomeData) cachedHomeData.sections = merged;
                return merged;
              });
              const nextCursor = result.cursor ?? null;
              setCursor(nextCursor);
              if (cachedHomeData) cachedHomeData.cursor = nextCursor;
            })
            .catch((err) => {
              console.error("Failed to load more home sections:", err);
            })
            .finally(() => {
              setLoadingMore(false);
            });
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [cursor, loadingMore]);

  // Extract SHORTCUT_LIST section for the quick-access grid, pass the rest to HomeSection
  const shortcutSection = sections.find(
    (s) => s.sectionType === "SHORTCUT_LIST",
  );
  const shortcutItems = shortcutSection
    ? (Array.isArray(shortcutSection.items)
        ? shortcutSection.items
        : []
      ).filter((item: any) => !isMyTracksItem(item))
    : [];
  const contentSections = sections.filter(
    (s) => s.sectionType !== "SHORTCUT_LIST",
  );

  if (shortcutSection) {
    console.log(
      "[Home] SHORTCUT_LIST:",
      shortcutItems.length,
      "items",
      shortcutItems.slice(0, 2),
    );
  } else {
    console.log(
      "[Home] No SHORTCUT_LIST section found. Types:",
      sections.map((s) => s.sectionType),
    );
  }

  if (loading) {
    return (
      <div className="flex-1 bg-gradient-to-b from-th-surface to-th-base min-h-full">
        <div className="px-6 py-8">
          {/* Skeleton greeting */}
          <div className="h-10 w-64 bg-th-surface-hover rounded-lg animate-pulse mb-6" />
          {/* Skeleton quick access */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 mb-10">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="h-[56px] bg-th-surface-hover/40 rounded-[4px] animate-pulse"
              />
            ))}
          </div>
          {/* Skeleton sections */}
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="mb-8">
              <div className="h-7 w-48 bg-th-surface-hover rounded animate-pulse mb-4" />
              <div className="flex gap-4">
                {Array.from({ length: 6 }).map((_, j) => (
                  <div key={j} className="flex-shrink-0 w-[180px]">
                    <div className="aspect-square bg-th-surface-hover rounded-md animate-pulse mb-2" />
                    <div className="h-4 w-32 bg-th-surface-hover rounded animate-pulse mb-1" />
                    <div className="h-3 w-24 bg-th-surface-hover rounded animate-pulse" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-gradient-to-b from-th-surface to-th-base min-h-full">
      <div className="px-6 py-8">
        {/* Quick Access Grid (Hero) — SHORTCUT_LIST from v2 feed */}
        <section className="mb-10">
          <h1 className="text-[32px] font-bold text-white mb-6 tracking-tight">
            {greeting}
          </h1>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {/* Loved Tracks - always first */}
            <div
              onClick={navigateToFavorites}
              className="flex items-center bg-th-inset/40 hover:bg-th-inset rounded-[4px] overflow-hidden cursor-pointer group transition-[background-color,box-shadow] duration-300 h-[56px] shadow-sm hover:shadow-md"
            >
              <div className="w-[56px] h-[56px] flex-shrink-0 bg-gradient-to-br from-[#450af5] via-[#8e2de2] to-[#00d2ff] shadow-lg flex items-center justify-center relative">
                <Heart size={22} className="text-white" fill="white" />
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <Play size={18} fill="white" className="text-white ml-0.5" />
                </div>
              </div>
              <div className="flex-1 flex items-center px-3 min-w-0">
                <span className="font-bold text-[13px] text-white truncate">
                  Loved Tracks
                </span>
              </div>
            </div>
            {shortcutItems.slice(0, 7).map((item: any) => (
              <div
                key={getItemId(item)}
                onClick={() => handleShortcutClick(item)}
                onContextMenu={(e) => handleShortcutContextMenu(e, item)}
                className="flex items-center bg-th-inset/40 hover:bg-th-inset rounded-[4px] overflow-hidden cursor-pointer group transition-[background-color,box-shadow] duration-300 h-[56px] shadow-sm hover:shadow-md"
              >
                <div className="w-[56px] h-[56px] flex-shrink-0 bg-th-surface-hover shadow-lg relative">
                  {getItemImage(item, 160) ? (
                    <img
                      src={getItemImage(item, 160)}
                      alt={getItemTitle(item)}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full bg-th-surface-hover" />
                  )}
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <Play
                      size={18}
                      fill="white"
                      className="text-white ml-0.5"
                    />
                  </div>
                </div>
                <div className="flex-1 flex items-center px-3 min-w-0">
                  <span className="font-bold text-[13px] text-white truncate">
                    {getItemTitle(item)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Dynamic sections from v2 feed */}
        {contentSections.map((section, idx) => (
          <HomeSection key={`${section.title}-${idx}`} section={section} />
        ))}

        {/* Loading more skeleton */}
        {loadingMore && (
          <div>
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="mb-8">
                <div className="h-7 w-48 bg-th-surface-hover rounded animate-pulse mb-4" />
                <div className="flex gap-4">
                  {Array.from({ length: 6 }).map((_, j) => (
                    <div key={j} className="flex-shrink-0 w-[180px]">
                      <div className="aspect-square bg-th-surface-hover rounded-md animate-pulse mb-2" />
                      <div className="h-4 w-32 bg-th-surface-hover rounded animate-pulse mb-1" />
                      <div className="h-3 w-24 bg-th-surface-hover rounded animate-pulse" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Infinite scroll sentinel */}
        <div ref={sentinelRef} className="h-1" />
      </div>

      {/* Media context menu for quick-access cards */}
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
