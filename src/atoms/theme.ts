import { atomWithStorage } from "jotai/utils";
import { type Theme, PRESET_THEMES, THEME_STORAGE_KEY } from "../lib/theme";

export const themeAtom = atomWithStorage<Theme>(
  THEME_STORAGE_KEY,
  PRESET_THEMES[0],
);
