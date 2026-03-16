import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  startTransition,
} from "react";
import { useAuth } from "../hooks/useAuth";
import { useNavigation } from "../hooks/useNavigation";
import { useMediaPlay } from "../hooks/useMediaPlay";
import { useFavorites } from "../hooks/useFavorites";
import { useAtomValue, useStore } from "jotai";
import {
  deletedPlaylistIdsAtom,
  deletedFolderIdsAtom,
  movedPlaylistsAtom,
  folderCountAdjustmentsAtom,
  addedToFolderAtom,
  renamedFoldersAtom,
} from "../atoms/playlists";
import {
  albumSortAtom,
  artistSortAtom,
  mixSortAtom,
  playlistSortAtom,
  type SortOrder,
} from "../atoms/favorites";
import {
  getPlaylistFolders,
  normalizePlaylistFolders,
  getItemKey,
  getFavoriteAlbums,
  getFavoriteArtists,
  getFavoriteMixes,
} from "../api/tidal";
import MediaGrid, { MediaGridSkeleton, MediaGridEmpty } from "./MediaGrid";
import MediaCard from "./MediaCard";
import MediaContextMenu from "./MediaContextMenu";
import FolderContextMenu from "./FolderContextMenu";
import DebouncedFilterInput from "./DebouncedFilterInput";
import SortDropdown from "./SortDropdown";
import PageContainer from "./PageContainer";
import { buildMediaItem, folderSubtitle } from "../utils/itemHelpers";
import { FolderOpen, MoreHorizontal } from "lucide-react";
import type { MediaItemType, PlaylistOrFolder } from "../types";

type LibraryType = "playlists" | "albums" | "artists" | "mixes";

interface LibraryViewAllProps {
  libraryType: LibraryType;
  folderId?: string;
  folderName?: string;
}

const CONFIG = {
  playlists: {
    title: "Playlists",
    searchPlaceholder: "Filter by title or creator",
  },
  albums: {
    title: "Your favorite albums",
    searchPlaceholder: "Filter by title or artist",
  },
  artists: {
    title: "Artists you follow",
    searchPlaceholder: "Filter by name",
  },
  mixes: {
    title: "Mixes & Radios you liked",
    searchPlaceholder: "Filter by title",
  },
} as const;

const PAGE_SIZE = 50;

