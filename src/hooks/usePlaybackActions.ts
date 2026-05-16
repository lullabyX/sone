/**
 * usePlaybackActions — stable action callbacks that NEVER cause re-renders.
 *
 * Uses Jotai's store.get()/store.set() directly instead of useAtom(),
 * so calling components do NOT subscribe to any playback atoms.
 *
 * Use this in components that only need to trigger playback actions
 * (play, pause, queue, etc.) but don't need to read playback state.
 */

import { useCallback, useRef } from "react";
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
  manualQueueAtom,
  originalQueueAtom,
  playbackSourceAtom,
  contextSourceAtom,
  shuffleAtom,
  repeatAtom,
  allowExplicitAtom,
  bitPerfectAtom,
  consecutiveFailCountAtom,
} from "../atoms/playback";
import { getMixItems, checkNetworkError } from "../api/tidal";
import { useToast } from "../contexts/ToastContext";
import { stampQid, stampQids, ensureQid } from "../lib/qid";
import { notifySeek, getInterpolatedPosition } from "../lib/playbackPosition";
import { isTrackUnavailable, isUnplayableError } from "../lib/trackAvailability";
import type { Track, StreamInfo, ManualTrackSource, QueuedTrack } from "../types";
import { getTidalImageUrl } from "../types";
import { preloadImage } from "../components/TidalImage";
import { getTrackArtistDisplay } from "../utils/itemHelpers";

type PlayResult =
  | { ok: true }
  | { ok: false; reason: "network" | "unplayable" | "transient" };

const MAX_CONSECUTIVE_PLAY_FAILS = 3;

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
    try {
      parsed = JSON.parse(error);
    } catch {
      return error;
    }
  }
  const msg = parsed?.message;
  return typeof msg === "string" ? msg : "Playback failed";
}

/** Check if an error is a device_busy error from exclusive ALSA mode. */
function isDeviceBusy(error: unknown): boolean {
  return extractPlaybackError(error) === "device_busy";
}

/** Check if an error is a network error (SoneError::Network). */
function isNetworkError(error: unknown): boolean {
  try {
    const parsed = typeof error === "string" ? JSON.parse(error) : error;
    return parsed?.kind === "Network";
  } catch {
    return false;
  }
}

function fisherYatesShuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const DEVICE_RETRY_DELAY = 500;
const DEVICE_MAX_RETRIES = 10;
const MAX_HISTORY_TRACKS = 500;
const PLAY_REENTRY_GUARD_MS = 250;

/** Invoke play_tidal_track with automatic device-busy retry.
 *  When PipeWire holds the ALSA device after pipeline teardown, this retries
 *  with 500ms delays (up to 5s) while keeping the UI responsive. */
async function invokePlayWithRetry(
  trackId: number,
  useTrackGain: boolean,
  onFirstRetry: () => void,
): Promise<StreamInfo> {
  for (let attempt = 0; attempt <= DEVICE_MAX_RETRIES; attempt++) {
    try {
      return await invoke<StreamInfo>("play_tidal_track", {
        trackId,
        useTrackGain,
      });
    } catch (err: unknown) {
      if (isDeviceBusy(err) && attempt < DEVICE_MAX_RETRIES) {
        if (attempt === 0) onFirstRetry();
        await new Promise((r) => setTimeout(r, DEVICE_RETRY_DELAY));
        continue;
      }
      throw err;
    }
  }
  throw new Error("device_busy"); // unreachable
}

