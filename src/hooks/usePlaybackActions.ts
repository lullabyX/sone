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
  shuffleAtom,
  repeatAtom,
} from "../atoms/playback";
import { getTrackRadio, checkNetworkError } from "../api/tidal";
import { useToast } from "../contexts/ToastContext";
import { stampQid, stampQids, ensureQid } from "../lib/qid";
import type { Track, StreamInfo } from "../types";
import { getTidalImageUrl } from "../types";
import { preloadImage } from "../components/TidalImage";

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

  const playTrack = useCallback(
    async (
      track: Track,
      opts?: { chosenByUser?: boolean; skipHistoryPush?: boolean },
    ): Promise<boolean> => {
      const generation = ++playGenerationRef.current;
      const stamped = ensureQid(normalizeTrack(track));
      preloadImage(getTidalImageUrl(stamped.album?.cover, 640));
      preloadImage(getTidalImageUrl(stamped.album?.cover, 1280));

      // Save state for rollback
      const previousTrack = store.get(currentTrackAtom);
      const previousHistory = store.get(historyAtom);

      // Eagerly update UI so album art / blur transitions start immediately
      if (previousTrack && !opts?.skipHistoryPush) {
        store.set(historyAtom, [...previousHistory, previousTrack]);
      }
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

        if (generation !== playGenerationRef.current) return false;
        store.set(streamInfoAtom, info);
        store.set(isPlayingAtom, true);

        // Notify backend for scrobbling
        invoke("notify_track_started", {
          payload: {
            artist: stamped.artist?.name || "Unknown",
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
        return true;
      } catch (error: any) {
        if (generation !== playGenerationRef.current) return false;
        // Rollback eager UI updates
        store.set(currentTrackAtom, previousTrack);
        store.set(historyAtom, previousHistory);
        console.error("Failed to play track:", error);
        store.set(isPlayingAtom, false);
        if (isNetworkError(error)) {
          checkNetworkError(error);
        } else {
          window.dispatchEvent(
            new CustomEvent("playback-error", {
              detail: extractPlaybackError(error),
            }),
          );
        }
        return false;
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
            artist: track.artist?.name || "Unknown",
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
      store.set(volumeAtom, level);
      try {
        await invoke("set_volume", { level });
      } catch (error) {
        console.error("Failed to set volume:", error);
      }
    },
    [store],
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
      const stamped = stampQid(normalizeTrack(track));
      store.set(manualQueueAtom, [...store.get(manualQueueAtom), stamped]);
    },
    [store],
  );

  const playNextInQueue = useCallback(
    (track: Track) => {
      const stamped = stampQid(normalizeTrack(track));
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
      store.set(useTrackGainAtom, !options?.albumMode);
      store.set(originalQueueAtom, null);
      store.set(manualQueueAtom, []);
      store.set(
        playbackSourceAtom,
        options?.source
          ? {
              type: options.source.type,
              id: options.source.id,
              name: options.source.name,
              tracks: stampQids(options.source.allTracks.map(normalizeTrack)),
            }
          : null,
      );
      store.set(queueAtom, stampQids(tracks.map(normalizeTrack)));
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
                artist: current.artist?.name || "Unknown",
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
            }
          }
          return;
        }
      }

      // Stop old pipeline to prevent stale track-finished events
      await invoke("stop_track").catch(() => {});

      // Drain manual queue first
      const manual = store.get(manualQueueAtom);
      if (manual.length > 0) {
        const [nextTrack, ...rest] = manual;
        store.set(manualQueueAtom, rest);
        const ok = await playTrack(nextTrack, { chosenByUser: !!options?.explicit });
        if (!ok) {
          store.set(manualQueueAtom, [nextTrack, ...store.get(manualQueueAtom)]);
        }
        return;
      }

      const queue = store.get(queueAtom);
      if (queue.length > 0) {
        const [nextTrack, ...rest] = queue;
        const isAutoplay = autoplayIdsRef.current.has(nextTrack.id);
        autoplayIdsRef.current.delete(nextTrack.id);
        store.set(queueAtom, rest);
        // Bug F fix: sync originalQueueAtom when consuming context track
        const orig = store.get(originalQueueAtom);
        if (orig) {
          store.set(
            originalQueueAtom,
            orig.filter((t) => t._qid !== nextTrack._qid),
          );
        }
        const ok = await playTrack(nextTrack, { chosenByUser: !isAutoplay });
        if (!ok) {
          store.set(queueAtom, [nextTrack, ...store.get(queueAtom)]);
          if (orig) {
            store.set(originalQueueAtom, orig);
          }
        }
      } else if (repeatMode === 1) {
        // Repeat-all: rebuild from source (Bug 2) or history+current fallback
        const source = store.get(playbackSourceAtom);
        const sourceTracks = source?.tracks;
        const all =
          sourceTracks && sourceTracks.length > 0
            ? stampQids(sourceTracks)
            : stampQids([
                ...store.get(historyAtom),
                ...(store.get(currentTrackAtom)
                  ? [store.get(currentTrackAtom)!]
                  : []),
              ]);

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
          await playTrack(first, { skipHistoryPush: true });
        } else {
          store.set(isPlayingAtom, false);
        }
      } else if (store.get(autoplayAtom)) {
        const current = store.get(currentTrackAtom);
        if (current) {
          try {
            const historyIds = new Set(store.get(historyAtom).map((t) => t.id));
            historyIds.add(current.id);
            const radio = await getTrackRadio(current.id, 30);
            const fresh = radio.filter((t) => !historyIds.has(t.id));
            if (fresh.length > 0) {
              const [next, ...rest] = fresh;
              autoplayIdsRef.current = new Set(rest.map((t) => t.id));
              store.set(queueAtom, stampQids(rest.map(normalizeTrack)));
              store.set(useTrackGainAtom, true); // radio = mixed context
              await playTrack(next, { chosenByUser: false });
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
    try {
      const pos = await getPlaybackPosition();
      if (pos > 3) {
        await seekTo(0);
        return;
      }
    } catch {
      // ignore position errors
    }

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

      // Eagerly update all state (including UI)
      store.set(historyAtom, newHistory);
      if (savedCurrentTrack) {
        store.set(queueAtom, [savedCurrentTrack, ...savedQueue]);
        // Bug G fix: insert at correct position in originalQueueAtom
        if (savedOriginalQueue) {
          const source = store.get(playbackSourceAtom);
          if (source) {
            const sourceIdx = source.tracks.findIndex(
              (t) => t.id === savedCurrentTrack.id,
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
                savedCurrentTrack,
              );
              store.set(originalQueueAtom, newOrig);
            } else {
              store.set(originalQueueAtom, [savedCurrentTrack, ...savedOriginalQueue]);
            }
          } else {
            store.set(originalQueueAtom, [savedCurrentTrack, ...savedOriginalQueue]);
          }
        }
      }
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
            artist: prevTrack.artist?.name || "Unknown",
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
        console.error("Failed to play previous track:", error);
        store.set(isPlayingAtom, false);
        if (isNetworkError(error)) {
          checkNetworkError(error);
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

          // Push current back onto queue
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
                artist: prevTrack.artist?.name || "Unknown",
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
            console.error("Failed to play previous track:", error);
            store.set(isPlayingAtom, false);
            if (isNetworkError(error)) {
              checkNetworkError(error);
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
  }, [store, showToast, getPlaybackPosition, seekTo]);

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
          allTracks: Track[];
        };
        albumMode?: boolean;
      },
    ) => {
      const stamped = stampQids(tracks.map(normalizeTrack));
      store.set(manualQueueAtom, []);
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
        // Playing from manual queue
        track = manual[index];
        store.set(
          manualQueueAtom,
          manual.filter((_, i) => i !== index),
        );
      } else {
        // Playing from context queue
        const ctxIndex = index - manual.length;
        track = queue[ctxIndex];
        store.set(
          queueAtom,
          queue.filter((_, i) => i !== ctxIndex),
        );
        // Sync originalQueueAtom for context tracks
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
    [store, playTrack],
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
          allTracks: Track[];
        };
        albumMode?: boolean;
      },
    ) => {
      const idx = allTracks.findIndex((t) => t.id === track.id);
      const rest =
        idx >= 0
          ? [...allTracks.slice(idx + 1), ...allTracks.slice(0, idx)]
          : allTracks.filter((t) => t.id !== track.id);
      if (store.get(shuffleAtom)) {
        setShuffledQueue(rest, options);
      } else {
        setQueueTracks(rest, options);
      }
      await playTrack(track);
    },
    [store, playTrack, setQueueTracks, setShuffledQueue],
  );

  const playAllFromSource = useCallback(
    async (
      allTracks: Track[],
      options?: {
        source?: {
          type: string;
          id: string | number;
          name: string;
          allTracks: Track[];
        };
        albumMode?: boolean;
      },
    ) => {
      if (allTracks.length === 0) return;
      if (store.get(shuffleAtom)) {
        const firstIdx = Math.floor(Math.random() * allTracks.length);
        const first = allTracks[firstIdx];
        const rest = allTracks.filter((_, i) => i !== firstIdx);
        setShuffledQueue(rest, options);
        await playTrack(first);
      } else {
        const [first, ...rest] = allTracks;
        setQueueTracks(rest, options);
        await playTrack(first);
      }
    },
    [store, playTrack, setQueueTracks, setShuffledQueue],
  );

  const clearQueue = useCallback(() => {
    store.set(queueAtom, []);
    store.set(manualQueueAtom, []);
    store.set(originalQueueAtom, null);
    store.set(playbackSourceAtom, null);
  }, [store]);

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
