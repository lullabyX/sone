import { Home, Compass, Library, Heart, Music, User, FolderOpen } from "lucide-react";
import SortDropdown from "./SortDropdown";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import SidebarSkeleton from "./SidebarSkeleton";
import {
  getPlaylistFolders,
  normalizePlaylistFolders,
  getFavoriteAlbums,
  getFavoriteMixes,
  getFavoriteArtists,
} from "../api/tidal";
import { useNavigation } from "../hooks/useNavigation";
import { useAuth } from "../hooks/useAuth";
import {
  getTidalImageUrl,
  type MediaItemType,
  type Playlist,
  type ArtistDetail,
  type PlaylistOrFolder,
  type Folder,
} from "../types";
import TidalImage from "./TidalImage";
import MediaContextMenu from "./MediaContextMenu";
import FolderContextMenu from "./FolderContextMenu";
import { CreatePlaylistModal } from "./AddToPlaylistMenu";
import { getTrackArtistDisplay, folderSubtitle } from "../utils/itemHelpers";
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useAtomValue, useAtom, useSetAtom } from "jotai";
import {
  favoriteAlbumIdsAtom,
  followedArtistIdsAtom,
  optimisticFavoriteAlbumsAtom,
  optimisticFollowedArtistsAtom,
  optimisticFavoriteMixesAtom,
  favoriteMixIdsAtom,
  albumSortAtom,
  artistSortAtom,
  mixSortAtom,
  playlistSortAtom,
} from "../atoms/favorites";
import { deletedFolderIdsAtom, deletedPlaylistIdsAtom, movedPlaylistsAtom, folderCountAdjustmentsAtom, addedToFolderAtom, renamedFoldersAtom } from "../atoms/playlists";
import { sidebarCollapsedAtom } from "../atoms/ui";

