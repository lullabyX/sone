import { useCallback } from "react";
import { useSetAtom } from "jotai";
import {
  createPlaylistFolder,
  renamePlaylistFolder,
  deletePlaylistFolder,
  movePlaylistToFolder,
  getPlaylistFolders,
  normalizePlaylistFolders,
} from "../api/tidal";
import {
  deletedFolderIdsAtom,
  movedPlaylistsAtom,
  renamedFoldersAtom,
  folderCountAdjustmentsAtom,
  addedToFolderAtom,
  allFoldersFetchedAtom,
} from "../atoms/playlists";

const RECENT_FOLDERS_KEY = "sone.recent-folders.v1";
const MAX_RECENT_FOLDERS = 8;

export function getRecentFolderIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_FOLDERS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

export function pushRecentFolderId(folderId: string) {
  const ids = getRecentFolderIds().filter((id) => id !== folderId);
  ids.unshift(folderId);
  if (ids.length > MAX_RECENT_FOLDERS) ids.length = MAX_RECENT_FOLDERS;
  try {
    localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(ids));
  } catch {}
}

export interface MovePlaylistOptions {
  playlistUuid: string;
  targetFolderId: string;
  sourceFolderId?: string;
  /** Minimal playlist data for optimistic display in target folder */
  playlistSnapshot?: { title: string; image?: string; creatorName?: string };
}

export function useFolders() {
  const setDeletedFolderIds = useSetAtom(deletedFolderIdsAtom);
  const setMovedPlaylists = useSetAtom(movedPlaylistsAtom);
  const setRenamedFolders = useSetAtom(renamedFoldersAtom);
  const setCountAdjustments = useSetAtom(folderCountAdjustmentsAtom);
  const setAddedToFolder = useSetAtom(addedToFolderAtom);
  const setFoldersFetched = useSetAtom(allFoldersFetchedAtom);

  const createFolder = useCallback(
    async (
      name: string,
      parentId: string = "root",
      playlistTrn: string = "",
    ): Promise<{ id: string; name: string } | undefined> => {
      const response = await createPlaylistFolder(parentId, name, playlistTrn);
      setFoldersFetched(false);

      // Attempt 1: Extract from response body
      if (response && typeof response === "object") {
        const items = response.items ?? response.data?.items;
        if (Array.isArray(items)) {
          for (const item of items) {
            const folderData = item.data ?? item;
            const trn: string | undefined = folderData.trn;
            if (trn?.startsWith("trn:folder:") && folderData.name === name) {
              return { id: trn.replace("trn:folder:", ""), name };
            }
          }
        }
      }

      // Attempt 2: Re-fetch folder list and find newest match
      try {
        const resp = await getPlaylistFolders(
          "root",
          0,
          50,
          "DATE_UPDATED",
          "DESC",
        );
        const normalized = normalizePlaylistFolders(resp);
        for (const item of normalized.items) {
          if (item.kind === "folder" && item.data.name === name) {
            return { id: item.data.id, name };
          }
        }
      } catch {}

      return undefined;
    },
    [setFoldersFetched],
  );

  const renameFolder = useCallback(
    async (folderId: string, newName: string): Promise<void> => {
      let previousName: string | undefined;
      setRenamedFolders((prev) => {
        previousName = prev.get(folderId);
        const next = new Map(prev);
        next.set(folderId, newName);
        return next;
      });
      try {
        await renamePlaylistFolder(`trn:folder:${folderId}`, newName);
        setFoldersFetched(false);
      } catch (error) {
        setRenamedFolders((prev) => {
          const next = new Map(prev);
          if (previousName !== undefined) next.set(folderId, previousName);
          else next.delete(folderId);
          return next;
        });
        throw error;
      }
    },
    [setRenamedFolders, setFoldersFetched],
  );

  const deleteFolder = useCallback(
    async (folderId: string): Promise<void> => {
      setDeletedFolderIds((prev) => new Set(prev).add(folderId));
      setFoldersFetched(false);
      try {
        await deletePlaylistFolder(`trn:folder:${folderId}`);
      } catch (error) {
        setDeletedFolderIds((prev) => {
          const next = new Set(prev);
          next.delete(folderId);
          return next;
        });
        throw error;
      }
    },
    [setDeletedFolderIds, setFoldersFetched],
  );

  const movePlaylistTo = useCallback(
    async ({
      playlistUuid,
      targetFolderId,
      sourceFolderId,
      playlistSnapshot,
    }: MovePlaylistOptions): Promise<void> => {
      // Optimistic: update atoms immediately
      if (sourceFolderId) {
        setMovedPlaylists((prev) =>
          new Map(prev).set(playlistUuid, sourceFolderId),
        );
        setCountAdjustments((prev) => {
          const next = new Map(prev);
          next.set(sourceFolderId, (next.get(sourceFolderId) ?? 0) - 1);
          return next;
        });
      }
      if (targetFolderId !== "root") {
        setCountAdjustments((prev) => {
          const next = new Map(prev);
          next.set(targetFolderId, (next.get(targetFolderId) ?? 0) + 1);
          return next;
        });
      }
      if (playlistSnapshot) {
        const key = targetFolderId === "root" ? "root" : targetFolderId;
        setAddedToFolder((prev) => {
          const next = new Map(prev);
          const list = next.get(key) ?? [];
          next.set(key, [
            ...list,
            {
              kind: "playlist" as const,
              data: {
                uuid: playlistUuid,
                title: playlistSnapshot.title,
                image: playlistSnapshot.image,
                creator: { id: 0, name: playlistSnapshot.creatorName },
              } as any,
            },
          ]);
          return next;
        });
      }

      try {
        await movePlaylistToFolder(
          targetFolderId,
          `trn:playlist:${playlistUuid}`,
        );
        if (targetFolderId !== "root") {
          pushRecentFolderId(targetFolderId);
        }
      } catch (error) {
        // Rollback all optimistic changes
        if (sourceFolderId) {
          setMovedPlaylists((prev) => {
            const next = new Map(prev);
            next.delete(playlistUuid);
            return next;
          });
          setCountAdjustments((prev) => {
            const next = new Map(prev);
            next.set(sourceFolderId, (next.get(sourceFolderId) ?? 0) + 1);
            return next;
          });
        }
        if (targetFolderId !== "root") {
          setCountAdjustments((prev) => {
            const next = new Map(prev);
            next.set(targetFolderId, (next.get(targetFolderId) ?? 0) - 1);
            return next;
          });
        }
        if (playlistSnapshot) {
          const key = targetFolderId === "root" ? "root" : targetFolderId;
          setAddedToFolder((prev) => {
            const next = new Map(prev);
            const list = (next.get(key) ?? []).filter(
              (e) => !(e.kind === "playlist" && e.data.uuid === playlistUuid),
            );
            if (list.length) next.set(key, list);
            else next.delete(key);
            return next;
          });
        }
        throw error;
      }
    },
    [setMovedPlaylists, setCountAdjustments, setAddedToFolder],
  );

  return {
    createFolder,
    renameFolder,
    deleteFolder,
    movePlaylistTo,
  };
}
