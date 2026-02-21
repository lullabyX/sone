/**
 * usePlaybackActions — stable action callbacks that NEVER cause re-renders.
 *
 * Uses Jotai's store.get()/store.set() directly instead of useAtom(),
 * so calling components do NOT subscribe to any playback atoms.
 *
 * Use this in components that only need to trigger playback actions
 * (play, pause, queue, etc.) but don't need to read playback state.
 */

import { useCallback } from "react";
import { useStore } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import {
  isPlayingAtom,
  currentTrackAtom,
  volumeAtom,
  queueAtom,
  historyAtom,
  streamInfoAtom,
  autoplayAtom,
  useTrackGainAtom,
} from "../atoms/playback";
import { getTrackRadio } from "../api/tidal";
import type { Track, StreamInfo } from "../types";

/** Normalize a raw track-like object into a proper Track.
 *  Handles the artist/artists mismatch from different API endpoints. */
function normalizeTrack(raw: any): Track {
  const track = { ...raw } as Track;
  if (!track.artist && raw.artists?.[0]) {
    track.artist = raw.artists[0];
  }
  return track;
}

/** Safely extract a human-readable message from a SoneError (or any thrown value). */
function extractPlaybackError(error: unknown): string {
  if (!error) return "Playback failed";
  let parsed: any = error;
  if (typeof error === "string") {
    try { parsed = JSON.parse(error); } catch { return error; }
  }
  const msg = parsed?.message;
  return typeof msg === "string" ? msg : "Playback failed";
}

export function usePlaybackActions() {
  const store = useStore();

  const playTrack = useCallback(
    async (track: Track) => {
      try {
        const current = store.get(currentTrackAtom);
        if (current) {
          store.set(historyAtom, [...store.get(historyAtom), current]);
        }
        const normalized = normalizeTrack(track);
        const info = await invoke<StreamInfo>("play_tidal_track", {
          trackId: normalized.id,
          useTrackGain: store.get(useTrackGainAtom),
        });
        store.set(streamInfoAtom, info);
        store.set(currentTrackAtom, normalized);
        store.set(isPlayingAtom, true);
      } catch (error: any) {
        console.error("Failed to play track:", error);
        store.set(isPlayingAtom, false);
        window.dispatchEvent(new CustomEvent("playback-error", { detail: extractPlaybackError(error) }));
      }
    },
    [store]
  );

  const pauseTrack = useCallback(async () => {
    try {
      await invoke("pause_track");
      store.set(isPlayingAtom, false);
    } catch (error) {
      console.error("Failed to pause track:", error);
    }
  }, [store]);

  const resumeTrack = useCallback(async () => {
    try {
      const track = store.get(currentTrackAtom);
      if (!track) return;

      const isFinished = await invoke<boolean>("is_track_finished");
      if (isFinished) {
        const info = await invoke<StreamInfo>("play_tidal_track", {
          trackId: track.id,
          useTrackGain: store.get(useTrackGainAtom),
        });
        store.set(streamInfoAtom, info);
      } else {
        await invoke("resume_track");
      }
      store.set(isPlayingAtom, true);
    } catch (error) {
      console.error("Failed to resume track:", error);
      store.set(isPlayingAtom, false);
      window.dispatchEvent(new CustomEvent("playback-error", { detail: extractPlaybackError(error) }));
    }
  }, [store]);

  const setVolume = useCallback(
    async (level: number) => {
      store.set(volumeAtom, level);
      try {
        await invoke("set_volume", { level });
      } catch (error) {
        console.error("Failed to set volume:", error);
      }
    },
    [store]
  );

  const getPlaybackPosition = useCallback(async (): Promise<number> => {
    try {
      return await invoke<number>("get_playback_position");
    } catch (error) {
      console.error("Failed to get playback position:", error);
      return 0;
    }
  }, []);

  const seekTo = useCallback(async (positionSecs: number) => {
    try {
      await invoke("seek_track", { positionSecs });
    } catch (error) {
      console.error("Failed to seek:", error);
    }
  }, []);

  const addToQueue = useCallback(
    (track: Track) => {
      store.set(queueAtom, [...store.get(queueAtom), normalizeTrack(track)]);
    },
    [store]
  );

  const playNextInQueue = useCallback(
    (track: Track) => {
      store.set(queueAtom, [normalizeTrack(track), ...store.get(queueAtom)]);
    },
    [store]
  );

  const setQueueTracks = useCallback(
    (tracks: Track[], options?: { albumMode?: boolean }) => {
      store.set(useTrackGainAtom, !options?.albumMode);
      store.set(queueAtom, tracks.map(normalizeTrack));
    },
    [store]
  );

  const removeFromQueue = useCallback(
    (index: number) => {
      store.set(
        queueAtom,
        store.get(queueAtom).filter((_, i) => i !== index)
      );
    },
    [store]
  );

  const playNext = useCallback(async () => {
    const queue = store.get(queueAtom);
    if (queue.length > 0) {
      const [nextTrack, ...rest] = queue;
      store.set(queueAtom, rest);
      await playTrack(nextTrack);
    } else if (store.get(autoplayAtom)) {
      const current = store.get(currentTrackAtom);
      if (current) {
        try {
          const historyIds = new Set(
            store.get(historyAtom).map((t) => t.id)
          );
          historyIds.add(current.id);
          const radio = await getTrackRadio(current.id, 30);
          const fresh = radio.filter((t) => !historyIds.has(t.id));
          if (fresh.length > 0) {
            const [next, ...rest] = fresh;
            store.set(queueAtom, rest);
            store.set(useTrackGainAtom, true); // radio = mixed context
            await playTrack(next);
            return;
          }
        } catch {
          /* fall through to stop */
        }
      }
      store.set(isPlayingAtom, false);
    } else {
      store.set(isPlayingAtom, false);
    }
  }, [store, playTrack]);

  const playPrevious = useCallback(async () => {
    try {
      const pos = await getPlaybackPosition();
      if (pos > 3) {
        await seekTo(0);
        return;
      }
    } catch {
      // ignore position errors
    }

    const history = store.get(historyAtom);
    if (history.length > 0) {
      const newHistory = [...history];
      const prevTrack = newHistory.pop()!;
      store.set(historyAtom, newHistory);

      const current = store.get(currentTrackAtom);
      if (current) {
        store.set(queueAtom, [current, ...store.get(queueAtom)]);
      }

      try {
        const info = await invoke<StreamInfo>("play_tidal_track", {
          trackId: prevTrack.id,
          useTrackGain: store.get(useTrackGainAtom),
        });
        store.set(streamInfoAtom, info);
        store.set(currentTrackAtom, prevTrack);
        store.set(isPlayingAtom, true);
      } catch (error: any) {
        console.error("Failed to play previous track:", error);
        store.set(isPlayingAtom, false);
        window.dispatchEvent(new CustomEvent("playback-error", { detail: extractPlaybackError(error) }));
      }
    } else if (store.get(currentTrackAtom)) {
      await seekTo(0);
    }
  }, [store, getPlaybackPosition, seekTo]);

  return {
    playTrack,
    pauseTrack,
    resumeTrack,
    setVolume,
    seekTo,
    getPlaybackPosition,
    addToQueue,
    playNextInQueue,
    setQueueTracks,
    removeFromQueue,
    playNext,
    playPrevious,
  };
}
