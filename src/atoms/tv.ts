import { atom } from "jotai";
import { atomWithStorage, createJSONStorage } from "jotai/utils";

/** The saved TV mode choice (user menu / settings). Read on init so a TV
 *  launch never paints the desktop layout first. */
const tvModePrefAtom = atomWithStorage("sone.tvMode.v1", false, undefined, {
  getOnInit: true,
});

/** `--tv` / `SONE_TV_MODE=1` for this run only. Kept in sessionStorage so it
 *  survives a webview reload; `"off"` once checked without the flag or exited. */
export const tvLaunchAtom = atomWithStorage<"unchecked" | "on" | "off">(
  "sone.tvLaunch.v1",
  "unchecked",
  createJSONStorage(() => sessionStorage),
  { getOnInit: true },
);

/** `true` = the 10-foot TV interface (remote / D-pad navigation, fullscreen)
 *  replaces the desktop layout. Setting it saves the choice; turning it off
 *  also ends a launch override. */
export const tvModeAtom = atom(
  (get) => get(tvModePrefAtom) || get(tvLaunchAtom) === "on",
  (_get, set, on: boolean) => {
    set(tvModePrefAtom, on);
    if (!on) set(tvLaunchAtom, "off");
  },
);

/** Now Playing shows the lyrics in place of the cover (when the track has
 *  any). Remembered, so it stays on from track to track. */
export const tvLyricsAtom = atomWithStorage("sone.tvLyrics.v1", false);
