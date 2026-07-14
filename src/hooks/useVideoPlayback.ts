import { useCallback } from "react";
import { useStore } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  currentVideoAtom,
  videoPlayingAtom,
  videoStreamAtom,
  videoFullscreenAtom,
  videoExpandedAtom,
} from "../atoms/video";
import { startVideoSession } from "../lib/videoSession";
import type { VideoStreamInfo } from "../types";

export type VideoQuality = "HIGH" | "MEDIUM" | "LOW";

interface PlayVideoInput {
  id: number;
  title?: string;
  imageId?: string;
  artist?: string;
  duration?: number;
}

export function useVideoPlayback() {
  const store = useStore();

  /** Open the video takeover: pause audio, resolve metadata + HLS stream, set state. */
  const playVideo = useCallback(
    async (input: PlayVideoInput, quality: VideoQuality = "HIGH") => {
      try {
        await startVideoSession(store, input, quality);
      } catch (err) {
        console.error("Failed to load video:", err);
        // startVideoSession has already dismissed the overlay on failure.
        throw err;
      }
    },
    [store],
  );

  /** Re-resolve the stream at a new quality (caller restores playback position). */
  const setVideoQuality = useCallback(
    async (quality: VideoQuality): Promise<VideoStreamInfo | null> => {
      const current = store.get(currentVideoAtom);
      if (!current) return null;
      try {
        const stream = await invoke<VideoStreamInfo>("get_video_stream_info", {
          videoId: current.id,
          videoQuality: quality,
        });
        store.set(videoStreamAtom, stream);
        return stream;
      } catch (err) {
        console.error("Failed to switch video quality:", err);
        return null;
      }
    },
    [store],
  );

  /** Minimize the overlay to the player bar; the video keeps playing. */
  const minimizeVideo = useCallback(() => {
    store.set(videoExpandedAtom, false);
    // Leaving OS fullscreen up with no overlay would strand the window; drop it.
    if (store.get(videoFullscreenAtom)) {
      store.set(videoFullscreenAtom, false);
      getCurrentWindow()
        .setFullscreen(false)
        .catch(() => {});
    }
  }, [store]);

  /** Re-open the full overlay (the video never stopped). */
  const expandVideo = useCallback(() => {
    store.set(videoExpandedAtom, true);
  }, [store]);

  const closeVideo = useCallback(() => {
    store.set(videoPlayingAtom, false);
    store.set(videoStreamAtom, null);
    store.set(currentVideoAtom, null);
    store.set(videoExpandedAtom, false);
    if (store.get(videoFullscreenAtom)) {
      store.set(videoFullscreenAtom, false);
      getCurrentWindow()
        .setFullscreen(false)
        .catch(() => {});
    }
  }, [store]);

  return {
    playVideo,
    setVideoQuality,
    minimizeVideo,
    expandVideo,
    closeVideo,
  };
}