export default function Sidebar() {
  const {
    navigateToPlaylist,
    navigateToAlbum,
    navigateToArtist,
    navigateToMix,
    navigateToFavorites,
    navigateHome,
    navigateToExplore,
    navigateToLibraryViewAll,
    navigateToPlaylistFolder,
    currentView,
  } = useNavigation();
  const { authTokens } = useAuth();
  const [isCollapsed, setIsCollapsed] = useAtom(sidebarCollapsedAtom);
  const [activeFilter, setActiveFilter] = useState<
    "playlists" | "albums" | "artists" | "mixes"
  >("playlists");

  // Playlist sort
  const [playlistSort, setPlaylistSort] = useAtom(playlistSortAtom);

  // Playlists + folders: cursor-based pagination from folders endpoint
  const playlistCursorRef = useRef<string | null>(null);

  const playlistFetch = useCallback(
    async (offset: number, limit: number) => {
      const cursor = offset === 0 ? undefined : (playlistCursorRef.current ?? undefined);
      if (offset === 0) playlistCursorRef.current = null;
      const response = await getPlaylistFolders("root", offset, limit, playlistSort.order, playlistSort.direction, undefined, cursor);
      const normalized = normalizePlaylistFolders(response);
      playlistCursorRef.current = normalized.cursor;
      // Derive hasMore from cursor presence — API's totalNumberOfItems is unreliable
      const total = (normalized.cursor && normalized.items.length > 0)
        ? offset + normalized.items.length + 1
        : offset + normalized.items.length;
      return { items: normalized.items, totalNumberOfItems: total };
    },
    [playlistSort.order, playlistSort.direction],
  );

  const {
    items: playlistFolderItems,
    isInitialLoading: playlistsLoading,
    isLoadingMore: playlistsLoadingMore,
    hasMore: playlistsHasMore,
    sentinelRef: playlistsSentinelRef,
  } = useInfiniteScroll<PlaylistOrFolder>({
    fetchPage: playlistFetch,
    pageSize: 50,
    enabled: activeFilter === "playlists" && !!authTokens?.user_id,
    resetKey: `${playlistSort.order}:${playlistSort.direction}`,
  });

  const allPlaylistItems: PlaylistOrFolder[] = playlistFolderItems;

  const setCountAdjustments = useSetAtom(folderCountAdjustmentsAtom);

  useEffect(() => {
    setCountAdjustments(new Map());
  }, [playlistSort.order, playlistSort.direction, setCountAdjustments]);

  const deletedFolderIds = useAtomValue(deletedFolderIdsAtom);
  const deletedPlaylistIds = useAtomValue(deletedPlaylistIdsAtom);
  const movedPlaylists = useAtomValue(movedPlaylistsAtom);
  const countAdjustments = useAtomValue(folderCountAdjustmentsAtom);
  const addedToFolder = useAtomValue(addedToFolderAtom);
  const setAddedToFolder = useSetAtom(addedToFolderAtom);
  const renamedFolders = useAtomValue(renamedFoldersAtom);

  const visiblePlaylistItems = useMemo(() => {
    const filtered = allPlaylistItems.filter((entry) => {
      if (entry.kind === "folder") return !deletedFolderIds.has(entry.data.id);
      if (deletedPlaylistIds.has(entry.data.uuid)) return false;
      if (movedPlaylists.get(entry.data.uuid) === "root") return false;
      return true;
    });
    const added = addedToFolder.get("root") ?? [];
    if (added.length === 0) return filtered;
    // Dedup against existing items
    const existingFolderIds = new Set(filtered.filter((e) => e.kind === "folder").map((e) => e.data.id));
    const existingPlaylistUuids = new Set(filtered.filter((e) => e.kind === "playlist").map((e) => e.data.uuid));
    const newFolders = added.filter((e) => e.kind === "folder" && !existingFolderIds.has(e.data.id));
    const newPlaylists = added.filter((e) =>
      e.kind === "playlist" && !existingPlaylistUuids.has(e.data.uuid) && movedPlaylists.get(e.data.uuid) !== "root"
    );
    if (newFolders.length === 0 && newPlaylists.length === 0) return filtered;
    // Insert new folders with existing folders, new playlists after all folders
    let lastFolderIdx = -1;
    for (let i = filtered.length - 1; i >= 0; i--) {
      if (filtered[i].kind === "folder") { lastFolderIdx = i; break; }
    }
    const insertAt = lastFolderIdx + 1;
    return [
      ...filtered.slice(0, insertAt),
      ...newFolders,
      ...newPlaylists,
      ...filtered.slice(insertAt),
    ];
  }, [allPlaylistItems, deletedFolderIds, deletedPlaylistIds, movedPlaylists, addedToFolder]);

  // Sort atoms
  const [albumSort, setAlbumSort] = useAtom(albumSortAtom);
  const [artistSort, setArtistSort] = useAtom(artistSortAtom);
  const [mixSort, setMixSort] = useAtom(mixSortAtom);

  // Albums
  const optimisticAlbums = useAtomValue(optimisticFavoriteAlbumsAtom);
  const favoriteAlbumIds = useAtomValue(favoriteAlbumIdsAtom);

  const albumFetch = useCallback(
    async (offset: number, limit: number) => {
      if (!authTokens?.user_id) return { items: [], totalNumberOfItems: 0 };
      return getFavoriteAlbums(authTokens.user_id, offset, limit, albumSort.order, albumSort.direction);
    },
    [authTokens?.user_id, albumSort.order, albumSort.direction],
  );

  const {
    items: favoriteAlbumsList,
    isInitialLoading: albumsLoading,
    isLoadingMore: albumsLoadingMore,
    hasMore: albumsHasMore,
    sentinelRef: albumsSentinelRef,
  } = useInfiniteScroll({
    fetchPage: albumFetch,
    pageSize: 50,
    enabled: activeFilter === "albums" && !!authTokens?.user_id,
    resetKey: `${albumSort.order}:${albumSort.direction}`,
  });

  // Merge optimistic albums with paginated list, filter by current favorites
  const allAlbums = useMemo(() => {
    const seen = new Set<number>();
    const merged: typeof favoriteAlbumsList = [];
    for (const a of optimisticAlbums) {
      if (!seen.has(a.id) && favoriteAlbumIds.has(a.id)) {
        seen.add(a.id);
        merged.push(a);
      }
    }
    for (const a of favoriteAlbumsList) {
      if (!seen.has(a.id) && favoriteAlbumIds.has(a.id)) {
        seen.add(a.id);
        merged.push(a);
      }
    }
    return merged;
  }, [optimisticAlbums, favoriteAlbumsList, favoriteAlbumIds]);

  // Mixes
  const optimisticMixes = useAtomValue(optimisticFavoriteMixesAtom);
  const favoriteMixIds = useAtomValue(favoriteMixIdsAtom);

  const mixFetch = useCallback(async (offset: number, limit: number) => {
    return getFavoriteMixes(offset, limit, mixSort.order, mixSort.direction);
  }, [mixSort.order, mixSort.direction]);

  const {
    items: favoriteMixesList,
    isInitialLoading: mixesLoading,
    isLoadingMore: mixesLoadingMore,
    hasMore: mixesHasMore,
    sentinelRef: mixesSentinelRef,
  } = useInfiniteScroll({
    fetchPage: mixFetch,
    pageSize: 50,
    enabled: activeFilter === "mixes" && !!authTokens?.user_id,
    resetKey: `${mixSort.order}:${mixSort.direction}`,
  });

  // Merge optimistic mixes with paginated list, filter by current favorites
  const allMixes = useMemo(() => {
    const seen = new Set<string>();
    const merged: typeof favoriteMixesList = [];
    for (const m of optimisticMixes) {
      if (!seen.has(m.id) && favoriteMixIds.has(m.id)) {
        seen.add(m.id);
        merged.push(m);
      }
    }
    for (const m of favoriteMixesList) {
      if (!seen.has(m.id) && favoriteMixIds.has(m.id)) {
        seen.add(m.id);
        merged.push(m);
      }
    }
    return merged;
  }, [optimisticMixes, favoriteMixesList, favoriteMixIds]);

  // Artists
  const optimisticArtists = useAtomValue(optimisticFollowedArtistsAtom);
  const followedArtistIds = useAtomValue(followedArtistIdsAtom);

  const artistFetch = useCallback(
    async (offset: number, limit: number) => {
      if (!authTokens?.user_id)
        return { items: [] as ArtistDetail[], totalNumberOfItems: 0 };
      return getFavoriteArtists(authTokens.user_id, offset, limit, artistSort.order, artistSort.direction);
    },
    [authTokens?.user_id, artistSort.order, artistSort.direction],
  );

  const {
    items: favoriteArtistsList,
    isInitialLoading: artistsLoading,
    isLoadingMore: artistsLoadingMore,
    hasMore: artistsHasMore,
    sentinelRef: artistsSentinelRef,
  } = useInfiniteScroll({
    fetchPage: artistFetch,
    pageSize: 50,
    enabled: activeFilter === "artists" && !!authTokens?.user_id,
    resetKey: `${artistSort.order}:${artistSort.direction}`,
  });

  // Merge optimistic artists with paginated list, filter by current follows
  const allArtists = useMemo(() => {
    const seen = new Set<number>();
    const merged: typeof favoriteArtistsList = [];
    for (const a of optimisticArtists) {
      if (!seen.has(a.id) && followedArtistIds.has(a.id)) {
        seen.add(a.id);
        merged.push(a);
      }
    }
    for (const a of favoriteArtistsList) {
      if (!seen.has(a.id) && followedArtistIds.has(a.id)) {
        seen.add(a.id);
        merged.push(a);
      }
    }
    return merged;
  }, [optimisticArtists, favoriteArtistsList, followedArtistIds]);

  // Create playlist modal state
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    item: MediaItemType;
    position: { x: number; y: number };
  } | null>(null);

  const [folderContextMenu, setFolderContextMenu] = useState<{
    folderId: string;
    folderName: string;
    position: { x: number; y: number };
  } | null>(null);

  const handlePlaylistContextMenu = useCallback(
    (e: React.MouseEvent, playlist: Playlist) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        item: {
          type: "playlist",
          uuid: playlist.uuid,
          title: playlist.title,
          image: playlist.image,
          creatorName:
            playlist.creator?.name ||
            (playlist.creator?.id === 0 ? "TIDAL" : undefined),
        },
        position: { x: e.clientX, y: e.clientY },
      });
    },
    [],
  );

  const handleFolderContextMenu = useCallback(
    (e: React.MouseEvent, folder: Folder) => {
      e.preventDefault();
      e.stopPropagation();
      setFolderContextMenu({
        folderId: folder.id,
        folderName: folder.name,
        position: { x: e.clientX, y: e.clientY },
      });
    },
    [],
  );

  const userId = authTokens?.user_id;

  const isOwnPlaylist = (playlist: Playlist) => {
    if (!userId) return true; // fallback: assume own if we don't know
    return playlist.creator?.id === userId;
  };

  /** Resolve a display name for the playlist creator */
  const getCreatorName = (playlist: Playlist) => {
    if (playlist.creator?.name) return playlist.creator.name;
    // Tidal editorial playlists have creator.id === 0 but no name
    if (playlist.creator?.id === 0) return "TIDAL";
    return undefined;
  };

  const handlePlaylistClick = (playlist: Playlist) => {
    const own = isOwnPlaylist(playlist);
    navigateToPlaylist(playlist.uuid, {
      title: playlist.title,
      image: playlist.image,
      description: playlist.description,
      creatorName: own ? undefined : getCreatorName(playlist),
      numberOfTracks: playlist.numberOfTracks,
      isUserPlaylist: own,
    });
  };

  return (
    <div
      className={`sidebar h-full bg-th-sidebar flex flex-col border-r border-th-border-subtle transition-[width,min-width,max-width] duration-300 ease-in-out flex-shrink-0 ${
        isCollapsed ? "w-[60px]" : "w-[280px] min-w-[240px] max-w-[340px]"
      }`}
    >
      {/* Navigation */}
      <nav className="px-2 pt-3 space-y-0.5">
        <button
          onClick={navigateHome}
          className={`w-full flex items-center gap-3 px-2.5 py-2.5 rounded-md transition-colors duration-150 group ${
            currentView.type === "home"
              ? "text-th-text-primary bg-th-hl-med"
              : "text-th-text-secondary hover:text-th-text-primary hover:bg-th-border-subtle"
          } ${isCollapsed ? "justify-center px-0" : ""}`}
          title="Home"
        >
          <Home size={20} strokeWidth={2} />
          {!isCollapsed && <span className="font-semibold text-sm">Home</span>}
        </button>
        <button
          onClick={navigateToExplore}
          className={`w-full flex items-center gap-3 px-2.5 py-2.5 rounded-md transition-colors duration-150 group ${
            currentView.type === "explore" || currentView.type === "explorePage"
              ? "text-th-text-primary bg-th-hl-med"
              : "text-th-text-secondary hover:text-th-text-primary hover:bg-th-border-subtle"
          } ${isCollapsed ? "justify-center px-0" : ""}`}
          title="Explore"
        >
          <Compass size={20} strokeWidth={2} />
          {!isCollapsed && (
            <span className="font-semibold text-sm">Explore</span>
          )}
        </button>
      </nav>

      {/* Library Header */}
      <div className="flex-1 flex flex-col min-h-0">
        <div
          className={`px-2 py-1.5 flex items-center ${
            isCollapsed ? "justify-center" : "justify-between"
          }`}
        >
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className={`flex items-center gap-3 px-2.5 py-2 text-th-text-secondary hover:text-th-text-primary transition-colors duration-150 group ${
              isCollapsed ? "justify-center w-full px-0" : ""
            }`}
          >
            <Library size={20} />
            {!isCollapsed && (
              <span className="font-semibold text-sm">Your Library</span>
            )}
          </button>
          {!isCollapsed && (
            <div className="flex items-center gap-1">
              <SortDropdown
                libraryType={activeFilter}
                currentSort={
                  activeFilter === "playlists" ? playlistSort
                  : activeFilter === "albums" ? albumSort
                  : activeFilter === "artists" ? artistSort
                  : mixSort
                }
                onSortChange={
                  activeFilter === "playlists" ? setPlaylistSort
                  : activeFilter === "albums" ? setAlbumSort
                  : activeFilter === "artists" ? setArtistSort
                  : setMixSort
                }
                compact
              />
              <button
                onClick={() => navigateToLibraryViewAll(activeFilter)}
                className="text-xs text-th-text-muted hover:text-th-text-primary transition-colors px-2.5"
              >
                Show all
              </button>
            </div>
          )}
        </div>

        {/* Filter Pills */}
        {!isCollapsed && (
          <div className="px-2 pb-2 flex gap-1.5 overflow-x-auto no-scrollbar">
            {(["playlists", "albums", "artists", "mixes"] as const).map(
              (tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveFilter(tab)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors duration-150 ${
                    activeFilter === tab
                      ? "bg-th-accent/15 text-th-accent"
                      : "bg-th-hl-med hover:bg-th-inset text-th-text-secondary"
                  }`}
                >
                  {tab === "playlists"
                    ? "Playlists"
                    : tab === "albums"
                      ? "Albums"
                      : tab === "artists"
                        ? "Artists"
                        : "Mixes"}
                </button>
              ),
            )}
          </div>
        )}

        {/* Library List */}
        <div className="flex-1 overflow-y-auto px-1.5 pb-2 custom-scrollbar">
          {activeFilter === "playlists" ? (
            /* Playlists view */
            playlistsLoading ? (
              <SidebarSkeleton count={5} />
            ) : visiblePlaylistItems.length === 0 ? (
              <div
                className={`px-3 py-8 text-center ${isCollapsed ? "hidden" : ""}`}
              >
                <p className="text-th-text-muted text-sm">
                  Create your first playlist
                </p>
                <button
                  onClick={() => setShowCreateModal(true)}
                  className="mt-4 px-4 py-2 bg-th-text-primary text-th-base rounded-full text-sm font-bold hover:scale-105 transition-transform"
                >
                  Create playlist
                </button>
              </div>
            ) : (
              <div className="space-y-px">
                {/* Loved Tracks - pinned at top */}
                <button
                  onClick={navigateToFavorites}
                  className={`w-full flex items-center gap-2.5 px-1.5 py-2 rounded-md transition-colors duration-150 group ${
                    currentView.type === "favorites"
                      ? "bg-th-hl-med"
                      : "hover:bg-th-border-subtle"
                  } ${isCollapsed ? "justify-center" : ""}`}
                  title="Loved Tracks"
                >
                  <div
                    className={`shrink-0 overflow-hidden flex items-center justify-center bg-gradient-to-br from-[#450af5] via-[#8e2de2] to-[#00d2ff] ${
                      isCollapsed ? "w-10 h-10 rounded" : "w-10 h-10 rounded"
                    }`}
                  >
                    <Heart size={15} className="text-white" fill="white" />
                  </div>

                  {!isCollapsed && (
                    <div className="flex-1 min-w-0 text-left">
                      <div className="text-[13px] font-medium text-th-text-primary truncate leading-tight">
                        Loved Tracks
                      </div>
                      <div className="text-[11px] text-th-text-faint truncate leading-tight mt-0.5">
                        Collection
                      </div>
                    </div>
                  )}
                </button>

                {visiblePlaylistItems.map((entry) => {
                  if (entry.kind === "folder") {
                    const folderName = renamedFolders.get(entry.data.id) ?? entry.data.name;
                    return (
                      <button
                        key={entry.data.id}
                        onClick={() => navigateToPlaylistFolder(entry.data.id, folderName)}
                        onContextMenu={(e) => handleFolderContextMenu(e, { ...entry.data, name: folderName })}
                        className={`w-full flex items-center gap-2.5 px-1.5 py-2 rounded-md transition-colors duration-150 group hover:bg-th-border-subtle ${isCollapsed ? "justify-center" : ""}`}
                        title={folderName}
                      >
                        <div className={`bg-th-surface-hover shrink-0 overflow-hidden rounded flex items-center justify-center ${isCollapsed ? "w-10 h-10" : "w-10 h-10"}`}>
                          <FolderOpen size={18} className="text-th-text-faint" />
                        </div>
                        {!isCollapsed && (
                          <div className="flex-1 min-w-0 text-left">
                            <div className="text-[14px] font-medium text-th-text-primary truncate leading-snug">
                              {folderName}
                            </div>
                            <div className="text-[12px] text-th-text-faint truncate leading-snug mt-0.5">
                              {folderSubtitle((entry.data.totalNumberOfItems ?? 0) + (countAdjustments.get(entry.data.id) ?? 0))}
                            </div>
                          </div>
                        )}
                      </button>
                    );
                  }

                  const playlist = entry.data;
                  const own = isOwnPlaylist(playlist);
                  const trackCount = playlist.numberOfTracks;
                  const creatorLabel = own ? "You" : getCreatorName(playlist);
                  let subtitle = "";
                  if (creatorLabel) {
                    subtitle = creatorLabel;
                    if (trackCount != null) {
                      subtitle += ` \u00B7 ${trackCount} track${trackCount !== 1 ? "s" : ""}`;
                    }
                  } else if (trackCount != null) {
                    subtitle = `${trackCount} track${trackCount !== 1 ? "s" : ""}`;
                  } else {
                    subtitle = "Playlist";
                  }

                  return (
                    <button
                      key={playlist.uuid}
                      onClick={() => handlePlaylistClick(playlist)}
                      onContextMenu={(e) => handlePlaylistContextMenu(e, playlist)}
                      className={`w-full flex items-center gap-2.5 px-1.5 py-2 rounded-md transition-colors duration-150 group ${
                        currentView.type === "playlist" && currentView.playlistId === playlist.uuid
                          ? "bg-th-hl-med"
                          : "hover:bg-th-border-subtle"
                      } ${isCollapsed ? "justify-center" : ""}`}
                      title={playlist.title}
                    >
                      <div className={`bg-th-surface-hover shrink-0 overflow-hidden rounded ${isCollapsed ? "w-10 h-10" : "w-10 h-10"}`}>
                        <TidalImage src={getTidalImageUrl(playlist.image, 80)} alt={playlist.title} type="playlist" />
                      </div>
                      {!isCollapsed && (
                        <div className="flex-1 min-w-0 text-left">
                          <div className="text-[14px] font-medium text-th-text-primary truncate leading-snug">
                            {playlist.title}
                          </div>
                          <div className="text-[12px] text-th-text-faint truncate leading-snug mt-0.5">
                            {subtitle}
                          </div>
                        </div>
                      )}
                    </button>
                  );
                })}
                {playlistsHasMore && <div ref={playlistsSentinelRef} />}
                {playlistsLoadingMore && <SidebarSkeleton count={2} />}
              </div>
            )
          ) : activeFilter === "albums" ? (
            /* Albums view */
            albumsLoading ? (
              <SidebarSkeleton count={5} />
            ) : allAlbums.length === 0 ? (
              <div
                className={`px-3 py-8 text-center ${isCollapsed ? "hidden" : ""}`}
              >
                <p className="text-th-text-muted text-sm">
                  No favorite albums yet
                </p>
              </div>
            ) : (
              <div className="space-y-px">
                {allAlbums.map((album) => (
                  <button
                    key={album.id}
                    onClick={() =>
                      navigateToAlbum(album.id, {
                        title: album.title,
                        cover: album.cover,
                        artistName: album.artist?.name,
                      })
                    }
                    className={`w-full flex items-center gap-2.5 px-1.5 py-2 rounded-md transition-colors duration-150 group ${
                      currentView.type === "album" &&
                      currentView.albumId === album.id
                        ? "bg-th-hl-med"
                        : "hover:bg-th-border-subtle"
                    } ${isCollapsed ? "justify-center" : ""}`}
                    title={album.title}
                  >
                    <div
                      className={`bg-th-surface-hover shrink-0 overflow-hidden rounded ${
                        isCollapsed ? "w-10 h-10" : "w-10 h-10"
                      }`}
                    >
                      {album.cover ? (
                        <TidalImage
                          src={getTidalImageUrl(album.cover, 80)}
                          alt={album.title}
                          type="album"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Music size={16} className="text-th-text-faint" />
                        </div>
                      )}
                    </div>

                    {!isCollapsed && (
                      <div className="flex-1 min-w-0 text-left">
                        <div className="text-[14px] font-medium text-th-text-primary truncate leading-snug">
                          {album.title}
                        </div>
                        <div className="text-[12px] text-th-text-faint truncate leading-snug mt-0.5">
                          {getTrackArtistDisplay(album)}
                        </div>
                      </div>
                    )}
                  </button>
                ))}
                {albumsHasMore && <div ref={albumsSentinelRef} />}
                {albumsLoadingMore && <SidebarSkeleton count={2} />}
              </div>
            )
          ) : activeFilter === "artists" ? (
            /* Artists view */
            artistsLoading ? (
              <SidebarSkeleton count={5} />
            ) : allArtists.length === 0 ? (
              <div
                className={`px-3 py-8 text-center ${isCollapsed ? "hidden" : ""}`}
              >
                <p className="text-th-text-muted text-sm">
                  No followed artists yet
                </p>
              </div>
            ) : (
              <div className="space-y-px">
                {allArtists.map((artist) => (
                  <button
                    key={artist.id}
                    onClick={() =>
                      navigateToArtist(artist.id, {
                        name: artist.name,
                        picture: artist.picture,
                      })
                    }
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setContextMenu({
                        item: {
                          type: "artist",
                          id: artist.id,
                          name: artist.name,
                          picture: artist.picture,
                        },
                        position: { x: e.clientX, y: e.clientY },
                      });
                    }}
                    className={`w-full flex items-center gap-2.5 px-1.5 py-2 rounded-md transition-colors duration-150 group ${
                      currentView.type === "artist" &&
                      currentView.artistId === artist.id
                        ? "bg-th-hl-med"
                        : "hover:bg-th-border-subtle"
                    } ${isCollapsed ? "justify-center" : ""}`}
                    title={artist.name}
                  >
                    <div
                      className={`bg-th-surface-hover shrink-0 overflow-hidden rounded-full ${
                        isCollapsed ? "w-10 h-10" : "w-10 h-10"
                      }`}
                    >
                      {artist.picture ? (
                        <TidalImage
                          src={getTidalImageUrl(artist.picture, 80)}
                          alt={artist.name}
                          type="artist"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <User size={16} className="text-th-text-faint" />
                        </div>
                      )}
                    </div>

                    {!isCollapsed && (
                      <div className="flex-1 min-w-0 text-left">
                        <div className="text-[14px] font-medium text-th-text-primary truncate leading-snug">
                          {artist.name}
                        </div>
                        <div className="text-[12px] text-th-text-faint truncate leading-snug mt-0.5">
                          Artist
                        </div>
                      </div>
                    )}
                  </button>
                ))}
                {artistsHasMore && <div ref={artistsSentinelRef} />}
                {artistsLoadingMore && <SidebarSkeleton count={2} />}
              </div>
            )
          ) : /* Mixes view */
          mixesLoading ? (
            <SidebarSkeleton count={5} />
          ) : allMixes.length === 0 ? (
            <div
              className={`px-3 py-8 text-center ${isCollapsed ? "hidden" : ""}`}
            >
              <p className="text-th-text-muted text-sm">
                No favorite mixes yet
              </p>
            </div>
          ) : (
            <div className="space-y-px">
              {allMixes.map((mix) => (
                <button
                  key={mix.id}
                  onClick={() =>
                    navigateToMix(mix.id, {
                      title: mix.title,
                      image: mix.images?.MEDIUM?.url,
                      subtitle: mix.subTitle,
                      mixType: mix.mixType,
                    })
                  }
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setContextMenu({
                      item: {
                        type: "mix",
                        mixId: mix.id,
                        title: mix.title,
                        image: mix.images?.MEDIUM?.url,
                        subtitle: mix.subTitle,
                      },
                      position: { x: e.clientX, y: e.clientY },
                    });
                  }}
                  className={`w-full flex items-center gap-2.5 px-1.5 py-2 rounded-md transition-colors duration-150 group ${
                    currentView.type === "mix" && currentView.mixId === mix.id
                      ? "bg-th-hl-med"
                      : "hover:bg-th-border-subtle"
                  } ${isCollapsed ? "justify-center" : ""}`}
                  title={mix.title}
                >
                  <div
                    className={`bg-th-surface-hover shrink-0 overflow-hidden rounded ${
                      isCollapsed ? "w-10 h-10" : "w-10 h-10"
                    }`}
                  >
                    {mix.images?.SMALL?.url ? (
                      <img
                        src={mix.images.SMALL.url}
                        alt={mix.title}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Music size={16} className="text-th-text-faint" />
                      </div>
                    )}
                  </div>

                  {!isCollapsed && (
                    <div className="flex-1 min-w-0 text-left">
                      <div className="text-[14px] font-medium text-th-text-primary truncate leading-snug">
                        {mix.title}
                      </div>
                      <div className="text-[12px] text-th-text-faint truncate leading-snug mt-0.5">
                        {mix.subTitle || "Mix"}
                      </div>
                    </div>
                  )}
                </button>
              ))}
              {mixesHasMore && <div ref={mixesSentinelRef} />}
              {mixesLoadingMore && <SidebarSkeleton count={2} />}
            </div>
          )}
        </div>
      </div>

      {/* Media context menu */}
      {contextMenu && (
        <MediaContextMenu
          item={contextMenu.item}
          cursorPosition={contextMenu.position}
          sourceFolderId="root"
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Folder context menu */}
      {folderContextMenu && (
        <FolderContextMenu
          folderId={folderContextMenu.folderId}
          folderName={folderContextMenu.folderName}
          cursorPosition={folderContextMenu.position}
          onClose={() => setFolderContextMenu(null)}
        />
      )}

      {/* Create playlist modal */}
      {showCreateModal && (
        <CreatePlaylistModal
          trackIds={[]}
          onClose={() => setShowCreateModal(false)}
          onCreated={(playlist) => {
            setAddedToFolder((prev) => {
              const next = new Map(prev);
              const list = next.get("root") ?? [];
              next.set("root", [...list, { kind: "playlist" as const, data: playlist }]);
              return next;
            });
            setShowCreateModal(false);
          }}
        />
      )}
    </div>
  );
}
