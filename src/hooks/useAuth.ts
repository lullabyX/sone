import { useCallback } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import {
  isAuthenticatedAtom,
  authTokensAtom,
  userNameAtom,
} from "../atoms/auth";
import {
  userPlaylistsAtom,
  allPlaylistsAtom,
  allFoldersAtom,
  allFoldersFetchedAtom,
  deletedPlaylistIdsAtom,
  deletedFolderIdsAtom,
  movedPlaylistsAtom,
  folderCountAdjustmentsAtom,
  addedToFolderAtom,
  renamedFoldersAtom,
  updatedPlaylistsAtom,
} from "../atoms/playlists";
import {
  isPlayingAtom,
  currentTrackAtom,
  queueAtom,
  historyAtom,
  streamInfoAtom,
  userPausedAtom,
} from "../atoms/playback";
import {
  favoriteTrackIdsAtom,
  favoriteAlbumIdsAtom,
  favoritePlaylistUuidsAtom,
  followedArtistIdsAtom,
  favoriteMixIdsAtom,
  optimisticFavoriteAlbumsAtom,
  optimisticFollowedArtistsAtom,
  optimisticFavoriteMixesAtom,
} from "../atoms/favorites";
import { currentViewAtom } from "../atoms/navigation";
import {
  clearCache,
  getPlaylistFolders,
  normalizePlaylistFolders,
} from "../api/tidal";
import type {
  AuthTokens,
  PkceAuthParams,
  DeviceAuthResponse,
  Playlist,
  PlaylistOrFolder,
} from "../types";

