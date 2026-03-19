import { useCallback } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import {
  userPlaylistsAtom,
  deletedPlaylistIdsAtom,
  addedToFolderAtom,
  updatedPlaylistsAtom,
} from "../atoms/playlists";
import { authTokensAtom } from "../atoms/auth";
import { invalidateCache, getPlaylistFolders, normalizePlaylistFolders } from "../api/tidal";
import type { Playlist, PlaylistOrFolder } from "../types";

export function usePlaylists() {
  const [userPlaylists, setUserPlaylists] = useAtom(userPlaylistsAtom);
  const setDeletedPlaylistIds = useSetAtom(deletedPlaylistIdsAtom);
  const setAddedToFolder = useSetAtom(addedToFolderAtom);
  const setUpdatedPlaylists = useSetAtom(updatedPlaylistsAtom);
  const authTokens = useAtomValue(authTokensAtom);

  const createPlaylist = useCallback(
    async (title: string, description: string = "", accessType: string = "UNLISTED"): Promise<Playlist> => {
      if (!authTokens?.user_id) throw new Error("Not authenticated");
      try {
        const playlist = await invoke<Playlist>("create_playlist", {
          title,
          description,
          accessType,
        });
        setUserPlaylists((prev) => [playlist, ...prev]);
        invalidateCache("user-playlists");
        return playlist;
      } catch (error: any) {
        console.error("Failed to create playlist:", error);
        throw error;
      }
    },
    [authTokens?.user_id, setUserPlaylists],
  );

  const updatePlaylist = useCallback(
    async (playlistId: string, title: string, description: string, accessType: string): Promise<Playlist> => {
      try {
        const updated = await invoke<Playlist>("update_playlist", {
          playlistId,
          title,
          description,
          accessType,
        });
        // Merge only defined fields from the response to avoid overwriting
        // existing data (image, numberOfTracks) with undefined from 204 response
        const merged = { ...updated };
        Object.keys(merged).forEach((k) => {
          if ((merged as any)[k] === undefined || (merged as any)[k] === null) {
            delete (merged as any)[k];
          }
        });
        setUserPlaylists((prev) =>
          prev.map((p) => (p.uuid === playlistId ? { ...p, ...merged } : p)),
        );
        // Update optimistic sidebar atom so infinite-scroll items reflect the change
        setUpdatedPlaylists((prev) => {
          const next = new Map(prev);
          next.set(playlistId, { title, description });
          return next;
        });
        invalidateCache("user-playlists");
        return updated;
      } catch (error: any) {
        console.error("Failed to update playlist:", error);
        throw error;
      }
    },
    [setUserPlaylists, setUpdatedPlaylists],
  );

  // Background re-fetch user playlists to pick up server-side changes (image, exact count)
  const refreshUserPlaylists = useCallback(() => {
    getPlaylistFolders("root", 0, 50)
      .then((res) => {
        const normalized = normalizePlaylistFolders(res);
        const freshPlaylists = normalized.items
          .filter((i): i is Extract<PlaylistOrFolder, { kind: "playlist" }> => i.kind === "playlist")
          .map((i) => i.data);
        if (!freshPlaylists.length) return;
        setUserPlaylists((prev) => {
          if (prev.length === 0) return freshPlaylists;
          const freshUuids = new Set(freshPlaylists.map((p) => p.uuid));
          const retained = prev.filter((p) => !freshUuids.has(p.uuid));
          return [...freshPlaylists, ...retained];
        });
        // Also update optimistic sidebar entries with fresh data (image, count)
        const freshMap = new Map(freshPlaylists.map((p) => [p.uuid, p]));
        setAddedToFolder((prev) => {
          const rootList = prev.get("root");
          if (!rootList?.length) return prev;
          let changed = false;
          const updated = rootList.map((entry) => {
            if (entry.kind !== "playlist") return entry;
            const fresh = freshMap.get(entry.data.uuid);
            if (fresh && (fresh.image !== entry.data.image || fresh.numberOfTracks !== entry.data.numberOfTracks)) {
              changed = true;
              return { ...entry, data: { ...entry.data, ...fresh } };
            }
            return entry;
          });
          if (!changed) return prev;
          const next = new Map(prev);
          next.set("root", updated);
          return next;
        });
      })
      .catch(() => {});
  }, [setUserPlaylists, setAddedToFolder]);

  const updatePlaylistTrackCount = useCallback(
    (playlistId: string, delta: number) => {
      setUserPlaylists((prev) =>
        prev.map((p) =>
          p.uuid === playlistId
            ? {
                ...p,
                numberOfTracks: Math.max(0, (p.numberOfTracks ?? 0) + delta),
              }
            : p,
        ),
      );
      invalidateCache("user-playlists");
    },
    [setUserPlaylists],
  );

  const addTrackToPlaylist = useCallback(
    async (playlistId: string, trackId: number): Promise<void> => {
      updatePlaylistTrackCount(playlistId, 1);
      try {
        await invoke("add_track_to_playlist", { playlistId, trackId });
        invalidateCache(`playlist:${playlistId}`);
        invalidateCache(`playlist-page:${playlistId}`);
        refreshUserPlaylists();
      } catch (error: any) {
        updatePlaylistTrackCount(playlistId, -1);
        console.error("Failed to add track to playlist:", error);
        throw error;
      }
    },
    [updatePlaylistTrackCount, refreshUserPlaylists],
  );

  const removeTrackFromPlaylist = useCallback(
    async (playlistId: string, index: number): Promise<void> => {
      updatePlaylistTrackCount(playlistId, -1);
      try {
        await invoke("remove_track_from_playlist", { playlistId, index });
        invalidateCache(`playlist:${playlistId}`);
        invalidateCache(`playlist-page:${playlistId}`);
        refreshUserPlaylists();
      } catch (error: any) {
        updatePlaylistTrackCount(playlistId, 1);
        console.error("Failed to remove track from playlist:", error);
        throw error;
      }
    },
    [updatePlaylistTrackCount, refreshUserPlaylists],
  );

  const deletePlaylist = useCallback(
    async (playlistId: string): Promise<void> => {
      if (!authTokens?.user_id) throw new Error("Not authenticated");
      let removed: Playlist | undefined;
      setUserPlaylists((prev) => {
        removed = prev.find((p) => p.uuid === playlistId);
        return prev.filter((p) => p.uuid !== playlistId);
      });
      setDeletedPlaylistIds((prev: Set<string>) => new Set(prev).add(playlistId));
      try {
        await invoke("delete_playlist", { userId: authTokens.user_id, playlistId });
        invalidateCache(`playlist:${playlistId}`);
        invalidateCache(`playlist-page:${playlistId}`);
        invalidateCache("user-playlists");
      } catch (error: any) {
        if (removed) {
          setUserPlaylists((prev) => [removed!, ...prev]);
        }
        setDeletedPlaylistIds((prev: Set<string>) => {
          const next = new Set(prev);
          next.delete(playlistId);
          return next;
        });
        console.error("Failed to delete playlist:", error);
        throw error;
      }
    },
    [authTokens?.user_id, setUserPlaylists, setDeletedPlaylistIds],
  );

  const addTracksToPlaylist = useCallback(
    async (playlistId: string, trackIds: number[]): Promise<void> => {
      updatePlaylistTrackCount(playlistId, trackIds.length);
      try {
        await invoke("add_tracks_to_playlist", { playlistId, trackIds });
        invalidateCache(`playlist:${playlistId}`);
        invalidateCache(`playlist-page:${playlistId}`);
        invalidateCache("user-playlists");
        refreshUserPlaylists();
        // Delayed refresh to pick up cover art generated server-side
        setTimeout(() => {
          invalidateCache("user-playlists");
          refreshUserPlaylists();
        }, 3000);
      } catch (error: any) {
        updatePlaylistTrackCount(playlistId, -trackIds.length);
        console.error("Failed to add tracks to playlist:", error);
        throw error;
      }
    },
    [updatePlaylistTrackCount, refreshUserPlaylists],
  );

  return {
    userPlaylists,
    createPlaylist,
    updatePlaylist,
    deletePlaylist,
    addTrackToPlaylist,
    removeTrackFromPlaylist,
    addTracksToPlaylist,
  };
}
