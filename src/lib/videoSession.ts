import type { createStore } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { isPlayingAtom } from "../atoms/playback";
import {
  currentVideoAtom,
  videoStreamAtom,
  videoPlayingAtom,
  videoExpandedAtom,
} from "../atoms/video";
import type { TidalVideo, VideoStreamInfo } from "../types";

type Store = ReturnType<typeof createStore>;

export interface VideoSessionInput {
  id: number;
  title?: string;
  imageId?: string;
  artist?: string;
  duration?: number;
}

/** Stop audio and load `input` into the <video> player (expanded). Shared by the
 *  standalone-card path (useVideoPlayback) and the queue path (playTrack). */
export async function startVideoSession(
  store: Store,
  input: VideoSessionInput,
  quality: "HIGH" | "MEDIUM" | "LOW" = "HIGH",
): Promise<void> {
  store.set(isPlayingAtom, false);

  // Seed a placeholder so the overlay/bar update instantly.
  store.set(currentVideoAtom, {
    id: input.id,
    title: input.title ?? "",
    duration: input.duration ?? 0,
    imageId: input.imageId,
    artist: input.artist ? { id: 0, name: input.artist } : undefined,
  });
  store.set(videoStreamAtom, null);
  store.set(videoPlayingAtom, false);
  store.set(videoExpandedAtom, true);

  // Tear the audio pipeline down before the video's own audio begins.
  await invoke("stop_track").catch(() => {});

  try {
    const [meta, stream] = await Promise.all([
      invoke<TidalVideo>("get_video_metadata", { videoId: input.id }),
      invoke<VideoStreamInfo>("get_video_stream_info", {
        videoId: input.id,
        videoQuality: quality,
      }),
    ]);
    store.set(currentVideoAtom, meta);
    store.set(videoStreamAtom, stream);
  } catch (err) {
    // Resolution failed — dismiss the overlay rather than spin forever.
    store.set(currentVideoAtom, null);
    store.set(videoStreamAtom, null);
    store.set(videoExpandedAtom, false);
    throw err;
  }
}
