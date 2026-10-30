import { Play, Heart } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigation } from "../hooks/useNavigation";
import { useHomeFeed, slugOf } from "../hooks/useHomeFeed";
import { type MediaItemType } from "../types";
import HomeSection from "./HomeSection";
import MediaContextMenu from "./MediaContextMenu";
import {
  getItemImage,
  getItemTitle,
  getItemId,
  isArtistItem,
  isMixItem,
  isMyTracksItem,
  isDeepLinkItem,
} from "../utils/itemHelpers";
import PageContainer from "./PageContainer";
import AiBadge from "./AiBadge";

export default function Home() {
  const {
    navigateToPlaylist,
    navigateToFavorites,
    navigateToAlbum,
    navigateToArtist,
    navigateToMix,
  } = useNavigation();

  const {
    tabs,
    activeType,
    selectTab: handleTabClick,
    sections,
    loading,
    loadingMore,
    error,
    retry: handleRetry,
    loadMore,
  } = useHomeFeed("desktop");
  const sentinelRef = useRef<HTMLDivElement>(null);

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
      if (isDeepLinkItem(item)) {
        const url = item.data?.url ?? item.data?.id;
        if (url === "tidal://my-collection/tracks") {
          navigateToFavorites();
        }
        // other tidal:// targets have no matching route yet — ignore
        return;
      }
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

  // Infinite scroll: load more sections when sentinel becomes visible
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { rootMargin: "200px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore]);

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

  // marginCls lets callers tune the gap below the tabs: a larger margin when a
  // card grid (quick-access/skeleton) follows, one step smaller when a text
  // heading follows — the heading's line-height adds ~8px of leading, so the
  // smaller margin makes the visible gap match the card case.
  const renderTabBar = (marginCls: string) =>
    tabs.length > 0 ? (
      <div className={`flex gap-2 ${marginCls}`} role="tablist">
        {tabs.map((tab) => {
          const active = slugOf(tab.tabType) === slugOf(activeType);
          return (
            <button
              key={tab.tabType}
              role="tab"
              aria-selected={active}
              onClick={() => handleTabClick(tab.tabType)}
              className={
                active
                  ? "px-4 py-2 rounded-full text-[14px] font-bold bg-th-text-primary text-th-base transition-colors"
                  : "px-4 py-2 rounded-full text-[14px] font-bold bg-th-surface-hover/60 text-th-text-primary hover:bg-th-surface-hover transition-colors"
              }
            >
              {tab.name}
            </button>
          );
        })}
      </div>
    ) : null;

  if (loading) {
    return (
      <div className="flex-1 bg-gradient-to-b from-th-surface to-th-base min-h-full">
        <PageContainer className="px-6 py-8">
          {/* On a cold reload the tab list isn't known yet (it comes from the
              feed response), so fall back to skeleton pills. */}
          {tabs.length > 0 ? (
            renderTabBar("mb-10")
          ) : (
            <div className="flex gap-2 mb-10">
              {[64, 88, 76].map((w, i) => (
                <div
                  key={i}
                  className="h-9 rounded-full bg-th-surface-hover/60 animate-pulse"
                  style={{ width: w }}
                />
              ))}
            </div>
          )}
          {/* Skeleton quick access — only on the static/For-you feed */}
          {slugOf(activeType) === "static" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-10">
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="h-[56px] bg-th-surface-hover/40 rounded-[4px] animate-pulse"
                />
              ))}
            </div>
          )}
          {/* Skeleton sections */}
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="mb-8">
              <div className="h-7 w-48 bg-th-surface-hover rounded animate-pulse mb-4" />
              <div className="card-scroll">
                <div className="card-scroll-track">
                  {Array.from({ length: 10 }).map((_, j) => (
                    <div key={j} className="card-scroll-item">
                      <div className="aspect-square bg-th-surface-hover rounded-md animate-pulse mb-2" />
                      <div className="h-4 w-3/4 bg-th-surface-hover rounded animate-pulse mb-1" />
                      <div className="h-3 w-1/2 bg-th-surface-hover rounded animate-pulse" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </PageContainer>
      </div>
    );
  }

  // A feed that came back with nothing used to render as a bare container —
  // indistinguishable from a broken app. Say which of the two it is, and when
  // it's a failure, offer the retry instead of waiting out the cache TTL.
  if (sections.length === 0) {
    return (
      <div className="flex-1 bg-gradient-to-b from-th-surface to-th-base min-h-full">
        <PageContainer className="px-6 py-8">
          {renderTabBar("mb-8")}
          <div className="text-center py-20">
            {error ? (
              <>
                <p className="text-th-text-primary text-sm font-semibold">
                  Couldn't load Home
                </p>
                <p className="text-th-text-faint text-xs mt-1">{error}</p>
                <button
                  onClick={handleRetry}
                  className="mt-4 px-4 py-2 text-[12px] font-bold border border-th-border-subtle rounded-full text-th-text-secondary hover:text-th-text-primary hover:border-th-accent/50 transition-colors"
                >
                  Retry
                </button>
              </>
            ) : (
              <p className="text-th-text-muted text-sm">
                Nothing to show here yet
              </p>
            )}
          </div>
        </PageContainer>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-gradient-to-b from-th-surface to-th-base min-h-full">
      <PageContainer className="px-6 py-8">
        {renderTabBar(shortcutSection ? "mb-10" : "mb-8")}
        {/* Keyed on the active tab so switching tabs remounts the content and
            replays the fade-in (matches the app's animate-fadeIn convention). */}
        <div key={slugOf(activeType)} className="animate-fadeIn">
          {/* Quick Access Grid (Hero) — SHORTCUT_LIST from v2 feed, For-you only */}
          {shortcutSection && (
            <section className="mb-10">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {/* Loved Tracks - always first */}
                <div
                  onClick={navigateToFavorites}
                  className="flex items-center bg-th-inset/40 hover:bg-th-inset rounded-[4px] overflow-hidden cursor-pointer group transition-[background-color,box-shadow] duration-300 h-[56px] shadow-sm hover:shadow-md"
                >
                  <div className="w-[56px] h-[56px] flex-shrink-0 bg-gradient-to-br from-[#450af5] via-[#8e2de2] to-[#00d2ff] shadow-lg flex items-center justify-center relative">
                    <Heart size={22} className="text-white" fill="white" />
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <Play
                        size={18}
                        fill="white"
                        className="text-white ml-0.5"
                      />
                    </div>
                  </div>
                  <div className="flex-1 flex items-center px-3 min-w-0">
                    <span className="font-bold text-[13px] text-th-text-primary truncate">
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
                    <div className="flex-1 flex items-center gap-1.5 px-3 min-w-0">
                      <span className="font-bold text-[13px] text-th-text-primary truncate">
                        {getItemTitle(item)}
                      </span>
                      {item.ai === true && <AiBadge />}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

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
                  <div className="card-scroll">
                    <div className="card-scroll-track">
                      {Array.from({ length: 10 }).map((_, j) => (
                        <div key={j} className="card-scroll-item">
                          <div className="aspect-square bg-th-surface-hover rounded-md animate-pulse mb-2" />
                          <div className="h-4 w-3/4 bg-th-surface-hover rounded animate-pulse mb-1" />
                          <div className="h-3 w-1/2 bg-th-surface-hover rounded animate-pulse" />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Infinite scroll sentinel */}
          <div ref={sentinelRef} className="h-1" />
        </div>
      </PageContainer>

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
