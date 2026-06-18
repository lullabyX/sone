import { useCallback } from "react";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { invoke } from "@tauri-apps/api/core";
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
import { authTokensAtom } from "../atoms/auth";
import { deletedPlaylistIdsAtom } from "../atoms/playlists";
import {
  addTrackToFavoritesCache,
  removeTrackFromFavoritesCache,
  addAlbumToFavoritesCache,
  removeAlbumFromFavoritesCache,
  addPlaylistToFavoritesCache,
  removePlaylistFromFavoritesCache,
  addArtistToFollowedCache,
  removeArtistFromFollowedCache,
  invalidateCache,
} from "../api/tidal";
import type {
  Track,
  AlbumDetail,
  Playlist,
  ArtistDetail,
  FavoriteMix,
} from "../types";

export function useFavorites() {
  const [favoriteTrackIds, setFavoriteTrackIds] = useAtom(favoriteTrackIdsAtom);
  const [favoriteAlbumIds, setFavoriteAlbumIds] = useAtom(favoriteAlbumIdsAtom);
  const [favoritePlaylistUuids, setFavoritePlaylistUuids] = useAtom(
    favoritePlaylistUuidsAtom,
  );
  const [followedArtistIds, setFollowedArtistIds] = useAtom(
    followedArtistIdsAtom,
  );
  const [favoriteMixIds, setFavoriteMixIds] = useAtom(favoriteMixIdsAtom);
  const authTokens = useAtomValue(authTokensAtom);
  const store = useStore();
  const setDeletedPlaylistIds = useSetAtom(deletedPlaylistIdsAtom);

  // NOTE: Initial loading of favorite IDs has been moved to
  // AppInitializer to avoid firing once per component that calls useFavorites().

  // ==================== Tracks ====================

  const addFavoriteTrack = useCallback(
    async (trackId: number, track?: Track): Promise<void> => {
      if (!authTokens?.user_id) throw new Error("Not authenticated");
      setFavoriteTrackIds((prev: Set<number>) => new Set([...prev, trackId]));
      if (track) addTrackToFavoritesCache(authTokens.user_id, track);
      try {
        await invoke("add_favorite_track", {
          userId: authTokens.user_id,
          trackId,
        });
      } catch (error: any) {
        setFavoriteTrackIds((prev: Set<number>) => {
          const next = new Set(prev);
          next.delete(trackId);
          return next;
        });
        if (track) removeTrackFromFavoritesCache(authTokens.user_id, trackId);
        console.error("Failed to favorite track:", error);
        throw error;
      }
    },
    [authTokens?.user_id, setFavoriteTrackIds],
  );

  const removeFavoriteTrack = useCallback(
    async (trackId: number): Promise<void> => {
      if (!authTokens?.user_id) throw new Error("Not authenticated");
      setFavoriteTrackIds((prev: Set<number>) => {
        const next = new Set(prev);
        next.delete(trackId);
        return next;
      });
      removeTrackFromFavoritesCache(authTokens.user_id, trackId);
      try {
        await invoke("remove_favorite_track", {
          userId: authTokens.user_id,
          trackId,
        });
      } catch (error: any) {
        setFavoriteTrackIds((prev: Set<number>) => new Set([...prev, trackId]));
        console.error("Failed to remove favorite track:", error);
        throw error;
      }
    },
    [authTokens?.user_id, setFavoriteTrackIds],
  );

  // ==================== Albums ====================

  const addFavoriteAlbum = useCallback(
    async (albumId: number, album?: AlbumDetail): Promise<void> => {
      if (!authTokens?.user_id) throw new Error("Not authenticated");
      setFavoriteAlbumIds((prev: Set<number>) => new Set([...prev, albumId]));
      if (album) {
        addAlbumToFavoritesCache(authTokens.user_id, album);
        store.set(optimisticFavoriteAlbumsAtom, (prev) => [
          album,
          ...prev.filter((a) => a.id !== albumId),
        ]);
      }
      try {
        await invoke("add_favorite_album", {
          userId: authTokens.user_id,
          albumId,
        });
      } catch (error: any) {
        setFavoriteAlbumIds((prev: Set<number>) => {
          const next = new Set(prev);
          next.delete(albumId);
          return next;
        });
        if (album) {
          removeAlbumFromFavoritesCache(authTokens.user_id, albumId);
          store.set(optimisticFavoriteAlbumsAtom, (prev) =>
            prev.filter((a) => a.id !== albumId),
          );
        }
        console.error("Failed to favorite album:", error);
        throw error;
      }
    },
    [authTokens?.user_id, setFavoriteAlbumIds, store],
  );

  const removeFavoriteAlbum = useCallback(
    async (albumId: number): Promise<void> => {
      if (!authTokens?.user_id) throw new Error("Not authenticated");
      setFavoriteAlbumIds((prev: Set<number>) => {
        const next = new Set(prev);
        next.delete(albumId);
        return next;
      });
      removeAlbumFromFavoritesCache(authTokens.user_id, albumId);
      store.set(optimisticFavoriteAlbumsAtom, (prev) =>
        prev.filter((a) => a.id !== albumId),
      );
      try {
        await invoke("remove_favorite_album", {
          userId: authTokens.user_id,
          albumId,
        });
      } catch (error: any) {
        setFavoriteAlbumIds((prev: Set<number>) => new Set([...prev, albumId]));
        console.error("Failed to remove favorite album:", error);
        throw error;
      }
    },
    [authTokens?.user_id, setFavoriteAlbumIds, store],
  );

  // ==================== Playlists ====================

  const addFavoritePlaylist = useCallback(
    async (playlistUuid: string, playlist?: Playlist): Promise<void> => {
      if (!authTokens?.user_id) throw new Error("Not authenticated");
      setFavoritePlaylistUuids((prev) => new Set([...prev, playlistUuid]));
      if (playlist) {
        addPlaylistToFavoritesCache(authTokens.user_id, playlist);
      }
      try {
        await invoke("add_favorite_playlist", {
          userId: authTokens.user_id,
          playlistUuid,
        });
      } catch (error: any) {
        setFavoritePlaylistUuids((prev) => {
          const next = new Set(prev);
          next.delete(playlistUuid);
          return next;
        });
        if (playlist) {
          removePlaylistFromFavoritesCache(authTokens.user_id, playlistUuid);
        }
        console.error("Failed to favorite playlist:", error);
        throw error;
      }
    },
    [authTokens?.user_id, setFavoritePlaylistUuids],
  );

  const removeFavoritePlaylist = useCallback(
    async (playlistUuid: string): Promise<void> => {
      if (!authTokens?.user_id) throw new Error("Not authenticated");
      setFavoritePlaylistUuids((prev) => {
        const next = new Set(prev);
        next.delete(playlistUuid);
        return next;
      });
      setDeletedPlaylistIds((prev) => new Set(prev).add(playlistUuid));
      removePlaylistFromFavoritesCache(authTokens.user_id, playlistUuid);
      try {
        await invoke("remove_favorite_playlist", {
          userId: authTokens.user_id,
          playlistUuid,
        });
      } catch (error: any) {
        setFavoritePlaylistUuids((prev) => new Set([...prev, playlistUuid]));
        // Note: favoritePlaylistsAtom is not rolled back — will re-sync on next app load
        console.error("Failed to remove favorite playlist:", error);
        throw error;
      }
    },
    [authTokens?.user_id, setFavoritePlaylistUuids],
  );

  // ==================== Artists (Follow/Unfollow) ====================

  const followArtist = useCallback(
    async (artistId: number, artist?: ArtistDetail): Promise<void> => {
      if (!authTokens?.user_id) throw new Error("Not authenticated");
      setFollowedArtistIds((prev: Set<number>) => new Set([...prev, artistId]));
      if (artist) {
        addArtistToFollowedCache(authTokens.user_id, artist);
        store.set(optimisticFollowedArtistsAtom, (prev) => [
          artist,
          ...prev.filter((a) => a.id !== artistId),
        ]);
      }
      try {
        await invoke("add_favorite_artist", {
          userId: authTokens.user_id,
          artistId,
        });
      } catch (error: any) {
        setFollowedArtistIds((prev: Set<number>) => {
          const next = new Set(prev);
          next.delete(artistId);
          return next;
        });
        if (artist) {
          removeArtistFromFollowedCache(authTokens.user_id, artistId);
          store.set(optimisticFollowedArtistsAtom, (prev) =>
            prev.filter((a) => a.id !== artistId),
          );
        }
        console.error("Failed to follow artist:", error);
        throw error;
      }
    },
    [authTokens?.user_id, setFollowedArtistIds, store],
  );

  const unfollowArtist = useCallback(
    async (artistId: number): Promise<void> => {
      if (!authTokens?.user_id) throw new Error("Not authenticated");
      setFollowedArtistIds((prev: Set<number>) => {
        const next = new Set(prev);
        next.delete(artistId);
        return next;
      });
      removeArtistFromFollowedCache(authTokens.user_id, artistId);
      store.set(optimisticFollowedArtistsAtom, (prev) =>
        prev.filter((a) => a.id !== artistId),
      );
      try {
        await invoke("remove_favorite_artist", {
          userId: authTokens.user_id,
          artistId,
        });
      } catch (error: any) {
        setFollowedArtistIds(
          (prev: Set<number>) => new Set([...prev, artistId]),
        );
        console.error("Failed to unfollow artist:", error);
        throw error;
      }
    },
    [authTokens?.user_id, setFollowedArtistIds, store],
  );

  // ==================== Mixes ====================

  const addFavoriteMix = useCallback(
    async (mixId: string, mix?: FavoriteMix): Promise<void> => {
      if (!authTokens?.user_id) throw new Error("Not authenticated");
      setFavoriteMixIds((prev) => new Set([...prev, mixId]));
      if (mix) {
        store.set(optimisticFavoriteMixesAtom, (prev) => [
          mix,
          ...prev.filter((m) => m.id !== mixId),
        ]);
      }
      invalidateCache("fav-mixes");
      try {
        await invoke("add_favorite_mix", { mixId });
      } catch (error: any) {
        setFavoriteMixIds((prev) => {
          const next = new Set(prev);
          next.delete(mixId);
          return next;
        });
        if (mix) {
          store.set(optimisticFavoriteMixesAtom, (prev) =>
            prev.filter((m) => m.id !== mixId),
          );
        }
        console.error("Failed to favorite mix:", error);
        throw error;
      }
    },
    [authTokens?.user_id, setFavoriteMixIds, store],
  );

  const removeFavoriteMix = useCallback(
    async (mixId: string): Promise<void> => {
      if (!authTokens?.user_id) throw new Error("Not authenticated");
      setFavoriteMixIds((prev) => {
        const next = new Set(prev);
        next.delete(mixId);
        return next;
      });
      store.set(optimisticFavoriteMixesAtom, (prev) =>
        prev.filter((m) => m.id !== mixId),
      );
      invalidateCache("fav-mixes");
      try {
        await invoke("remove_favorite_mix", { mixId });
      } catch (error: any) {
        setFavoriteMixIds((prev) => new Set([...prev, mixId]));
        console.error("Failed to remove favorite mix:", error);
        throw error;
      }
    },
    [authTokens?.user_id, setFavoriteMixIds, store],
  );

  return {
    favoriteTrackIds,
    addFavoriteTrack,
    removeFavoriteTrack,
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
  };
}
