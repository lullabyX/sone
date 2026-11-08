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

/** Screen margin (overscan), in percent of the screen on each side, for TVs
 *  that cut off the edges of the picture. */
export type TvOverscan = 0 | 2.5 | 5;
const TV_OVERSCAN_STEPS: TvOverscan[] = [0, 2.5, 5];

export const tvOverscanAtom = atomWithStorage<TvOverscan>(
  "sone.tvOverscan.v1",
  0,
  undefined,
  { getOnInit: true },
);

export function nextTvOverscan(v: TvOverscan): TvOverscan {
  const i = TV_OVERSCAN_STEPS.indexOf(v);
  return TV_OVERSCAN_STEPS[(i + 1) % TV_OVERSCAN_STEPS.length];
}

/** Bumped each time a volume command meets the bit-perfect lock, so the TV
 *  volume indicator can say why nothing changed. */
export const tvVolumeLockedPingAtom = atom(0);

/** Bumped when a volume command is already at 0% or 100%, so the TV volume
 *  indicator still shows the level (setting the same level notifies no one). */
export const tvVolumeLimitPingAtom = atom(0);

export type TvNowPlayingTab = "queue" | "suggested" | "history" | "credits";

/** The last Now Playing tab used, kept for the session only. */
export const tvNowPlayingTabAtom = atom<TvNowPlayingTab>("queue");

/** The TV search text, kept across visits to Search for the session. */
export const tvSearchQueryAtom = atom("");
