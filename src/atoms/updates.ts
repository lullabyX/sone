import { atomWithStorage } from "jotai/utils";
import type { SeenUpdate } from "../lib/updateToast";

// Tracks how many times the update toast has been shown for a given version.
// getOnInit reads the persisted value synchronously at startup so the one-shot
// startup effect observes the real counter rather than the default.
export const updateToastSeenAtom = atomWithStorage<SeenUpdate>(
  "sone.updateToast.v1",
  { version: "", count: 0 },
  undefined,
  { getOnInit: true },
);
