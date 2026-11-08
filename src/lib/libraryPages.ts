import {
  getPlaylistFolders,
  normalizePlaylistFolders,
  getFavoriteAlbums,
  getFavoriteArtists,
  getFavoriteMixes,
} from "../api/tidal";
import type { SortOrder } from "../atoms/favorites";
import type { PlaylistOrFolder } from "../types";

export type LibraryType = "playlists" | "albums" | "artists" | "mixes";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LibraryItem = any;

export async function fetchLibraryPage(
  type: LibraryType,
  o: {
    userId?: number;
    folderId?: string;
    sort: SortOrder;
    offset: number;
    limit: number;
    cursor?: string | null;
  },
): Promise<{
  items: LibraryItem[];
  totalNumberOfItems: number;
  cursor: string | null;
  apiTotal: number;
}> {
  const { userId, sort, offset, limit } = o;
  const plain = (p: { items: LibraryItem[]; totalNumberOfItems: number }) => ({
    items: p.items,
    totalNumberOfItems: p.totalNumberOfItems,
    cursor: null,
    apiTotal: p.totalNumberOfItems,
  });
  switch (type) {
    case "playlists": {
      const response = await getPlaylistFolders(
        o.folderId ?? "root",
        offset,
        limit,
        sort?.order ?? "DATE_UPDATED",
        sort?.direction ?? "DESC",
        undefined,
        offset === 0 ? undefined : (o.cursor ?? undefined),
      );
      const normalized = normalizePlaylistFolders(response);
      const total =
        normalized.cursor && normalized.items.length > 0
          ? offset + normalized.items.length + 1
          : offset + normalized.items.length;
      return {
        items: normalized.items,
        totalNumberOfItems: total,
        cursor: normalized.cursor,
        apiTotal: normalized.totalNumberOfItems,
      };
    }
    case "albums":
      if (!userId) return plain({ items: [], totalNumberOfItems: 0 });
      return plain(
        await getFavoriteAlbums(
          userId,
          offset,
          limit,
          sort?.order ?? "DATE",
          sort?.direction ?? "DESC",
        ),
      );
    case "artists":
      if (!userId) return plain({ items: [], totalNumberOfItems: 0 });
      return plain(
        await getFavoriteArtists(
          userId,
          offset,
          limit,
          sort?.order ?? "DATE",
          sort?.direction ?? "DESC",
        ),
      );
    case "mixes":
      return plain(
        await getFavoriteMixes(
          offset,
          limit,
          sort?.order ?? "DATE",
          sort?.direction ?? "DESC",
        ),
      );
  }
}

export function applyLocalPlaylistEdits(
  items: PlaylistOrFolder[],
  folderId: string,
  e: {
    deletedPlaylistIds: Set<string>;
    deletedFolderIds: Set<string>;
    movedPlaylists: Map<string, string>;
    addedToFolder: Map<string, PlaylistOrFolder[]>;
  },
): PlaylistOrFolder[] {
  const filtered = items.filter((entry) => {
    if (entry.kind === "folder") return !e.deletedFolderIds.has(entry.data.id);
    if (e.deletedPlaylistIds.has(entry.data.uuid)) return false;
    if (e.movedPlaylists.get(entry.data.uuid) === folderId) return false;
    return true;
  });
  const added = e.addedToFolder.get(folderId) ?? [];
  if (added.length === 0) return filtered;
  const existingFolderIds = new Set(
    filtered.filter((x) => x.kind === "folder").map((x) => x.data.id),
  );
  const existingPlaylistUuids = new Set(
    filtered.filter((x) => x.kind === "playlist").map((x) => x.data.uuid),
  );
  const newFolders = added.filter(
    (x) => x.kind === "folder" && !existingFolderIds.has(x.data.id),
  );
  const newPlaylists = added.filter(
    (x) =>
      x.kind === "playlist" &&
      !existingPlaylistUuids.has(x.data.uuid) &&
      e.movedPlaylists.get(x.data.uuid) !== folderId,
  );
  if (newFolders.length === 0 && newPlaylists.length === 0) return filtered;
  return [...newFolders, ...newPlaylists, ...filtered];
}

export function filterLibraryItems(
  type: LibraryType,
  items: LibraryItem[],
  query: string,
  o: { flattened: PlaylistOrFolder[]; renamedFolders: Map<string, string> },
): LibraryItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  if (type === "playlists") {
    const rootEntries = items as PlaylistOrFolder[];
    const rootUuids = new Set(
      rootEntries.flatMap((e) => (e.kind === "playlist" ? [e.data.uuid] : [])),
    );
    const searchSet: PlaylistOrFolder[] = [
      ...rootEntries,
      ...o.flattened.filter(
        (p) => p.kind === "playlist" && !rootUuids.has(p.data.uuid),
      ),
    ];
    return searchSet.filter((entry) => {
      if (entry.kind === "folder") {
        const name = o.renamedFolders.get(entry.data.id) ?? entry.data.name;
        return name.toLowerCase().includes(q);
      }
      return (
        entry.data.title?.toLowerCase().includes(q) ||
        entry.data.description?.toLowerCase().includes(q) ||
        entry.data.creator?.name?.toLowerCase().includes(q)
      );
    });
  }
  return items.filter((item) => {
    switch (type) {
      case "albums":
        return (
          item.title?.toLowerCase().includes(q) ||
          item.artist?.name?.toLowerCase().includes(q)
        );
      case "artists":
        return item.name?.toLowerCase().includes(q);
      case "mixes":
        return (
          item.title?.toLowerCase().includes(q) ||
          item.subTitle?.toLowerCase().includes(q)
        );
    }
  });
}

export function nextSortOrder(current: SortOrder, order: string): SortOrder {
  if (current.order === order) {
    return {
      order,
      direction: current.direction === "DESC" ? "ASC" : "DESC",
    };
  }
  return { order, direction: order === "NAME" ? "ASC" : "DESC" };
}
