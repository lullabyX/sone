import { useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { invoke } from "@tauri-apps/api/core";

import {
  currentTrackAtom,
  isPlayingAtom,
  queueAtom,
  manualQueueAtom,
} from "../atoms/playback";
import { getTrackArtistDisplay } from "../utils/itemHelpers";

type NowPlayingSnapshot = {
  trackId: number | null;
  title: string;
  artist: string;
  album: string | null;
  durationSeconds: number;
  positionSeconds: number;
  isPlaying: boolean;
};

type QueueTrackSnapshot = {
  id: number;
  title: string;
  artist: string;
};

// Publishes current playback state to the backend on every relevant atom change.
// Backend MCP tools (get_now_playing, get_queue — Task 5.2) read from this mirror.
// Mount once at the app root.
export function useMcpBridge() {
  const currentTrack = useAtomValue(currentTrackAtom);
  const isPlaying = useAtomValue(isPlayingAtom);
  const queue = useAtomValue(queueAtom);
  const manualQueue = useAtomValue(manualQueueAtom);

  // Position is updated via a custom DOM event so we avoid re-rendering
  // this hook on every tick — a ref read is sufficient at publish time.
  const positionRef = useRef(0);

  useEffect(() => {
    const onTime = (e: Event) => {
      const detail = (e as CustomEvent<{ position: number }>).detail;
      if (typeof detail?.position === "number") {
        positionRef.current = Math.round(detail.position);
      }
    };
    window.addEventListener("sone:playback-position", onTime);
    return () => window.removeEventListener("sone:playback-position", onTime);
  }, []);

  useEffect(() => {
    const nowPlaying: NowPlayingSnapshot | null = currentTrack
      ? {
          trackId: currentTrack.id ?? null,
          title: currentTrack.title ?? "",
          artist: getTrackArtistDisplay(currentTrack),
          album: currentTrack.album?.title ?? null,
          durationSeconds: currentTrack.duration ?? 0,
          positionSeconds: positionRef.current,
          isPlaying,
        }
      : null;

    const merged: QueueTrackSnapshot[] = [...manualQueue, ...queue]
      .slice(0, 50)
      .map((t) => ({
        id: t.id,
        title: t.title ?? "",
        artist: getTrackArtistDisplay(t),
      }));

    invoke("mcp_publish_state", {
      nowPlaying,
      queue: merged,
    }).catch((e) => {
      console.warn("mcp_publish_state failed:", e);
    });
  }, [currentTrack, isPlaying, queue, manualQueue]);
}
