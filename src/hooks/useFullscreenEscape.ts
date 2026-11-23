import { useCallback } from "react";
import { useAtomValue } from "jotai";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { maximizedPlayerAtom } from "../atoms/ui";
import { videoFullscreenAtom } from "../atoms/video";
import { tvModeAtom } from "../atoms/tv";
import { DISMISS_PRIORITY } from "../lib/dismissStack";
import { useEscapeDismiss } from "./useEscapeDismiss";
import { useWindowFullscreen } from "./useWindowFullscreen";

/** In the desktop layout, Escape leaves a fullscreen that neither the
 *  maximized player nor a video owns (they handle Escape themselves), after
 *  every open layer has been closed. */
export function useFullscreenEscape(): void {
  const fullscreen = useWindowFullscreen();
  const tvMode = useAtomValue(tvModeAtom);
  const maximized = useAtomValue(maximizedPlayerAtom);
  const videoFullscreen = useAtomValue(videoFullscreenAtom);
  const leave = useCallback(() => {
    getCurrentWindow()
      .setFullscreen(false)
      .catch(() => {});
  }, []);
  useEscapeDismiss(
    fullscreen && !tvMode && !maximized && !videoFullscreen,
    leave,
    DISMISS_PRIORITY.window,
  );
}
