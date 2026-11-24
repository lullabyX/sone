import { useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { isPlayingAtom } from "../atoms/playback";
import { tvModeAtom } from "../atoms/tv";
import { maximizedPlayerAtom } from "../atoms/ui";
import {
  currentVideoAtom,
  videoExpandedAtom,
  videoFullscreenAtom,
  videoPlayingAtom,
} from "../atoms/video";

/**
 * While anything plays the computer stays awake. The screen stays on only while
 * it plays in the fullscreen player, in TV mode, or as a video on screen.
 * Paused or stopped holds nothing.
 */
export function useIdleInhibit() {
  const isPlaying = useAtomValue(isPlayingAtom);
  const video = useAtomValue(currentVideoAtom);
  const videoPlaying = useAtomValue(videoPlayingAtom) && !!video;
  const videoExpanded = useAtomValue(videoExpandedAtom);
  const videoFullscreen = useAtomValue(videoFullscreenAtom);
  const maximized = useAtomValue(maximizedPlayerAtom);
  const tvMode = useAtomValue(tvModeAtom);

  const sleep = isPlaying || videoPlaying;
  const screen =
    (sleep && (maximized || tvMode)) ||
    (videoPlaying && (videoExpanded || videoFullscreen));

  // Calls can finish out of order; the backend drops any older than the last.
  // Time-based so a reloaded page still outranks the one before it.
  const seq = useRef(0);
  useEffect(() => {
    seq.current = Math.max(Date.now(), seq.current + 1);
    invoke("set_idle_inhibit", { sleep, screen, seq: seq.current }).catch(
      () => {},
    );
  }, [sleep, screen]);
}