export function usePlaybackActions() {
  const store = useStore();
  const { showToast } = useToast();

  const playGenerationRef = useRef(0);
  const autoplayIdsRef = useRef(new Set<number>());
  const playNextLockRef = useRef(false);
  const lastPlayInvokeRef = useRef(0);

  const playTrack = useCallback(
    async (
      track: Track,
      opts?: {
        chosenByUser?: boolean;
        skipHistoryPush?: boolean;
        /** When true, the catch block does NOT toast for unplayable errors —
         *  the caller (the skip-loop in playNext) handles user feedback itself. */
        suppressUnplayableToast?: boolean;
      },
    ): Promise<PlayResult> => {
      // Swallow rapid re-entry (e.g. user double-clicks a track row).
      // Two play_tidal_track calls in quick succession cause overlapping
      // pipeline init and audible glitches.
      const now = Date.now();
      if (now - lastPlayInvokeRef.current < PLAY_REENTRY_GUARD_MS) {
        return { ok: false, reason: "transient" };
      }
      lastPlayInvokeRef.current = now;
      const generation = ++playGenerationRef.current;
      const stamped = ensureQid(normalizeTrack(track));
      preloadImage(getTidalImageUrl(stamped.album?.cover, 640));
      preloadImage(getTidalImageUrl(stamped.album?.cover, 1280));

      // Save state for rollback
      const previousTrack = store.get(currentTrackAtom);
      const previousHistory = store.get(historyAtom);

      // Eagerly update UI so album art / blur transitions start immediately
      if (previousTrack && !opts?.skipHistoryPush) {
        const nextHistory = [...previousHistory, previousTrack];
        store.set(
          historyAtom,
          nextHistory.length > MAX_HISTORY_TRACKS
            ? nextHistory.slice(nextHistory.length - MAX_HISTORY_TRACKS)
            : nextHistory,
        );
      }
      // Store source context on track for history-based prev navigation
      (stamped as any)._playingFrom = store.get(playbackSourceAtom);
      (stamped as any)._contextFrom = store.get(contextSourceAtom);
      store.set(currentTrackAtom, stamped);

      try {
        const info = await invokePlayWithRetry(
          stamped.id,
          store.get(useTrackGainAtom),
          () => {
            store.set(isPlayingAtom, false);
            showToast("Preparing exclusive audio…", "info");
          },
        );

        if (generation !== playGenerationRef.current) {
          return { ok: false, reason: "transient" };
        }
        store.set(streamInfoAtom, info);
        store.set(isPlayingAtom, true);
        store.set(consecutiveFailCountAtom, 0);

        // Notify backend for scrobbling
        invoke("notify_track_started", {
          payload: {
            artist: getTrackArtistDisplay(stamped),
            title: stamped.title,
            album: stamped.album?.title || null,
            albumArtist: null,
            durationSecs: stamped.duration || 0,
            trackNumber: stamped.trackNumber || null,
            chosenByUser: opts?.chosenByUser ?? true,
            isrc: stamped.isrc || null,
            trackId: stamped.id || null,
          },
        }).catch(() => {});
        return { ok: true };
      } catch (error: any) {
        if (generation !== playGenerationRef.current) {
          return { ok: false, reason: "transient" };
        }
        // Rollback eager UI updates
        store.set(currentTrackAtom, previousTrack);
        store.set(historyAtom, previousHistory);
        console.error("Failed to play track:", error);
        store.set(isPlayingAtom, false);
        if (isNetworkError(error)) {
          checkNetworkError(error);
          return { ok: false, reason: "network" };
        }
        if (isUnplayableError(error)) {
          if (!opts?.suppressUnplayableToast) {
            showToast("Track unavailable", "info");
          }
          return { ok: false, reason: "unplayable" };
        }
        window.dispatchEvent(
          new CustomEvent("playback-error", {
            detail: extractPlaybackError(error),
          }),
        );
        return { ok: false, reason: "transient" };
      }
    },
    [store, showToast],
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
        const info = await invokePlayWithRetry(
          track.id,
          store.get(useTrackGainAtom),
          () => {
            store.set(isPlayingAtom, false);
            showToast("Preparing exclusive audio…", "info");
          },
        );
        store.set(streamInfoAtom, info);

        // Notify backend so the replay is scrobbled
        invoke("notify_track_started", {
          payload: {
            artist: getTrackArtistDisplay(track),
            title: track.title,
            album: track.album?.title || null,
            albumArtist: null,
            durationSecs: track.duration || 0,
            trackNumber: track.trackNumber || null,
            chosenByUser: true,
            isrc: track.isrc || null,
            trackId: track.id || null,
          },
        }).catch(() => {});
      } else {
        await invoke("resume_track");
      }
      store.set(isPlayingAtom, true);
    } catch (error) {
      console.error("Failed to resume track:", error);
      store.set(isPlayingAtom, false);
      if (isNetworkError(error)) {
        checkNetworkError(error);
      } else if (isUnplayableError(error)) {
        showToast("Track unavailable", "info");
      } else {
        window.dispatchEvent(
          new CustomEvent("playback-error", {
            detail: extractPlaybackError(error),
          }),
        );
      }
    }
  }, [store, showToast]);

  const setVolume = useCallback(
    async (level: number) => {
      if (store.get(bitPerfectAtom)) return;
      store.set(volumeAtom, level);
      try {
        await invoke("set_volume", { level });
      } catch (error) {
        console.error("Failed to set volume:", error);
      }
    },
    [store],
  );

  const seekTo = useCallback(async (positionSecs: number) => {
    try {
      await invoke("seek_track", { positionSecs });
      notifySeek(positionSecs);
    } catch (error) {
      console.error("Failed to seek:", error);
    }
  }, []);

  const addToQueue = useCallback(
    (track: Track, source?: ManualTrackSource) => {
      if (!store.get(allowExplicitAtom) && track.explicit) return;
      const stamped = stampQid(normalizeTrack(track));
      if (source) (stamped as QueuedTrack)._source = source;
      store.set(manualQueueAtom, [...store.get(manualQueueAtom), stamped]);
    },
    [store],
  );

  const playNextInQueue = useCallback(
    (track: Track, source?: ManualTrackSource) => {
      if (!store.get(allowExplicitAtom) && track.explicit) return;
      const stamped = stampQid(normalizeTrack(track));
      if (source) (stamped as QueuedTrack)._source = source;
      store.set(manualQueueAtom, [stamped, ...store.get(manualQueueAtom)]);
    },
    [store],
  );

  const setQueueTracks = useCallback(
    (
      tracks: Track[],
      options?: {
        albumMode?: boolean;
        reorder?: boolean;
        manualCount?: number;
        source?: {
          type: string;
          id: string | number;
          name: string;
          image?: string;
          subtitle?: string;
          mixType?: string;
          allTracks: Track[];
        };
      },
    ) => {
      if (options?.reorder) {
        // Drag-and-drop reorder: preserve existing _qids, split back into manual/context
        const mc = options.manualCount ?? 0;
        const stamped = tracks.map((t) => ensureQid(normalizeTrack(t)));
        store.set(manualQueueAtom, stamped.slice(0, mc));
        store.set(queueAtom, stamped.slice(mc));
        return;
      }
      const filterExplicit = !store.get(allowExplicitAtom);
      const eligible = filterExplicit ? tracks.filter(t => !t.explicit) : tracks;
      store.set(useTrackGainAtom, !options?.albumMode);
      store.set(originalQueueAtom, null);
      store.set(manualQueueAtom, []);
      store.set(contextSourceAtom, null);
      store.set(
        playbackSourceAtom,
        options?.source
          ? {
              type: options.source.type,
              id: options.source.id,
              name: options.source.name,
              image: options.source.image,
              subtitle: options.source.subtitle,
              mixType: options.source.mixType,
              tracks: stampQids(options.source.allTracks.map(normalizeTrack)),
            }
          : null,
      );
      store.set(queueAtom, stampQids(eligible.map(normalizeTrack)));
    },
    [store],
  );

  const appendToQueue = useCallback(
    (newTracks: Track[]) => {
      const filterExplicit = !store.get(allowExplicitAtom);
      const eligible = filterExplicit ? newTracks.filter(t => !t.explicit) : newTracks;
      if (eligible.length === 0) return;
      const stamped = stampQids(eligible.map(normalizeTrack));

      // Append to playbackSourceAtom.tracks
      const source = store.get(playbackSourceAtom);
      if (source) {
        store.set(playbackSourceAtom, {
          ...source,
          tracks: [...source.tracks, ...stamped],
        });
      }

      if (store.get(shuffleAtom)) {
        // Append to originalQueueAtom in order
        const orig = store.get(originalQueueAtom);
        if (orig) {
          store.set(originalQueueAtom, [...orig, ...stamped]);
        }
        // Insert into queueAtom at random positions
        const queue = [...store.get(queueAtom)];
        for (const track of stamped) {
          const idx = Math.floor(Math.random() * (queue.length + 1));
          queue.splice(idx, 0, track);
        }
        store.set(queueAtom, queue);
      } else {
        // Append to end of queueAtom
        store.set(queueAtom, [...store.get(queueAtom), ...stamped]);
      }
    },
    [store],
  );

  const removeFromQueue = useCallback(
    (index: number) => {
      const manual = store.get(manualQueueAtom);
      if (index < manual.length) {
        // Remove from manual queue
        store.set(
          manualQueueAtom,
          manual.filter((_, i) => i !== index),
        );
      } else {
        // Remove from context queue (adjust index)
        const ctxIndex = index - manual.length;
        const queue = store.get(queueAtom);
        const removed = queue[ctxIndex];
        store.set(
          queueAtom,
          queue.filter((_, i) => i !== ctxIndex),
        );
        // Sync originalQueueAtom for context tracks
        if (removed) {
          const orig = store.get(originalQueueAtom);
          if (orig) {
            store.set(
              originalQueueAtom,
              orig.filter((t) => t._qid !== removed._qid),
            );
          }
        }
      }
    },
    [store],
  );

  const playNext = useCallback(
    async (options?: { explicit?: boolean }) => {
      if (playNextLockRef.current) return;
      playNextLockRef.current = true;
      try {
        const repeatMode = store.get(repeatAtom);

      // Repeat-one: replay current track unless explicit skip
      if (repeatMode === 2 && !options?.explicit) {
        const current = store.get(currentTrackAtom);
        if (current) {
          try {
            const info = await invokePlayWithRetry(
              current.id,
              store.get(useTrackGainAtom),
              () => {
                store.set(isPlayingAtom, false);
                showToast("Preparing exclusive audio…", "info");
              },
            );
            store.set(streamInfoAtom, info);
            store.set(isPlayingAtom, true);
            invoke("notify_track_started", {
              payload: {
                artist: getTrackArtistDisplay(current),
                title: current.title,
                album: current.album?.title || null,
                albumArtist: null,
                durationSecs: current.duration || 0,
                trackNumber: current.trackNumber || null,
                chosenByUser: false,
                isrc: current.isrc || null,
                trackId: current.id || null,
              },
            }).catch(() => {});
          } catch (error: any) {
            console.error("Failed to repeat track:", error);
            store.set(isPlayingAtom, false);
            if (isNetworkError(error)) {
              checkNetworkError(error);
            } else if (isUnplayableError(error)) {
              showToast("Track unavailable", "info");
            }
          }
          return;
        }
      }

      // Stop old pipeline to prevent stale track-finished events
      await invoke("stop_track").catch(() => {});

      // Skip-loop helpers (issue #71). Counter resets on explicit user skip
      // so mashing Next across removed tracks never trips the cap.
      if (options?.explicit) {
        store.set(consecutiveFailCountAtom, 0);
      }
      let toastedSkipThisCall = false;
      const recordUnplayableAndCheckCap = (): boolean => {
        const next = store.get(consecutiveFailCountAtom) + 1;
        store.set(consecutiveFailCountAtom, next);
        if (next >= MAX_CONSECUTIVE_PLAY_FAILS) {
          showToast("Multiple tracks failed to play — stopped", "error");
          store.set(consecutiveFailCountAtom, 0);
          store.set(isPlayingAtom, false);
          return true;
        }
        if (!toastedSkipThisCall) {
          showToast("Track unavailable — skipping", "info");
          toastedSkipThisCall = true;
        }
        return false;
      };

      // Drain manual queue first (skip past unavailable tracks)
      while (store.get(manualQueueAtom).length > 0) {
        const manualNow = store.get(manualQueueAtom);
        const [nextTrack, ...rest] = manualNow;

        // Pre-check: skip via metadata flags, no backend round-trip.
        if (isTrackUnavailable(nextTrack)) {
          store.set(manualQueueAtom, rest);
          if (recordUnplayableAndCheckCap()) return;
          continue;
        }

        store.set(manualQueueAtom, rest);

        // Update playbackSourceAtom if this manual track has a source tag
        const manualSource = (nextTrack as QueuedTrack)._source;
        const prevPlaybackSource = store.get(playbackSourceAtom);
        const prevContextSource = store.get(contextSourceAtom);
        if (manualSource) {
          if (!prevContextSource) {
            store.set(contextSourceAtom, prevPlaybackSource);
          }
          store.set(playbackSourceAtom, {
            type: manualSource.type,
            id: manualSource.id,
            name: manualSource.name,
            image: manualSource.image,
            subtitle: manualSource.subtitle,
            mixType: manualSource.mixType,
            tracks: [],
          });
        }

        // Reset re-entry guard so the loop can call playTrack tightly.
        lastPlayInvokeRef.current = 0;
        const result = await playTrack(nextTrack, {
          chosenByUser: !!options?.explicit,
          suppressUnplayableToast: true,
        });
        if (result.ok) return;

        if (result.reason === "unplayable") {
          // Track never played — roll back the speculative source mutation.
          if (manualSource) {
            store.set(playbackSourceAtom, prevPlaybackSource);
            store.set(contextSourceAtom, prevContextSource);
          }
          if (recordUnplayableAndCheckCap()) return;
          continue;
        }
        // Network or transient: preserve current behavior — re-insert and bail.
        if (manualSource) {
          store.set(playbackSourceAtom, prevPlaybackSource);
          store.set(contextSourceAtom, prevContextSource);
        }
        store.set(manualQueueAtom, [nextTrack, ...store.get(manualQueueAtom)]);
        return;
      }

      // Restore context source when manual queue is exhausted
      const stashedSource = store.get(contextSourceAtom);
      if (stashedSource) {
        store.set(playbackSourceAtom, stashedSource);
        store.set(contextSourceAtom, null);
      }

      // Drain context queue (skip past unavailable tracks)
      while (store.get(queueAtom).length > 0) {
        const queueNow = store.get(queueAtom);
        const [nextTrack, ...rest] = queueNow;
        const isAutoplay = autoplayIdsRef.current.has(nextTrack.id);

        // Pre-check: also filter originalQueueAtom so the skipped track
        // doesn't reappear when shuffle is toggled off.
        if (isTrackUnavailable(nextTrack)) {
          autoplayIdsRef.current.delete(nextTrack.id);
          store.set(queueAtom, rest);
          const origPre = store.get(originalQueueAtom);
          if (origPre) {
            store.set(
              originalQueueAtom,
              origPre.filter((t) => t._qid !== nextTrack._qid),
            );
          }
          if (recordUnplayableAndCheckCap()) return;
          continue;
        }

        autoplayIdsRef.current.delete(nextTrack.id);
        store.set(queueAtom, rest);
        const orig = store.get(originalQueueAtom);
        if (orig) {
          store.set(
            originalQueueAtom,
            orig.filter((t) => t._qid !== nextTrack._qid),
          );
        }

        lastPlayInvokeRef.current = 0;
        const result = await playTrack(nextTrack, {
          chosenByUser: !isAutoplay,
          suppressUnplayableToast: true,
        });
        if (result.ok) return;

        if (result.reason === "unplayable") {
          // Already filtered from both queues above. Keep advancing.
          if (recordUnplayableAndCheckCap()) return;
          continue;
        }
        // Network or transient: re-insert and bail.
        store.set(queueAtom, [nextTrack, ...store.get(queueAtom)]);
        if (orig) {
          store.set(originalQueueAtom, orig);
        }
        return;
      }

      if (repeatMode === 1) {
        // Repeat-all: rebuild from source (Bug 2) or history+current fallback
        const repeatSource = store.get(contextSourceAtom) ?? store.get(playbackSourceAtom);
        const sourceTracks = repeatSource?.tracks;
        const explicitOk = store.get(allowExplicitAtom);
        const raw =
          sourceTracks && sourceTracks.length > 0
            ? sourceTracks
            : [
                ...store.get(historyAtom),
                ...(store.get(currentTrackAtom)
                  ? [store.get(currentTrackAtom)!]
                  : []),
              ];
        // Pre-filter unavailable so the rebuilt queue doesn't immediately hit them.
        const all = stampQids(
          (explicitOk ? raw : raw.filter(t => !t.explicit)).filter(t => !isTrackUnavailable(t)),
        );

        if (all.length > 0) {
          store.set(historyAtom, []);
          const ordered = store.get(shuffleAtom)
            ? fisherYatesShuffle(all)
            : all;
          const [first, ...rest] = ordered;
          store.set(queueAtom, rest);
          // Bug 6 fix: preserve originalQueueAtom when shuffle is on (exclude currently playing track)
          store.set(
            originalQueueAtom,
            store.get(shuffleAtom)
              ? all.filter((t) => t._qid !== first._qid)
              : null,
          );
          const result = await playTrack(first, { skipHistoryPush: true });
          if (!result.ok && result.reason === "unplayable") {
            // First track lied about its metadata. Release the lock and re-enter
            // playNext so the context-queue skip-loop handles the rest.
            playNextLockRef.current = false;
            await playNext();
            return;
          }
        } else {
          store.set(isPlayingAtom, false);
        }
      } else if (store.get(autoplayAtom)) {
        const current = store.get(currentTrackAtom);
        if (current) {
          try {
            const historyIds = new Set(store.get(historyAtom).map((t) => t.id));
            historyIds.add(current.id);
            const trackMixId = current.mixes?.TRACK_MIX;
            if (!trackMixId) return;
            const { tracks: radio } = await getMixItems(trackMixId);
            const explicitOk = store.get(allowExplicitAtom);
            const fresh = radio.filter(
              (t) =>
                !historyIds.has(t.id) &&
                (explicitOk || !t.explicit) &&
                !isTrackUnavailable(t),
            );
            if (fresh.length > 0) {
              const [next, ...rest] = fresh;
              autoplayIdsRef.current = new Set(rest.map((t) => t.id));
              store.set(queueAtom, stampQids(rest.map(normalizeTrack)));
              store.set(useTrackGainAtom, true); // radio = mixed context
              const result = await playTrack(next, { chosenByUser: false });
              if (!result.ok && result.reason === "unplayable") {
                playNextLockRef.current = false;
                await playNext();
                return;
              }
              return;
            }
          } catch (error: unknown) {
            if (isNetworkError(error)) {
              checkNetworkError(error);
            }
            /* fall through to stop */
          }
        }
        store.set(isPlayingAtom, false);
      } else {
        store.set(isPlayingAtom, false);
      }
      } finally {
        playNextLockRef.current = false;
      }
    },
    [store, playTrack],
  );

  const playPrevious = useCallback(async () => {
    if (playNextLockRef.current) return;
    playNextLockRef.current = true;
    try {
      const pos = getInterpolatedPosition();
      if (pos > 3) {
        await seekTo(0);
        return;
      }

      // Explicit user action — clear the skip-loop counter.
      store.set(consecutiveFailCountAtom, 0);

    // Stop old pipeline to prevent stale track-finished events
    await invoke("stop_track").catch(() => {});

    const history = store.get(historyAtom);
    if (history.length > 0) {
      const newHistory = [...history];
      const prevTrack = newHistory.pop()!;

      // Save full state snapshot for rollback
      const savedCurrentTrack = store.get(currentTrackAtom);
      const savedQueue = store.get(queueAtom);
      const savedOriginalQueue = store.get(originalQueueAtom);
      const savedManualQueue = store.get(manualQueueAtom);
      const savedPlaybackSource = store.get(playbackSourceAtom);
      const savedContextSource = store.get(contextSourceAtom);

      // Eagerly update all state (including UI)
      store.set(historyAtom, newHistory);
      if (savedCurrentTrack) {
        // Always push to manual queue with source tag so forward navigation
        // restores the correct "Playing from" via playNext's _source handling
        const src = savedPlaybackSource;
        const sourceTag = src ? {
          type: src.type,
          id: src.id,
          name: src.name,
          image: src.image,
          subtitle: src.subtitle,
          mixType: src.mixType,
        } : undefined;
        const tagged = sourceTag
          ? { ...savedCurrentTrack, _source: sourceTag }
          : savedCurrentTrack;
        store.set(manualQueueAtom, [tagged, ...savedManualQueue]);
      }

      // Restore source from history entry for correct "Playing from" display
      const prevPlayingFrom = (prevTrack as any)._playingFrom;
      if (prevPlayingFrom !== undefined) {
        store.set(playbackSourceAtom, prevPlayingFrom);
        store.set(contextSourceAtom, (prevTrack as any)._contextFrom ?? null);
      }

      // Stamp source context on prevTrack for future history entries
      (prevTrack as any)._playingFrom = store.get(playbackSourceAtom);
      (prevTrack as any)._contextFrom = store.get(contextSourceAtom);
      store.set(currentTrackAtom, prevTrack);

      try {
        preloadImage(getTidalImageUrl(prevTrack.album?.cover, 640));
        preloadImage(getTidalImageUrl(prevTrack.album?.cover, 1280));
        const info = await invokePlayWithRetry(
          prevTrack.id,
          store.get(useTrackGainAtom),
          () => {
            store.set(isPlayingAtom, false);
            showToast("Preparing exclusive audio…", "info");
          },
        );
        store.set(streamInfoAtom, info);
        store.set(isPlayingAtom, true);

        // Notify backend for scrobbling
        invoke("notify_track_started", {
          payload: {
            artist: getTrackArtistDisplay(prevTrack),
            title: prevTrack.title,
            album: prevTrack.album?.title || null,
            albumArtist: null,
            durationSecs: prevTrack.duration || 0,
            trackNumber: prevTrack.trackNumber || null,
            chosenByUser: true,
            isrc: prevTrack.isrc || null,
            trackId: prevTrack.id || null,
          },
        }).catch(() => {});
      } catch (error: any) {
        // Rollback all state
        store.set(currentTrackAtom, savedCurrentTrack);
        store.set(historyAtom, history);
        store.set(queueAtom, savedQueue);
        store.set(originalQueueAtom, savedOriginalQueue);
        store.set(manualQueueAtom, savedManualQueue);
        store.set(playbackSourceAtom, savedPlaybackSource);
        store.set(contextSourceAtom, savedContextSource);
        console.error("Failed to play previous track:", error);
        store.set(isPlayingAtom, false);
        if (isNetworkError(error)) {
          checkNetworkError(error);
        } else if (isUnplayableError(error)) {
          showToast("Track unavailable", "info");
        } else {
          window.dispatchEvent(
            new CustomEvent("playback-error", {
              detail: extractPlaybackError(error),
            }),
          );
        }
      }
    } else {
      // Bug 1 fix: try source fallback when history is empty
      const source = store.get(playbackSourceAtom);
      const current = store.get(currentTrackAtom);
      if (source && current) {
        const idx = source.tracks.findIndex((t) => t.id === current.id);
        if (idx > 0) {
          const prevTrack = stampQid(source.tracks[idx - 1]);

          // Save state for rollback
          const savedQueue = store.get(queueAtom);
          const savedOriginalQueue = store.get(originalQueueAtom);
          const savedManualQueue = store.get(manualQueueAtom);

          // Push current back onto queue
          if (savedManualQueue.length > 0) {
            // Push to front of manual queue with source tag
            const src = store.get(playbackSourceAtom);
            const sourceTag = src ? {
              type: src.type,
              id: src.id,
              name: src.name,
              image: src.image,
              subtitle: src.subtitle,
              mixType: src.mixType,
            } : undefined;
            const tagged = sourceTag
              ? { ...current, _source: sourceTag }
              : current;
            store.set(manualQueueAtom, [tagged, ...savedManualQueue]);
          } else {
            store.set(queueAtom, [current, ...savedQueue]);
            // Bug G fix: insert at correct position in originalQueueAtom
            if (savedOriginalQueue) {
              const sourceIdx = source.tracks.findIndex(
                (t) => t.id === current.id,
              );
              if (sourceIdx >= 0) {
                const insertIdx = savedOriginalQueue.findIndex((t) => {
                  const tIdx = source.tracks.findIndex((s) => s.id === t.id);
                  return tIdx > sourceIdx;
                });
                const newOrig = [...savedOriginalQueue];
                newOrig.splice(
                  insertIdx === -1 ? savedOriginalQueue.length : insertIdx,
                  0,
                  current,
                );
                store.set(originalQueueAtom, newOrig);
              } else {
                store.set(originalQueueAtom, [current, ...savedOriginalQueue]);
              }
            }
          }

          // Eagerly update UI
          store.set(currentTrackAtom, prevTrack);

          try {
            const info = await invokePlayWithRetry(
              prevTrack.id,
              store.get(useTrackGainAtom),
              () => {
                store.set(isPlayingAtom, false);
                showToast("Preparing exclusive audio…", "info");
              },
            );
            store.set(streamInfoAtom, info);
            store.set(isPlayingAtom, true);

            // Notify backend for scrobbling
            invoke("notify_track_started", {
              payload: {
                artist: getTrackArtistDisplay(prevTrack),
                title: prevTrack.title,
                album: prevTrack.album?.title || null,
                albumArtist: null,
                durationSecs: prevTrack.duration || 0,
                trackNumber: prevTrack.trackNumber || null,
                chosenByUser: true,
                isrc: prevTrack.isrc || null,
                trackId: prevTrack.id || null,
              },
            }).catch(() => {});
          } catch (error: any) {
            // Rollback all state
            store.set(currentTrackAtom, current);
            store.set(queueAtom, savedQueue);
            store.set(originalQueueAtom, savedOriginalQueue);
            store.set(manualQueueAtom, savedManualQueue);
            console.error("Failed to play previous track:", error);
            store.set(isPlayingAtom, false);
            if (isNetworkError(error)) {
              checkNetworkError(error);
            } else if (isUnplayableError(error)) {
              showToast("Track unavailable", "info");
            } else {
              window.dispatchEvent(
                new CustomEvent("playback-error", {
                  detail: extractPlaybackError(error),
                }),
              );
            }
          }
        } else if (current) {
          await seekTo(0);
        }
      } else if (current) {
        await seekTo(0);
      }
    }
    } finally {
      playNextLockRef.current = false;
    }
  }, [store, showToast, seekTo]);

  const toggleShuffle = useCallback(() => {
    const current = store.get(shuffleAtom);
    if (!current) {
      // Turning ON: save current queue as original, then shuffle
      const queue = store.get(queueAtom);
      store.set(originalQueueAtom, queue);
      store.set(queueAtom, fisherYatesShuffle(queue));
      store.set(shuffleAtom, true);
    } else {
      // Turning OFF: restore original order (only tracks still in queue)
      const orig = store.get(originalQueueAtom);
      if (orig) {
        // Bug 7b fix: use _qid instead of .id for duplicate support
        const currentQids = new Set(store.get(queueAtom).map((t) => t._qid));
        store.set(
          queueAtom,
          orig.filter((t) => currentQids.has(t._qid)),
        );
      }
      store.set(originalQueueAtom, null);
      store.set(shuffleAtom, false);
    }
  }, [store]);

  const setShuffledQueue = useCallback(
    (
      tracks: Track[],
      options?: {
        source?: {
          type: string;
          id: string | number;
          name: string;
          image?: string;
          subtitle?: string;
          mixType?: string;
          allTracks: Track[];
        };
        albumMode?: boolean;
      },
    ) => {
      const filterExplicit = !store.get(allowExplicitAtom);
      const eligible = filterExplicit ? tracks.filter(t => !t.explicit) : tracks;
      const stamped = stampQids(eligible.map(normalizeTrack));
      store.set(manualQueueAtom, []);
      store.set(contextSourceAtom, null);
      store.set(originalQueueAtom, stamped);
      store.set(queueAtom, fisherYatesShuffle(stamped));
      store.set(useTrackGainAtom, !options?.albumMode);
      store.set(shuffleAtom, true);
      store.set(
        playbackSourceAtom,
        options?.source
          ? {
              type: options.source.type,
              id: options.source.id,
              name: options.source.name,
              image: options.source.image,
              subtitle: options.source.subtitle,
              mixType: options.source.mixType,
              tracks: stampQids(options.source.allTracks.map(normalizeTrack)),
            }
          : null,
      );
    },
    [store],
  );

  const playFromQueue = useCallback(
    async (index: number) => {
      const manual = store.get(manualQueueAtom);
      const queue = store.get(queueAtom);
      if (index < 0 || index >= manual.length + queue.length) return;

      let track: Track;
      if (index < manual.length) {
        track = manual[index];
      } else {
        track = queue[index - manual.length];
      }
      if (isTrackUnavailable(track)) {
        showToast("Track unavailable", "info");
        return;
      }
      // Explicit user action — clear the skip-loop counter.
      store.set(consecutiveFailCountAtom, 0);
      if (index < manual.length) {
        store.set(
          manualQueueAtom,
          manual.filter((_, i) => i !== index),
        );
      } else {
        const ctxIndex = index - manual.length;
        store.set(
          queueAtom,
          queue.filter((_, i) => i !== ctxIndex),
        );
        const orig = store.get(originalQueueAtom);
        if (orig) {
          store.set(
            originalQueueAtom,
            orig.filter((t) => t._qid !== track._qid),
          );
        }
      }
      await playTrack(track);
    },
    [store, playTrack, showToast],
  );

  const playFromSource = useCallback(
    async (
      track: Track,
      allTracks: Track[],
      options?: {
        source?: {
          type: string;
          id: string | number;
          name: string;
          image?: string;
          subtitle?: string;
          mixType?: string;
          allTracks: Track[];
        };
        albumMode?: boolean;
      },
    ) => {
      const filterExplicit = !store.get(allowExplicitAtom);
      const eligible = filterExplicit ? allTracks.filter(t => !t.explicit) : allTracks;
      const idx = eligible.findIndex((t) => t.id === track.id);
      const rest =
        idx >= 0
          ? [...eligible.slice(idx + 1), ...eligible.slice(0, idx)]
          : eligible.filter((t) => t.id !== track.id);
      if (store.get(shuffleAtom)) {
        setShuffledQueue(rest, options);
      } else {
        setQueueTracks(rest, options);
      }
      store.set(consecutiveFailCountAtom, 0);
      const result = await playTrack(track);
      if (!result.ok && result.reason === "unplayable") {
        // First track was unavailable. Engage skip-loop on rest.
        await playNext({ explicit: true });
      }
    },
    [store, playTrack, setQueueTracks, setShuffledQueue, playNext],
  );

  const playAllFromSource = useCallback(
    async (
      allTracks: Track[],
      options?: {
        source?: {
          type: string;
          id: string | number;
          name: string;
          image?: string;
          subtitle?: string;
          mixType?: string;
          allTracks: Track[];
        };
        albumMode?: boolean;
      },
    ) => {
      const filterExplicit = !store.get(allowExplicitAtom);
      const eligible = filterExplicit ? allTracks.filter(t => !t.explicit) : allTracks;
      if (eligible.length === 0) return;
      store.set(consecutiveFailCountAtom, 0);
      let first: Track;
      if (store.get(shuffleAtom)) {
        const firstIdx = Math.floor(Math.random() * eligible.length);
        first = eligible[firstIdx];
        const rest = eligible.filter((_, i) => i !== firstIdx);
        setShuffledQueue(rest, options);
      } else {
        const [head, ...rest] = eligible;
        first = head;
        setQueueTracks(rest, options);
      }
      const result = await playTrack(first);
      if (!result.ok && result.reason === "unplayable") {
        await playNext({ explicit: true });
      }
    },
    [store, playTrack, setQueueTracks, setShuffledQueue, playNext],
  );

  const clearQueue = useCallback(() => {
    store.set(queueAtom, []);
    store.set(manualQueueAtom, []);
    store.set(originalQueueAtom, null);
    store.set(playbackSourceAtom, null);
    store.set(contextSourceAtom, null);
  }, [store]);

  return {
    playTrack,
    pauseTrack,
    resumeTrack,
    setVolume,
    seekTo,
    addToQueue,
    playNextInQueue,
    setQueueTracks,
    appendToQueue,
    removeFromQueue,
    playFromQueue,
    clearQueue,
    playNext,
    playPrevious,
    toggleShuffle,
    setShuffledQueue,
    playFromSource,
    playAllFromSource,
  };
}
