import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { SeenUpdate, UpdateInfo } from "../lib/updateToast";

// Tracks how many times the update toast has been shown for a given version.
// getOnInit reads the persisted value synchronously at startup so the one-shot
// startup effect observes the real counter rather than the default.
export const updateToastSeenAtom = atomWithStorage<SeenUpdate>(
  "sone.updateToast.v1",
  { version: "", count: 0 },
  undefined,
  { getOnInit: true },
);

// The launch update check's answer, shown in TV Settings → About.
export const updateInfoAtom = atom<UpdateInfo | null>(null);
