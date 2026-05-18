import { useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  currentTrackAtom,
  isPlayingAtom,
  queueAtom,
  manualQueueAtom,
  repeatAtom,
} from "../atoms/playback";
import { getTrackArtistDisplay } from "../utils/itemHelpers";
import { usePlaybackActions } from "./usePlaybackActions";
import {
  getTrack,
  getPlaylistTracks,
  getMixItems,
  getArtistTopTracks,
  getAlbumPage,
} from "../api/tidal";
import type { Track } from "../types";

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

export function useMcpBridge() {
  const currentTrack = useAtomValue(currentTrackAtom);
  const isPlaying = useAtomValue(isPlayingAtom);
  const queue = useAtomValue(queueAtom);
  const manualQueue = useAtomValue(manualQueueAtom);
  const setRepeat = useSetAtom(repeatAtom);
  const actions = usePlaybackActions();

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

  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [];

    unlisteners.push(
      listen<{ trackIds: number[]; action: string }>("mcp:play-tracks", async (e) => {
        const { trackIds, action } = e.payload;
        try {
          const settled = await Promise.allSettled(
            trackIds.map((id) => getTrack(id)),
          );
          const tracks = settled
            .filter((r): r is PromiseFulfilledResult<Track> => r.status === "fulfilled")
            .map((r) => r.value);
          if (tracks.length === 0) return;

          if (action === "play_now") {
            actions.setQueueTracks(tracks);
            await actions.playTrack(tracks[0]);
          } else if (action === "queue") {
            actions.appendToQueue(tracks);
          } else if (action === "play_next") {
            for (const t of [...tracks].reverse()) actions.playNextInQueue(t);
          }
        } catch (err) {
          console.error("mcp:play-tracks failed:", err);
        }
      }),
    );

    unlisteners.push(
      listen<{ sourceType: string; id: string }>("mcp:play-source", async (e) => {
        const { sourceType, id } = e.payload;
        try {
          let tracks: Track[] = [];
          if (sourceType === "playlist") {
            tracks = await getPlaylistTracks(id);
          } else if (sourceType === "album") {
            const { page } = await getAlbumPage(Number(id));
            tracks = page.tracks;
          } else if (sourceType === "mix") {
            tracks = (await getMixItems(id)).tracks;
          } else if (sourceType === "artist") {
            tracks = await getArtistTopTracks(Number(id));
          }
          if (tracks.length === 0) return;
          await actions.playAllFromSource(tracks);
        } catch (err) {
          console.error("mcp:play-source failed:", err);
        }
      }),
    );

    unlisteners.push(listen("mcp:pause", () => { actions.pauseTrack().catch(() => {}); }));
    unlisteners.push(listen("mcp:resume", () => { actions.resumeTrack().catch(() => {}); }));
    unlisteners.push(listen("mcp:skip-next", () => { actions.playNext({ explicit: true }).catch(() => {}); }));
    unlisteners.push(listen("mcp:skip-previous", () => { actions.playPrevious().catch(() => {}); }));
    unlisteners.push(listen("mcp:clear-queue", () => { actions.clearQueue(); }));
    unlisteners.push(listen("mcp:toggle-shuffle", () => { actions.toggleShuffle(); }));

    unlisteners.push(
      listen<{ positionSeconds: number }>("mcp:seek", (e) => {
        actions.seekTo(e.payload.positionSeconds).catch(() => {});
      }),
    );

    unlisteners.push(
      listen<{ level: number }>("mcp:set-volume", (e) => {
        actions.setVolume(e.payload.level).catch(() => {});
      }),
    );

    unlisteners.push(
      listen<{ trackId: number }>("mcp:remove-from-queue", (e) => {
        // removeFromQueue takes an index into the combined [manualQueue, queue] array.
        // Find the first occurrence of the given trackId across both segments.
        const combined = [...manualQueue, ...queue];
        const index = combined.findIndex((t) => t.id === e.payload.trackId);
        if (index !== -1) actions.removeFromQueue(index);
      }),
    );

    unlisteners.push(
      listen<{ mode: string }>("mcp:set-repeat", (e) => {
        const map: Record<string, number> = { off: 0, all: 1, one: 2 };
        const v = map[e.payload.mode];
        if (v !== undefined) setRepeat(v);
      }),
    );

    return () => {
      for (const p of unlisteners) {
        p.then((fn) => fn()).catch(() => {});
      }
    };
  }, [actions, setRepeat, manualQueue, queue]);
}
