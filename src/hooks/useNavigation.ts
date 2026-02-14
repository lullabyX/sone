import { useCallback } from "react";
import { useAtom } from "jotai";
import { currentViewAtom } from "../atoms/navigation";
import type { AppView } from "../types";

export function useNavigation() {
  const [currentView, setCurrentView] = useAtom(currentViewAtom);

  // NOTE: Popstate listener has been moved to AppInitializer
  // to avoid registering once per component that calls useNavigation().

  const navigateToAlbum = useCallback(
    (
      albumId: number,
      albumInfo?: { title: string; cover?: string; artistName?: string }
    ) => {
      const view: AppView = { type: "album", albumId, albumInfo };
      window.history.pushState(view, "");
      setCurrentView(view);
    },
    [setCurrentView]
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
      }
    ) => {
      const view: AppView = { type: "playlist", playlistId, playlistInfo };
      window.history.pushState(view, "");
      setCurrentView(view);
    },
    [setCurrentView]
  );

  const navigateToFavorites = useCallback(() => {
    const view: AppView = { type: "favorites" };
    window.history.pushState(view, "");
    setCurrentView(view);
  }, [setCurrentView]);

  const navigateHome = useCallback(() => {
    const view: AppView = { type: "home" };
    window.history.pushState(view, "");
    setCurrentView(view);
  }, [setCurrentView]);

  const navigateToSearch = useCallback(
    (query: string) => {
      const view: AppView = { type: "search", query };
      window.history.pushState(view, "");
      setCurrentView(view);
    },
    [setCurrentView]
  );

  const navigateToViewAll = useCallback(
    (title: string, apiPath: string) => {
      const view: AppView = { type: "viewAll", title, apiPath };
      window.history.pushState(view, "");
      setCurrentView(view);
    },
    [setCurrentView]
  );

  const navigateToArtist = useCallback(
    (
      artistId: number,
      artistInfo?: { name: string; picture?: string }
    ) => {
      const view: AppView = { type: "artist", artistId, artistInfo };
      window.history.pushState(view, "");
      setCurrentView(view);
    },
    [setCurrentView]
  );

  const navigateToMix = useCallback(
    (
      mixId: string,
      mixInfo?: { title: string; image?: string; subtitle?: string }
    ) => {
      const view: AppView = { type: "mix", mixId, mixInfo };
      window.history.pushState(view, "");
      setCurrentView(view);
    },
    [setCurrentView]
  );

  const navigateToTrackRadio = useCallback(
    (
      trackId: number,
      trackInfo?: { title: string; artistName?: string; cover?: string }
    ) => {
      const view: AppView = { type: "trackRadio", trackId, trackInfo };
      window.history.pushState(view, "");
      setCurrentView(view);
    },
    [setCurrentView]
  );

  const navigateToExplore = useCallback(() => {
    const view: AppView = { type: "explore" };
    window.history.pushState(view, "");
    setCurrentView(view);
  }, [setCurrentView]);

  const navigateToExplorePage = useCallback(
    (apiPath: string, title: string) => {
      const view: AppView = { type: "explorePage", apiPath, title };
      window.history.pushState(view, "");
      setCurrentView(view);
    },
    [setCurrentView]
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
    navigateToMix,
    navigateToTrackRadio,
    navigateToExplore,
    navigateToExplorePage,
  };
}
