import type { createStore } from "jotai";
import { getPlaylistFolders, normalizePlaylistFolders } from "../../api/tidal";
import {
  addedToFolderAtom,
  folderCountAdjustmentsAtom,
  movedPlaylistsAtom,
} from "../../atoms/playlists";
import type { Folder } from "../../types";

type Store = ReturnType<typeof createStore>;

/** Every top-level folder, by name; what loaded so far if a page fails
 *  (same requests as the desktop's MoveToFolderMenu). */
export async function fetchAllFolders(): Promise<Folder[]> {
  const folders: Folder[] = [];
  let cursor: string | undefined;
  try {
    do {
      const resp = await getPlaylistFolders(
        "root",
        0,
        50,
        "DATE_UPDATED",
        "DESC",
        undefined,
        cursor,
      );
      const normalized = normalizePlaylistFolders(resp);
      for (const item of normalized.items) {
        if (item.kind === "folder") folders.push(item.data);
      }
      cursor = normalized.cursor ?? undefined;
    } while (cursor);
  } catch (err) {
    console.error("[tvFolders] failed to fetch folders:", err);
  }
  return folders.sort((a, b) => a.name.localeCompare(b.name));
}

/** Shows a folder just created with a playlist in it, and takes that
 *  playlist out of the folder it was listed in (as the desktop does). */
export function recordFolderCreated(
  store: Store,
  {
    folderId,
    name,
    playlistUuid,
    sourceFolderId,
  }: {
    folderId: string;
    name: string;
    playlistUuid: string;
    sourceFolderId?: string;
  },
): void {
  store.set(addedToFolderAtom, (prev) => {
    const next = new Map(prev);
    const list = next.get("root") ?? [];
    next.set("root", [
      ...list,
      {
        kind: "folder" as const,
        data: {
          id: folderId,
          name,
          parent: null,
          addedAt: new Date().toISOString(),
          lastModifiedAt: new Date().toISOString(),
          totalNumberOfItems: 1,
        },
      },
    ]);
    return next;
  });
  if (sourceFolderId) {
    store.set(movedPlaylistsAtom, (prev) => {
      const next = new Map(prev);
      next.set(playlistUuid, sourceFolderId);
      return next;
    });
    store.set(folderCountAdjustmentsAtom, (prev) => {
      const next = new Map(prev);
      next.set(sourceFolderId, (next.get(sourceFolderId) ?? 0) - 1);
      return next;
    });
  }
}
