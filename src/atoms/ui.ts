import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export const drawerOpenAtom = atom(false);
export const drawerTabAtom = atom<string>("queue");
export const maximizedPlayerAtom = atom(false);
export const maximizedLyricsAtom = atom(false);
export const sidebarCollapsedAtom = atom(false);
export const miniplayerOpenAtom = atom(false);

// `true` = native OS chrome (escape hatch), `false` = custom React titlebar
// (default after migration). Hydrated from Rust `get_decorations` on app boot.
export const decorationsAtom = atom<boolean>(false);

// `true` = hide title bar entirely (no SONE bar, no system bar). Overrides
// `decorationsAtom` when on. Frontend-only preference (localStorage).
export const hideTitleBarAtom = atomWithStorage("sone.hideTitleBar.v1", false);

// `true` = play animated album covers (Tidal videoCover mp4s) on the large
// now-playing art; falls back to static art when off or unavailable. Default ON.
// Frontend-only preference (localStorage).
export const videoCoversAtom = atomWithStorage("sone.videoCovers.v1", true);
