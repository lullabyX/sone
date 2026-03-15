import { useCallback, startTransition } from "react";
import { useAtom } from "jotai";
import { currentViewAtom } from "../atoms/navigation";
import type { AppView } from "../types";

function navigate(setCurrentView: (view: AppView) => void, view: AppView) {
  window.history.pushState(view, "");
  // Wrap in startTransition so React can show the new page's skeleton
  // immediately without blocking on unmounting the old page's heavy DOM.
  startTransition(() => {
    setCurrentView(view);
  });
}

export function useNavigation() {
  const [currentView, setCurrentView] = useAtom(currentViewAtom);

  // NOTE: Popstate listener has been moved to AppInitializer
  // to avoid registering once per component that calls useNavigation().

  const navigateToAlbum = useCallback(
    (
      albumId: number,
      albumInfo?: { title: string; cover?: string; artistName?: string },
    ) => {
      navigate(setCurrentView, { type: "album", albumId, albumInfo });
    },
    [setCurrentView],
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
      navigate(setCurrentView, { type: "playlist", playlistId, playlistInfo });
    },
    [setCurrentView],
  );

  const navigateToFavorites = useCallback(() => {
    navigate(setCurrentView, { type: "favorites" });
  }, [setCurrentView]);

  const navigateHome = useCallback(() => {
    navigate(setCurrentView, { type: "home" });
  }, [setCurrentView]);

  const navigateToSearch = useCallback(
    (query: string) => {
      navigate(setCurrentView, { type: "search", query });
    },
    [setCurrentView],
  );

  const navigateToViewAll = useCallback(
    (title: string, apiPath: string, artistId?: number) => {
      navigate(setCurrentView, { type: "viewAll", title, apiPath, artistId });
    },
    [setCurrentView],
  );

  const navigateToArtist = useCallback(
    (artistId: number, artistInfo?: { name: string; picture?: string }) => {
      navigate(setCurrentView, { type: "artist", artistId, artistInfo });
    },
    [setCurrentView],
  );

  const navigateToMix = useCallback(
    (
      mixId: string,
      mixInfo?: {
        title: string;
        image?: string;
        subtitle?: string;
        mixType?: string;
      },
    ) => {
      navigate(setCurrentView, { type: "mix", mixId, mixInfo });
    },
    [setCurrentView],
  );

  const navigateToArtistTracks = useCallback(
    (artistId: number, artistName: string) => {
      navigate(setCurrentView, { type: "artistTracks", artistId, artistName });
    },
    [setCurrentView],
  );

  const navigateToExplore = useCallback(() => {
    navigate(setCurrentView, { type: "explore" });
  }, [setCurrentView]);

  const navigateToExplorePage = useCallback(
    (apiPath: string, title: string) => {
      navigate(setCurrentView, { type: "explorePage", apiPath, title });
    },
    [setCurrentView],
  );

  const navigateToLibraryViewAll = useCallback(
    (libraryType: "playlists" | "albums" | "artists" | "mixes") => {
      navigate(setCurrentView, { type: "libraryViewAll", libraryType });
    },
    [setCurrentView],
  );

  const navigateToPlaylistFolder = useCallback(
    (folderId: string, folderName: string) => {
      navigate(setCurrentView, {
        type: "libraryViewAll",
        libraryType: "playlists",
        folderId,
        folderName,
      });
    },
    [setCurrentView],
  );

  return {
    currentView,
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
