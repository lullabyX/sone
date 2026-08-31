import { invoke } from "@tauri-apps/api/core";
import {
  PRESET_THEMES,
  THEME_STORAGE_KEY,
  resolveThemeFile,
  themeToFile,
  themesEqual,
  type Theme,
  type ThemeFile,
} from "./theme";

let writeWarned = false;
function warnWrite(err: unknown) {
  if (!writeWarned) {
    writeWarned = true;
    console.warn(
      "[theme] theme.json unavailable — continuing in localStorage-only mode:",
      err,
    );
  }
}

/**
 * Serialized form of the file we last wrote, or last agreed with on disk.
 *
 * This guards against the echo that arrives at startup: jotai's
 * `atomWithStorage` hydrates `themeAtom` inside `onMount`, so the
 * write-through subscription in `AppInitializer` fires once on mount even
 * when nothing changed. Guarding on what we *would write* (rather than on the
 * bytes on disk) means a hand-written file is left alone until the theme
 * genuinely changes.
 */
let lastPersisted = "";

function markPersisted(theme: Theme) {
  lastPersisted = JSON.stringify(themeToFile(theme));
}

function readStoredTheme(): Theme {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw) {
      const t = JSON.parse(raw) as Theme | null;
      if (t && typeof t.accent === "string" && typeof t.bgBase === "string") {
        return t;
      }
    }
  } catch {
    // fall through to default
  }
  return PRESET_THEMES[0];
}

function writeStoredTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
  } catch {}
}

/** Pre-render bootstrap */
export async function bootstrapThemeFile(): Promise<void> {
  const current = readStoredTheme();
  let file: ThemeFile | null;
  try {
    file = await invoke<ThemeFile | null>("theme_file_get");
  } catch {
    // Invalid file or backend unavailable. Seed the guard from the theme we
    // are about to render so the mount-time echo (below) cannot overwrite a
    // file the user may be part-way through editing. A deliberate theme
    // change still writes, repairing the file.
    markPersisted(current);
    return;
  }
  if (file === null) {
    // Create if not exists
    const newFile = themeToFile(current);
    try {
      await invoke("theme_file_set", { file: newFile });
      lastPersisted = JSON.stringify(newFile);
    } catch (err) {
      warnWrite(err);
    }
    return;
  }
  const resolved = resolveThemeFile(file);
  if (!resolved) {
    markPersisted(current);
    return;
  }
  // Mirror the file into localStorage unconditionally, not just when the
  // colors differ: a stored `name` of "Custom" against a file preset of
  // "Ocean" describes the same colors but serializes differently, and the
  // disagreement would surface as a spurious write on the next launch.
  writeStoredTheme(resolved);
  markPersisted(resolved);
}

async function writeThemeFile(file: ThemeFile): Promise<void> {
  try {
    await invoke("theme_file_set", { file });
    lastPersisted = JSON.stringify(file);
  } catch (err) {
    warnWrite(err);
  }
}

export async function syncThemeToFile(theme: Theme): Promise<void> {
  const file = themeToFile(theme);
  if (JSON.stringify(file) === lastPersisted) return;
  await writeThemeFile(file);
}

/**
 * Re-create `theme.json` after it was deleted while SONE was running.
 *
 * Deliberately skips the no-op guard: the guard tracks what we believe is on
 * disk, and what is on disk is now nothing.
 */
export async function recreateThemeFile(theme: Theme): Promise<void> {
  await writeThemeFile(themeToFile(theme));
}

/**
 * Apply a `theme.json` payload pushed by the backend watcher.
 *
 * Synchronous and side-effect-light on purpose: the watcher already did the
 * read, so there is nothing to await, and no window in which a concurrent
 * in-app change could be clobbered.
 *
 * SONE's own writes also come back through here. `themesEqual` makes that a
 * no-op, which is what keeps write -> watch -> apply -> write from looping.
 * That only holds because `themeToFile(resolveThemeFile(f))` is an identity,
 * so the loop guard is asserted in the tests rather than left implicit.
 */
export function applyExternalThemeFile(
  file: ThemeFile | null,
  getCurrent: () => Theme,
  setCurrent: (theme: Theme) => void,
): void {
  const resolved = resolveThemeFile(file);
  if (!resolved) return;
  if (!themesEqual(resolved, getCurrent())) {
    setCurrent(resolved);
  }
  // Record agreement even when nothing changed, so the write-through this may
  // have just triggered does not echo back to disk.
  markPersisted(resolved);
}
