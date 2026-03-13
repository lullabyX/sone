import { atom } from "jotai";
import type { Playlist } from "../types";

export const userPlaylistsAtom = atom<Playlist[]>([]);
export const deletedPlaylistIdsAtom = atom<Set<string>>(new Set<string>());
export const deletedFolderIdsAtom = atom<Set<string>>(new Set<string>());
export const folderRefreshKeyAtom = atom<number>(0);
