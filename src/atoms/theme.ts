import { atomWithStorage } from "jotai/utils";
import { type Theme, PRESET_THEMES } from "../lib/theme";

export const themeAtom = atomWithStorage<Theme>(
  "tide-vibe.theme.v1",
  PRESET_THEMES[0],
);
