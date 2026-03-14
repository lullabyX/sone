import { atom } from "jotai";
import type { Playlist, PlaylistOrFolder } from "../types";

export const userPlaylistsAtom = atom<Playlist[]>([]);
export const deletedPlaylistIdsAtom = atom<Set<string>>(new Set<string>());
export const deletedFolderIdsAtom = atom<Set<string>>(new Set<string>());
/** Maps playlistUuid -> sourceFolderId (the folder it was moved FROM) */
export const movedPlaylistsAtom = atom<Map<string, string>>(new Map());
/** Optimistic count adjustments per folder: folderId -> delta (+1 or -1) */
export const folderCountAdjustmentsAtom = atom<Map<string, number>>(new Map());
/** Optimistic playlist additions per folder: folderId -> PlaylistOrFolder[] */
export const addedToFolderAtom = atom<Map<string, PlaylistOrFolder[]>>(new Map());
/** Optimistic folder renames: folderId -> newName */
export const renamedFoldersAtom = atom<Map<string, string>>(new Map());
