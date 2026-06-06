import { atomWithStorage } from "jotai/utils";
import type { SeenUpdate } from "../lib/updateToast";

// Tracks how many times the update toast has been shown for a given version.
export const updateToastSeenAtom = atomWithStorage<SeenUpdate>(
  "sone.updateToast.v1",
  { version: "", count: 0 },
);