export default function LibraryViewAll({
  libraryType,
  folderId,
  folderName,
}: LibraryViewAllProps) {
  const { authTokens } = useAuth();
  const {
    navigateToPlaylist,
    navigateToAlbum,
    navigateToArtist,
    navigateToMix,
    navigateToPlaylistFolder,
  } = useNavigation();
  const playMedia = useMediaPlay();
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

  const deletedPlaylistIds = useAtomValue(deletedPlaylistIdsAtom);
  const deletedFolderIds = useAtomValue(deletedFolderIdsAtom);
  const movedPlaylists = useAtomValue(movedPlaylistsAtom);
  const countAdjustments = useAtomValue(folderCountAdjustmentsAtom);
  const addedToFolder = useAtomValue(addedToFolderAtom);
  const renamedFolders = useAtomValue(renamedFoldersAtom);

  const [folderContextMenu, setFolderContextMenu] = useState<{
    folderId: string;
    folderName: string;
    position: { x: number; y: number };
  } | null>(null);

  const store = useStore();
  const [currentSort, setCurrentSort] = useState<SortOrder>(() => {
    const atom =
      libraryType === "playlists"
        ? playlistSortAtom
        : libraryType === "albums"
          ? albumSortAtom
          : libraryType === "artists"
            ? artistSortAtom
            : mixSortAtom;
    return store.get(atom);
  });

  const [items, setItems] = useState<any[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const offsetRef = useRef(0);
  const hasMoreRef = useRef(true);
  const bgFetchingRef = useRef(false);
  const cancelledRef = useRef(false);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const playlistCursorRef = useRef<string | null>(null);
  const playlistApiTotalRef = useRef(0);

  const config = CONFIG[libraryType];
  const userId = authTokens?.user_id;

  // ==================== Data Fetching ====================

  const fetchPage = useCallback(
    async (
      offset: number,
      limit: number,
    ): Promise<{ items: any[]; totalNumberOfItems: number }> => {
      switch (libraryType) {
        case "playlists": {
          const cursor =
            offset === 0 ? undefined : (playlistCursorRef.current ?? undefined);
          if (offset === 0) playlistCursorRef.current = null;
          const response = await getPlaylistFolders(
            folderId ?? "root",
            offset,
            limit,
            currentSort?.order ?? "DATE_UPDATED",
            currentSort?.direction ?? "DESC",
            undefined,
            cursor,
          );
          const normalized = normalizePlaylistFolders(response);
          playlistCursorRef.current = normalized.cursor;
          playlistApiTotalRef.current = normalized.totalNumberOfItems;
          const total =
            normalized.cursor && normalized.items.length > 0
              ? offset + normalized.items.length + 1
              : offset + normalized.items.length;
          return { items: normalized.items, totalNumberOfItems: total };
        }
        case "albums": {
          if (!userId) return { items: [], totalNumberOfItems: 0 };
          return getFavoriteAlbums(
            userId,
            offset,
            limit,
            currentSort?.order ?? "DATE",
            currentSort?.direction ?? "DESC",
          );
        }
        case "artists": {
          if (!userId) return { items: [], totalNumberOfItems: 0 };
          return getFavoriteArtists(
            userId,
            offset,
            limit,
            currentSort?.order ?? "DATE",
            currentSort?.direction ?? "DESC",
          );
        }
        case "mixes": {
          return getFavoriteMixes(
            offset,
            limit,
            currentSort?.order ?? "DATE",
            currentSort?.direction ?? "DESC",
          );
        }
      }
    },
    [libraryType, userId, currentSort?.order, currentSort?.direction, folderId],
  );

  // Load first page
  useEffect(() => {
    cancelledRef.current = false;
    bgFetchingRef.current = false;
    playlistCursorRef.current = null;
    setItems([]);
    setTotalCount(0);
    setLoading(true);
    offsetRef.current = 0;
    hasMoreRef.current = true;

    (async () => {
      try {
        const page = await fetchPage(0, PAGE_SIZE);
        if (cancelledRef.current) return;
        setItems(page.items);
        setTotalCount(page.totalNumberOfItems);
        offsetRef.current = page.items.length;
        hasMoreRef.current = page.items.length < page.totalNumberOfItems;
      } catch (err) {
        console.error("Failed to load library items:", err);
      } finally {
        if (!cancelledRef.current) setLoading(false);
      }
    })();

    return () => {
      cancelledRef.current = true;
    };
  }, [fetchPage]);

  // Background fetch remaining
  const fetchRemaining = useCallback(async () => {
    if (bgFetchingRef.current || !hasMoreRef.current) return;
    bgFetchingRef.current = true;
    try {
      while (hasMoreRef.current && !cancelledRef.current) {
        const page = await fetchPage(offsetRef.current, PAGE_SIZE);
        if (cancelledRef.current) return;
        startTransition(() => {
          setItems((prev) => {
            if (libraryType === "playlists") {
              const seen = new Set(
                (prev as PlaylistOrFolder[]).map(getItemKey),
              );
              return [
                ...prev,
                ...(page.items as PlaylistOrFolder[]).filter(
                  (item) => !seen.has(getItemKey(item)),
                ),
              ];
            } else {
              const seen = new Set(prev.map((item: any) => item.id));
              return [
                ...prev,
                ...page.items.filter((item: any) => !seen.has(item.id)),
              ];
            }
          });
          setTotalCount(page.totalNumberOfItems);
        });
        offsetRef.current += page.items.length;
        hasMoreRef.current = offsetRef.current < page.totalNumberOfItems;
      }
    } catch (err) {
      console.error("Failed to background-fetch library items:", err);
    } finally {
      bgFetchingRef.current = false;
    }
  }, [fetchPage, libraryType]);

  // Load more (infinite scroll trigger)
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMoreRef.current || bgFetchingRef.current) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(offsetRef.current, PAGE_SIZE);
      if (cancelledRef.current) return;
      setItems((prev) => {
        if (libraryType === "playlists") {
          const seen = new Set((prev as PlaylistOrFolder[]).map(getItemKey));
          return [
            ...prev,
            ...(page.items as PlaylistOrFolder[]).filter(
              (item) => !seen.has(getItemKey(item)),
            ),
          ];
        } else {
          const seen = new Set(prev.map((item: any) => item.id));
          return [
            ...prev,
            ...page.items.filter((item: any) => !seen.has(item.id)),
          ];
        }
      });
      setTotalCount(page.totalNumberOfItems);
      offsetRef.current += page.items.length;
      hasMoreRef.current = offsetRef.current < page.totalNumberOfItems;
    } catch (err) {
      console.error("Failed to load more:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, fetchPage, libraryType]);

  // Infinite scroll observer
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, loading]);

  const displayItems = useMemo(() => {
    if (libraryType !== "playlists") return items;
    const currentFolder = folderId ?? "root";
    const filtered = (items as PlaylistOrFolder[]).filter((entry) => {
      if (entry.kind === "folder") return !deletedFolderIds.has(entry.data.id);
      if (deletedPlaylistIds.has(entry.data.uuid)) return false;
      if (movedPlaylists.get(entry.data.uuid) === currentFolder) return false;
      return true;
    });
    // Prepend optimistically added playlists to this folder
    const added = addedToFolder.get(currentFolder) ?? [];
    if (added.length === 0) return filtered;
    const existingFolderIds = new Set(
      filtered.filter((e) => e.kind === "folder").map((e) => e.data.id),
    );
    const existingPlaylistUuids = new Set(
      filtered.filter((e) => e.kind === "playlist").map((e) => e.data.uuid),
    );
    const newFolders = added.filter(
      (e) => e.kind === "folder" && !existingFolderIds.has(e.data.id),
    );
    const newPlaylists = added.filter(
      (e) =>
        e.kind === "playlist" &&
        !existingPlaylistUuids.has(e.data.uuid) &&
        movedPlaylists.get(e.data.uuid) !== currentFolder,
    );
    if (newFolders.length === 0 && newPlaylists.length === 0) return filtered;
    return [...newFolders, ...newPlaylists, ...filtered];
  }, [
    items,
    deletedPlaylistIds,
    deletedFolderIds,
    movedPlaylists,
    addedToFolder,
    libraryType,
    folderId,
  ]);

  // ==================== Search / Filter ====================

  const [searchQuery, setSearchQuery] = useState("");
  const isFiltering = searchQuery.trim().length > 0;

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return displayItems;
    if (libraryType === "playlists") {
      const entries = displayItems as PlaylistOrFolder[];
      return entries.filter((entry) => {
        if (entry.kind === "folder") {
          const name = renamedFolders.get(entry.data.id) ?? entry.data.name;
          return name.toLowerCase().includes(q);
        }
        return (
          entry.data.title?.toLowerCase().includes(q) ||
          entry.data.description?.toLowerCase().includes(q) ||
          entry.data.creator?.name?.toLowerCase().includes(q)
        );
      }) as any;
    }
    return displayItems.filter((item) => {
      switch (libraryType) {
        case "albums":
          return (
            item.title?.toLowerCase().includes(q) ||
            item.artist?.name?.toLowerCase().includes(q)
          );
        case "artists":
          return item.name?.toLowerCase().includes(q);
        case "mixes":
          return (
            item.title?.toLowerCase().includes(q) ||
            item.subTitle?.toLowerCase().includes(q)
          );
      }
    });
  }, [displayItems, searchQuery, libraryType, renamedFolders]);

  const handleSearchFocus = useCallback(() => {
    if (hasMoreRef.current && !bgFetchingRef.current) {
      setTimeout(() => fetchRemaining(), 0);
    }
  }, [fetchRemaining]);

  // ==================== Context Menu ====================

  const [contextMenu, setContextMenu] = useState<{
    item: MediaItemType;
    position: { x: number; y: number };
  } | null>(null);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, item: any) => {
      const sectionType =
        libraryType === "artists"
          ? "ARTIST_LIST"
          : libraryType === "mixes"
            ? "MIX_LIST"
            : undefined;
      const mediaItem = buildMediaItem(item, sectionType);
      if (mediaItem) {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({
          item: mediaItem,
          position: { x: e.clientX, y: e.clientY },
        });
      }
    },
    [libraryType],
  );

  // ==================== Navigation ====================

  const handleItemClick = useCallback(
    (item: any) => {
      switch (libraryType) {
        case "playlists": {
          const entry = item as PlaylistOrFolder;
          if (entry.kind === "folder") {
            navigateToPlaylistFolder(entry.data.id, entry.data.name);
          } else {
            navigateToPlaylist(entry.data.uuid, {
              title: entry.data.title,
              image: entry.data.image,
              description: entry.data.description,
              creatorName:
                entry.data.creator?.name ||
                (entry.data.creator?.id === 0 ? "TIDAL" : undefined),
              numberOfTracks: entry.data.numberOfTracks,
              isUserPlaylist:
                userId != null && entry.data.creator?.id === userId,
            });
          }
          break;
        }
        case "albums":
          navigateToAlbum(item.id, {
            title: item.title,
            cover: item.cover,
            artistName: item.artist?.name,
          });
          break;
        case "artists":
          navigateToArtist(item.id, { name: item.name, picture: item.picture });
          break;
        case "mixes":
          navigateToMix(item.id, {
            title: item.title,
            image: item.images?.MEDIUM?.url,
            subtitle: item.subTitle,
          });
          break;
      }
    },
    [
      libraryType,
      navigateToPlaylist,
      navigateToPlaylistFolder,
      navigateToAlbum,
      navigateToArtist,
      navigateToMix,
      userId,
    ],
  );

  // ==================== Play ====================

  const handlePlay = useCallback(
    (e: React.MouseEvent, item: any) => {
      e.stopPropagation();
      const sectionType =
        libraryType === "artists"
          ? "ARTIST_LIST"
          : libraryType === "mixes"
            ? "MIX_LIST"
            : undefined;
      const mediaItem = buildMediaItem(item, sectionType);
      if (mediaItem) playMedia(mediaItem);
    },
    [libraryType, playMedia],
  );

  // ==================== Favorites ====================

  const isFavorited = useCallback(
    (item: any): boolean => {
      switch (libraryType) {
        case "playlists": {
          const entry = item as PlaylistOrFolder;
          if (entry.kind === "folder") return false;
          return favoritePlaylistUuids.has(entry.data.uuid);
        }
        case "albums":
          return favoriteAlbumIds.has(item.id);
        case "artists":
          return followedArtistIds.has(item.id);
        case "mixes":
          return favoriteMixIds.has(item.id);
      }
    },
    [
      libraryType,
      favoritePlaylistUuids,
      favoriteAlbumIds,
      followedArtistIds,
      favoriteMixIds,
    ],
  );

  const handleFavoriteToggle = useCallback(
    (e: React.MouseEvent, item: any) => {
      e.stopPropagation();
      switch (libraryType) {
        case "playlists": {
          const entry = item as PlaylistOrFolder;
          if (entry.kind === "folder") return;
          if (favoritePlaylistUuids.has(entry.data.uuid))
            removeFavoritePlaylist(entry.data.uuid);
          else addFavoritePlaylist(entry.data.uuid, entry.data);
          break;
        }
        case "albums":
          if (favoriteAlbumIds.has(item.id)) removeFavoriteAlbum(item.id);
          else addFavoriteAlbum(item.id, item);
          break;
        case "artists":
          if (followedArtistIds.has(item.id)) unfollowArtist(item.id);
          else followArtist(item.id, item);
          break;
        case "mixes":
          if (favoriteMixIds.has(item.id)) removeFavoriteMix(item.id);
          else addFavoriteMix(item.id);
          break;
      }
    },
    [
      libraryType,
      favoritePlaylistUuids,
      favoriteAlbumIds,
      followedArtistIds,
      favoriteMixIds,
      addFavoritePlaylist,
      removeFavoritePlaylist,
      addFavoriteAlbum,
      removeFavoriteAlbum,
      followArtist,
      unfollowArtist,
      addFavoriteMix,
      removeFavoriteMix,
    ],
  );

  // ==================== Render ====================

  const hasMore = !isFiltering && items.length < totalCount;
  const isArtist = libraryType === "artists";
  const itemCount = isFiltering
    ? filteredItems.length
    : libraryType === "playlists"
      ? playlistApiTotalRef.current || displayItems.length
      : totalCount || displayItems.length;

  if (loading) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base overflow-y-auto scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent">
        <PageContainer>
          <div className="px-8 pt-10 pb-6">
            <div className="h-8 w-64 bg-th-surface-hover rounded animate-pulse mb-2" />
            <div className="h-4 w-32 bg-th-surface-hover rounded animate-pulse" />
          </div>
          <div className="px-8 pb-4">
            <div className="h-9 w-full bg-th-surface-hover/60 rounded-md animate-pulse" />
          </div>
          <div className="px-8 pb-8">
            <MediaGridSkeleton count={18} />
          </div>
        </PageContainer>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-linear-to-b from-th-surface to-th-base overflow-y-auto scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent">
      <PageContainer>
        {/* Header */}
        <div className="px-8 pt-10 pb-6">
          <div className="flex items-center gap-3">
            <h1 className="text-[32px] font-extrabold text-th-text-primary leading-tight tracking-tight">
              {(folderId ? renamedFolders.get(folderId) : undefined) ??
                folderName ??
                config.title}
            </h1>
            {folderId && folderId !== "root" && (
              <button
                className="p-1.5 rounded-full hover:bg-th-hl-faint transition-colors text-th-text-muted hover:text-th-text-primary"
                onClick={(e) =>
                  setFolderContextMenu({
                    folderId: folderId ?? "",
                    folderName: folderName ?? "",
                    position: { x: e.clientX, y: e.clientY },
                  })
                }
              >
                <MoreHorizontal size={20} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1">
            <p className="text-[14px] text-th-text-muted">
              {itemCount}{" "}
              {libraryType === "artists"
                ? itemCount === 1
                  ? "artist"
                  : "artists"
                : libraryType === "albums"
                  ? itemCount === 1
                    ? "album"
                    : "albums"
                  : libraryType === "mixes"
                    ? itemCount === 1
                      ? "mix"
                      : "mixes"
                    : itemCount === 1
                      ? "playlist"
                      : "playlists"}
            </p>
            <SortDropdown
              libraryType={libraryType}
              currentSort={currentSort}
              onSortChange={setCurrentSort}
            />
          </div>
        </div>

        {/* Search */}
        <div className="px-8 pb-6">
          <DebouncedFilterInput
            placeholder={config.searchPlaceholder}
            onChange={setSearchQuery}
            onFocus={handleSearchFocus}
          />
        </div>

        {/* Grid */}
        <div className="px-8 pb-8">
          {filteredItems.length === 0 ? (
            <MediaGridEmpty
              message={
                isFiltering
                  ? `No ${libraryType} match your search`
                  : `No ${libraryType} yet`
              }
            />
          ) : (
            <MediaGrid>
              {(filteredItems as any[]).map((item: any) => {
                // Folder rendering
                if (
                  libraryType === "playlists" &&
                  (item as PlaylistOrFolder).kind === "folder"
                ) {
                  const folder = (
                    item as Extract<PlaylistOrFolder, { kind: "folder" }>
                  ).data;
                  const displayName =
                    renamedFolders.get(folder.id) ?? folder.name;
                  return (
                    <MediaCard
                      key={folder.id}
                      item={{
                        title: displayName,
                        subTitle: folderSubtitle(
                          (folder.totalNumberOfItems ?? 0) +
                            (countAdjustments.get(folder.id) ?? 0),
                        ),
                      }}
                      onClick={() =>
                        navigateToPlaylistFolder(folder.id, displayName)
                      }
                      onContextMenu={(e: React.MouseEvent) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setFolderContextMenu({
                          folderId: folder.id,
                          folderName: displayName,
                          position: { x: e.clientX, y: e.clientY },
                        });
                      }}
                      titleOverride={displayName}
                      imageOverride={
                        <div className="w-full h-full flex items-center justify-center bg-th-surface-hover">
                          <FolderOpen
                            size={32}
                            className="text-th-text-faint"
                          />
                        </div>
                      }
                      showPlayButton={false}
                    />
                  );
                }

                const key =
                  libraryType === "playlists"
                    ? (item as Extract<PlaylistOrFolder, { kind: "playlist" }>)
                        .data.uuid
                    : item.uuid || item.id?.toString() || item.mixId;

                const actualItem =
                  libraryType === "playlists"
                    ? (item as Extract<PlaylistOrFolder, { kind: "playlist" }>)
                        .data
                    : item;

                return (
                  <MediaCard
                    key={key}
                    item={actualItem}
                    isArtist={isArtist}
                    userId={libraryType === "playlists" ? userId : undefined}
                    onClick={() => handleItemClick(item)}
                    onContextMenu={(e) => handleContextMenu(e, actualItem)}
                    onPlay={(e) => handlePlay(e, actualItem)}
                    isFavorited={isFavorited(item)}
                    onFavoriteToggle={(e) => handleFavoriteToggle(e, item)}
                    onMoreClick={(e) => handleContextMenu(e, actualItem)}
                  />
                );
              })}
            </MediaGrid>
          )}

          {/* Infinite scroll sentinel */}
          {hasMore && <div ref={sentinelRef} className="h-1" />}
          {loadingMore && (
            <div className="mt-4">
              <MediaGridSkeleton count={6} />
            </div>
          )}
        </div>

        {folderContextMenu && (
          <FolderContextMenu
            folderId={folderContextMenu.folderId}
            folderName={folderContextMenu.folderName}
            cursorPosition={folderContextMenu.position}
            onClose={() => setFolderContextMenu(null)}
          />
        )}
      </PageContainer>

      {/* Context menu */}
      {contextMenu && (
        <MediaContextMenu
          item={contextMenu.item}
          cursorPosition={contextMenu.position}
          sourceFolderId={folderId ?? "root"}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