const PLAYBACK_STATE_KEY = "sone.playback-state.v1";
const VOLUME_STATE_KEY = "sone.volume.v1";

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useAtom(isAuthenticatedAtom);
  const [authTokens, setAuthTokens] = useAtom(authTokensAtom);
  const userName = useAtomValue(userNameAtom);

  // Cross-domain setters for logout
  const setUserName = useSetAtom(userNameAtom);
  const setUserPlaylists = useSetAtom(userPlaylistsAtom);
  const setIsPlaying = useSetAtom(isPlayingAtom);
  const setCurrentTrack = useSetAtom(currentTrackAtom);
  const setQueue = useSetAtom(queueAtom);
  const setHistory = useSetAtom(historyAtom);
  const setStreamInfo = useSetAtom(streamInfoAtom);
  const setUserPaused = useSetAtom(userPausedAtom);
  const setFavoriteTrackIds = useSetAtom(favoriteTrackIdsAtom);
  const setFavoriteAlbumIds = useSetAtom(favoriteAlbumIdsAtom);
  const setFavoritePlaylistUuids = useSetAtom(favoritePlaylistUuidsAtom);
  const setFollowedArtistIds = useSetAtom(followedArtistIdsAtom);
  const setFavoriteMixIds = useSetAtom(favoriteMixIdsAtom);
  const setOptimisticFavoriteAlbums = useSetAtom(optimisticFavoriteAlbumsAtom);
  const setOptimisticFollowedArtists = useSetAtom(
    optimisticFollowedArtistsAtom,
  );
  const setOptimisticFavoriteMixes = useSetAtom(optimisticFavoriteMixesAtom);
  const setCurrentView = useSetAtom(currentViewAtom);
  const setAllPlaylists = useSetAtom(allPlaylistsAtom);
  const setAllFolders = useSetAtom(allFoldersAtom);
  const setAllFoldersFetched = useSetAtom(allFoldersFetchedAtom);
  const setDeletedPlaylistIds = useSetAtom(deletedPlaylistIdsAtom);
  const setDeletedFolderIds = useSetAtom(deletedFolderIdsAtom);
  const setMovedPlaylists = useSetAtom(movedPlaylistsAtom);
  const setFolderCountAdjustments = useSetAtom(folderCountAdjustmentsAtom);
  const setAddedToFolder = useSetAtom(addedToFolderAtom);
  const setRenamedFolders = useSetAtom(renamedFoldersAtom);
  const setUpdatedPlaylists = useSetAtom(updatedPlaylistsAtom);

  // NOTE: Auth loading effect has been moved to AppInitializer
  // to avoid running once per component that calls useAuth().

  const importSession = useCallback(
    async (
      clientId: string,
      clientSecret: string,
      refreshToken: string,
      accessToken?: string,
    ): Promise<AuthTokens> => {
      try {
        const tokens = await invoke<AuthTokens>("import_session", {
          clientId,
          clientSecret,
          refreshToken,
          accessToken: accessToken || null,
        });
        let userId = tokens.user_id;
        if (!userId) {
          try {
            userId = await invoke<number>("get_session_user_id");
          } catch (e) {
            console.error("Failed to get user ID:", e);
          }
        }
        const updatedTokens = { ...tokens, user_id: userId };
        setAuthTokens(updatedTokens);
        setIsAuthenticated(true);
        return updatedTokens;
      } catch (error) {
        console.error("Failed to import session:", error);
        throw error;
      }
    },
    [setAuthTokens, setIsAuthenticated],
  );

  const startDeviceAuth = useCallback(
    async (
      clientId: string,
      clientSecret: string,
    ): Promise<DeviceAuthResponse> => {
      try {
        return await invoke<DeviceAuthResponse>("start_device_auth", {
          clientId,
          clientSecret,
        });
      } catch (error) {
        console.error("Failed to start device auth:", error);
        throw error;
      }
    },
    [],
  );

  const pollDeviceAuth = useCallback(
    async (
      deviceCode: string,
      clientId: string,
      clientSecret: string,
    ): Promise<AuthTokens | null> => {
      try {
        const result = await invoke<AuthTokens | null>("poll_device_auth", {
          deviceCode,
          clientId,
          clientSecret,
        });

        if (result) {
          let userId = result.user_id;
          if (!userId) {
            try {
              userId = await invoke<number>("get_session_user_id");
            } catch (e) {
              console.error("Failed to get user ID:", e);
            }
          }
          const updatedTokens = { ...result, user_id: userId };
          setAuthTokens(updatedTokens);
          setIsAuthenticated(true);
          return updatedTokens;
        }

        return null;
      } catch (error) {
        console.error("Failed to poll device auth:", error);
        throw error;
      }
    },
    [setAuthTokens, setIsAuthenticated],
  );

  const startPkceAuth = useCallback(
    async (clientId: string): Promise<PkceAuthParams> => {
      try {
        return await invoke<PkceAuthParams>("start_pkce_auth", { clientId });
      } catch (error) {
        console.error("Failed to start PKCE auth:", error);
        throw error;
      }
    },
    [],
  );

  const completePkceAuth = useCallback(
    async (
      code: string,
      codeVerifier: string,
      clientUniqueKey: string,
      clientId: string,
      clientSecret: string,
    ): Promise<AuthTokens> => {
      try {
        const tokens = await invoke<AuthTokens>("complete_pkce_auth", {
          code,
          codeVerifier,
          clientUniqueKey,
          clientId,
          clientSecret,
        });

        let userId = tokens.user_id;
        if (!userId) {
          try {
            userId = await invoke<number>("get_session_user_id");
          } catch (e) {
            console.error("Failed to get user ID:", e);
          }
        }

        const updatedTokens = { ...tokens, user_id: userId };
        setAuthTokens(updatedTokens);
        setIsAuthenticated(true);
        return updatedTokens;
      } catch (error) {
        console.error("Failed to complete PKCE auth:", error);
        throw error;
      }
    },
    [setAuthTokens, setIsAuthenticated],
  );

  const logout = useCallback(async () => {
    // Clear playback intent immediately so any in-flight track event is ignored.
    setIsPlaying(false);
    setCurrentTrack(null);
    setQueue([]);
    try {
      await invoke("logout");
    } catch (error) {
      console.error("Failed to logout:", error);
    } finally {
      clearCache();
      setAuthTokens(null);
      setIsAuthenticated(false);
      setUserName("TIDAL User");
      // Playback
      setHistory([]);
      setStreamInfo(null);
      setUserPaused(false);
      // Favorites (all kinds) + optimistic overlays
      setFavoriteTrackIds(new Set());
      setFavoriteAlbumIds(new Set());
      setFavoritePlaylistUuids(new Set());
      setFollowedArtistIds(new Set());
      setFavoriteMixIds(new Set());
      setOptimisticFavoriteAlbums([]);
      setOptimisticFollowedArtists([]);
      setOptimisticFavoriteMixes([]);
      // Playlists / folders (lists + optimistic mutation overlays)
      setUserPlaylists([]);
      setAllPlaylists([]);
      setAllFolders([]);
      setAllFoldersFetched(false);
      setDeletedPlaylistIds(new Set());
      setDeletedFolderIds(new Set());
      setMovedPlaylists(new Map());
      setFolderCountAdjustments(new Map());
      setAddedToFolder(new Map());
      setRenamedFolders(new Map());
      setUpdatedPlaylists(new Map());
      // Navigation
      setCurrentView({ type: "home" });
      try {
        localStorage.removeItem(PLAYBACK_STATE_KEY);
        localStorage.removeItem(VOLUME_STATE_KEY);
        localStorage.removeItem("sone.search-history");
      } catch (err) {
        console.error("Failed to clear local storage:", err);
      }
    }
  }, [
    setAuthTokens,
    setIsAuthenticated,
    setUserName,
    setUserPlaylists,
    setIsPlaying,
    setCurrentTrack,
    setQueue,
    setHistory,
    setStreamInfo,
    setUserPaused,
    setFavoriteTrackIds,
    setFavoriteAlbumIds,
    setFavoritePlaylistUuids,
    setFollowedArtistIds,
    setFavoriteMixIds,
    setOptimisticFavoriteAlbums,
    setOptimisticFollowedArtists,
    setOptimisticFavoriteMixes,
    setAllPlaylists,
    setAllFolders,
    setAllFoldersFetched,
    setDeletedPlaylistIds,
    setDeletedFolderIds,
    setMovedPlaylists,
    setFolderCountAdjustments,
    setAddedToFolder,
    setRenamedFolders,
    setUpdatedPlaylists,
    setCurrentView,
  ]);

  const getUserPlaylists = useCallback(
    async (_userId: number): Promise<Playlist[]> => {
      try {
        const result = await getPlaylistFolders("root", 0, 50);
        const normalized = normalizePlaylistFolders(result);
        const playlists = normalized.items
          .filter(
            (i): i is Extract<PlaylistOrFolder, { kind: "playlist" }> =>
              i.kind === "playlist",
          )
          .map((i) => i.data);
        setUserPlaylists(playlists);
        return playlists;
      } catch (error) {
        console.error("Failed to get playlists:", error);
        return [];
      }
    },
    [setUserPlaylists],
  );

  return {
    isAuthenticated,
    authTokens,
    userName,
    importSession,
    startDeviceAuth,
    pollDeviceAuth,
    startPkceAuth,
    completePkceAuth,
    logout,
    getUserPlaylists,
  };
}
