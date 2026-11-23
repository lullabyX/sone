import {
  atomWithStorage,
  createJSONStorage,
  unstable_withStorageValidator,
} from "jotai/utils";
import {
  type Theme,
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  isTheme,
} from "../lib/theme";

// getOnInit reads localStorage at module-eval so the first painted frame uses
// the real theme rather than the default preset. The validator is required,
// not defensive: without it a valid-JSON-wrong-shape value (`null`, `42`)
// would reach the atom and make deriveTheme throw before render() ever runs.
const themeStorage =
  unstable_withStorageValidator(isTheme)(createJSONStorage<unknown>());

export const themeAtom = atomWithStorage<Theme>(
  THEME_STORAGE_KEY,
  DEFAULT_THEME,
  themeStorage,
  { getOnInit: true },
);
