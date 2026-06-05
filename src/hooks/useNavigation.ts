import { useCallback, startTransition } from "react";
import { useSetAtom } from "jotai";
import { currentViewAtom } from "../atoms/navigation";
import { drawerOpenAtom, maximizedPlayerAtom } from "../atoms/ui";
import type { AppView } from "../types";

export function useNavigation() {
  const setCurrentView = useSetAtom(currentViewAtom);
  const setDrawerOpen = useSetAtom(drawerOpenAtom);
  const setMaximized = useSetAtom(maximizedPlayerAtom);

  // NOTE: Popstate listener lives in AppInitializer (closes overlays there too).

  // Every navigation dismisses the player overlays (Queue View + fullscreen
  // player) so the destination page isn't left hidden behind them.
  const navigate = useCallback(
    (view: AppView) => {
      setDrawerOpen(false);
      setMaximized(false);
      window.history.pushState(view, "");
      // Wrap in startTransition so React can show the new page's skeleton
      // immediately without blocking on unmounting the old page's heavy DOM.
      startTransition(() => {
        setCurrentView(view);
      });
    },
    [setCurrentView, setDrawerOpen, setMaximized],
  );

  const navigateToAlbum = useCallback(
    (
      albumId: number,
      albumInfo?: { title: string; cover?: string; artistName?: string },
    ) => {
      navigate({ type: "album", albumId, albumInfo });
    },
    [navigate],
  );

  const navigateToPlaylist = useCallback(
    (
      playlistId: string,
      playlistInfo?: {
        title: string;
        image?: string;
        description?: string;
        creatorName?: string;
        numberOfTracks?: number;
        isUserPlaylist?: boolean;
      },
    ) => {
      navigate({ type: "playlist", playlistId, playlistInfo });
    },
    [navigate],
  );

  const navigateToFavorites = useCallback(() => {
    navigate({ type: "favorites" });
  }, [navigate]);

  const navigateHome = useCallback(() => {
    navigate({ type: "home" });
  }, [navigate]);

  const navigateToSearch = useCallback(
    (query: string) => {
      navigate({ type: "search", query });
    },
    [navigate],
  );

  const navigateToViewAll = useCallback(
    (title: string, apiPath: string, artistId?: number) => {
      navigate({ type: "viewAll", title, apiPath, artistId });
    },
    [navigate],
  );

  const navigateToArtist = useCallback(
    (artistId: number, artistInfo?: { name: string; picture?: string }) => {
      navigate({ type: "artist", artistId, artistInfo });
    },
    [navigate],
  );

  const navigateToMix = useCallback(
    (
      mixId: string,
      mixInfo?: { title: string; image?: string; subtitle?: string; mixType?: string },
    ) => {
      navigate({ type: "mix", mixId, mixInfo });
    },
    [navigate],
  );

  const navigateToArtistTracks = useCallback(
    (artistId: number, artistName: string) => {
      navigate({ type: "artistTracks", artistId, artistName });
    },
    [navigate],
  );

  const navigateToExplore = useCallback(() => {
    navigate({ type: "explore" });
  }, [navigate]);

  const navigateToExplorePage = useCallback(
    (apiPath: string, title: string) => {
      navigate({ type: "explorePage", apiPath, title });
    },
    [navigate],
  );

  const navigateToLibraryViewAll = useCallback(
    (libraryType: "playlists" | "albums" | "artists" | "mixes") => {
      navigate({ type: "libraryViewAll", libraryType });
    },
    [navigate],
  );

  const navigateToPlaylistFolder = useCallback(
    (folderId: string, folderName: string) => {
      navigate({
        type: "libraryViewAll",
        libraryType: "playlists",
        folderId,
        folderName,
      });
    },
    [navigate],
  );

  return {
    navigateToAlbum,
    navigateToPlaylist,
    navigateToFavorites,
    navigateHome,
    navigateToSearch,
    navigateToViewAll,
    navigateToArtist,
    navigateToArtistTracks,
    navigateToMix,
    navigateToExplore,
    navigateToExplorePage,
    navigateToLibraryViewAll,
    navigateToPlaylistFolder,
  };
}
