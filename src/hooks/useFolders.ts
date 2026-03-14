import { useCallback } from "react";
import { useSetAtom } from "jotai";
import {
  createPlaylistFolder,
  renamePlaylistFolder,
  deletePlaylistFolder,
  movePlaylistToFolder,
} from "../api/tidal";
import {
  deletedFolderIdsAtom,
  movedPlaylistsAtom,
  renamedFoldersAtom,
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

export function useFolders() {
  const setDeletedFolderIds = useSetAtom(deletedFolderIdsAtom);
  const setMovedPlaylists = useSetAtom(movedPlaylistsAtom);
  const setRenamedFolders = useSetAtom(renamedFoldersAtom);

  const createFolder = useCallback(
    async (
      name: string,
      parentId: string = "root",
      playlistTrn: string = "",
    ): Promise<void> => {
      await createPlaylistFolder(parentId, name, playlistTrn);
    },
    [],
  );

  const renameFolder = useCallback(
    async (folderId: string, newName: string): Promise<void> => {
      await renamePlaylistFolder(`trn:folder:${folderId}`, newName);
      setRenamedFolders((prev) => {
        const next = new Map(prev);
        next.set(folderId, newName);
        return next;
      });
    },
    [setRenamedFolders],
  );

  const deleteFolder = useCallback(
    async (folderId: string): Promise<void> => {
      await deletePlaylistFolder(`trn:folder:${folderId}`);
      setDeletedFolderIds((prev) => new Set(prev).add(folderId));
    },
    [setDeletedFolderIds],
  );

  const movePlaylistTo = useCallback(
    async (playlistUuid: string, targetFolderId: string, sourceFolderId?: string): Promise<void> => {
      await movePlaylistToFolder(
        targetFolderId,
        `trn:playlist:${playlistUuid}`,
      );
      if (targetFolderId !== "root") {
        pushRecentFolderId(targetFolderId);
      }
      if (sourceFolderId) {
        setMovedPlaylists((prev) => {
          const next = new Map(prev);
          next.set(playlistUuid, sourceFolderId);
          return next;
        });
      }
    },
    [setMovedPlaylists],
  );

  return {
    createFolder,
    renameFolder,
    deleteFolder,
    movePlaylistTo,
  };
}
