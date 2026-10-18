import { createContext, useContext, useEffect } from "react";
import { focusFirstIn } from "../../lib/spatialNav";
import type { MediaItemType, Track } from "../../types";
import type { usePlaybackActions } from "../../hooks/usePlaybackActions";
import type { TvAction, TvView } from "./tvItems";
import type { TvMenuItem, TvMenuSpec } from "./tvMenu";
import type { TvPromptRequest } from "./TvPrompt";

export interface TvNav {
  /** Open a screen on top of the current one; Back returns to it. */
  push: (view: TvView) => void;
  back: () => void;
  /** Show Now Playing on top of the current screen (after starting playback). */
  showNowPlaying: () => void;
  /** Play `track` with `tracks` queued around it and show Now Playing. If
   *  it is the track already playing, it only shows Now Playing. */
  playTrack: (
    track: Track,
    tracks: Track[],
    options?: Parameters<
      ReturnType<typeof usePlaybackActions>["playFromSource"]
    >[2],
  ) => void;
  /** Open the action menu (the TV's right-click menu). */
  openMenu: (spec: TvMenuSpec) => void;
  /** Action menus for a track and for an album / playlist / mix / artist.
   *  `extra` adds actions that depend on where the track is listed. */
  trackMenu: (track: Track, extra?: TvMenuItem[]) => TvMenuSpec;
  /** `onItsPage`: opened from the item's own page (no "Open ..." entry). */
  mediaMenu: (item: MediaItemType, onItsPage?: boolean) => TvMenuSpec;
  /** Ask for a line of text with the on-screen keyboard; null if cancelled. */
  prompt: (request: TvPromptRequest) => Promise<string | null>;
  /** Open the full desktop settings sheet, navigable with the remote. */
  openMoreSettings: () => void;
  /** Carry out a card's action. `queue` is the row it sits in, so playing a
   *  track keeps the rest of that row queued behind it. */
  run: (
    action: TvAction,
    queue?: { tracks: Track[]; name: string; id: string },
  ) => void;
}

export const TvNavContext = createContext<TvNav | null>(null);

export function useTvNav(): TvNav {
  const nav = useContext(TvNavContext);
  if (!nav) throw new Error("useTvNav must be used inside the TV interface");
  return nav;
}

interface TvScreen {
  /** Whether this screen is the one on top. Screens below it stay mounted
   *  (so Back restores their focus and scroll) but must not grab focus. */
  active: boolean;
  element: () => HTMLElement | null;
}

export const TvScreenContext = createContext<TvScreen>({
  active: true,
  element: () => null,
});

/**
 * Put focus on the screen's first item (or its `data-tv-autofocus` one) once
 * its content has loaded — unless focus is already inside it, e.g. restored
 * by Back. Checked a frame later so a restore in the same commit wins.
 */
export function useTvInitialFocus(ready: boolean) {
  const { active, element } = useContext(TvScreenContext);
  useEffect(() => {
    if (!ready || !active) return;
    const id = requestAnimationFrame(() => {
      const el = element();
      if (!el || el.contains(document.activeElement)) return;
      focusFirstIn(el);
    });
    return () => cancelAnimationFrame(id);
  }, [ready, active, element]);
}
