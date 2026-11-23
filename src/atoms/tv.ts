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

/** Set when the TV sign-in's "Other sign-in options" left TV mode, so the
 *  desktop sign-in offers the way back. In memory only: gone on restart. */
export const tvSignInReturnAtom = atom(false);

/** Screen margin (overscan) for TVs that cut off the edges of the picture,
 *  in percent of the screen: `x` on the left and right, `y` at the top and
 *  bottom. Set on the calibration screen (TvMarginCalibration). */
export interface TvOverscan {
  x: number;
  y: number;
}
export const TV_OVERSCAN_MAX = 10;
export const TV_OVERSCAN_STEP = 0.5;

const LEGACY_OVERSCAN_KEY = "sone.tvOverscan.v1";

/** The margin saved before calibration existed: one value for every side. */
export function legacyTvOverscan(): TvOverscan {
  try {
    const v: unknown = JSON.parse(
      localStorage.getItem(LEGACY_OVERSCAN_KEY) ?? "0",
    );
    return typeof v === "number" && v > 0 ? { x: v, y: v } : { x: 0, y: 0 };
  } catch {
    return { x: 0, y: 0 };
  }
}

export const tvOverscanAtom = atomWithStorage<TvOverscan>(
  "sone.tvOverscan.v2",
  legacyTvOverscan(),
  undefined,
  { getOnInit: true },
);

/** The TV's own remote sets the volume (over HDMI-CEC): SONE plays at full
 *  level, without volume controls or the volume indicator in TV mode. */
export const tvVolumeOnTvAtom = atomWithStorage(
  "sone.tvVolumeOnTv.v1",
  false,
  undefined,
  { getOnInit: true },
);

/** TV text (and with it the whole interface, sized in rem) at the size
 *  for the screen, or larger for a small screen or a far couch. */
export type TvTextSize = "normal" | "large";
export const TV_TEXT_SCALE: Record<TvTextSize, number> = {
  normal: 1,
  large: 1.2,
};

export const tvTextSizeAtom = atomWithStorage<TvTextSize>(
  "sone.tvTextSize.v1",
  "normal",
  undefined,
  { getOnInit: true },
);

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
