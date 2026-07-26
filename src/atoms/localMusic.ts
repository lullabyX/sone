import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { Track } from "../types";

export const watchedFoldersAtom = atomWithStorage<string[]>(
  "sone.localMusicFolders.v1",
  [],
  undefined,
  { getOnInit: true },
);

export const localTracksAtom = atom<Track[]>([]);

export const localMusicLoadingAtom = atom(false);

export const localMusicCoverCacheAtom = atom<Record<string, string>>({});
