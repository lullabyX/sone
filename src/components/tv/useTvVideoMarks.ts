import { useLayoutEffect } from "react";
import type { TidalVideo } from "../../types";

const MARKS = ["data-tv-native", "data-tv-video", "data-tv-video-mini"];
const MINI_VARS = ["--tv-mini-x", "--tv-mini-y", "--tv-mini-w", "--tv-mini-h"];

/**
 * Marks the video player as soon as it mounts: its buttons become reachable
 * with the arrows and the TV styles apply (scaled controls, desktop-only
 * buttons hidden, never display:none while minimized). The player outlives
 * TV mode, so leaving it strips every mark and the mini placement.
 */
export function useTvVideoMarks(currentVideo: TidalVideo | null): void {
  useLayoutEffect(() => {
    if (!currentVideo) return;
    const dialog = document
      .querySelector("[role='dialog'] video")
      ?.closest<HTMLElement>("[role='dialog']");
    if (!dialog) return;
    // Attributes, not classes: React rewrites the dialog's className
    // whenever the player re-renders, but leaves attributes it never set.
    dialog.setAttribute("data-tv-native", "");
    dialog.setAttribute("data-tv-video", "");
  }, [currentVideo]);

  useLayoutEffect(
    () => () => {
      document
        .querySelectorAll<HTMLElement>("[data-tv-video]")
        .forEach((el) => {
          MARKS.forEach((a) => el.removeAttribute(a));
          MINI_VARS.forEach((v) => el.style.removeProperty(v));
        });
    },
    [],
  );
}
