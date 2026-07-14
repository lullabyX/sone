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
  volumeNormalizationAtom,
  bitPerfectPreviousStateAtom,
  consecutiveFailCountAtom,
  userPausedAtom,
  playbackTargetAtom,
} from "../atoms/playback";
import {
  currentVideoAtom,
  videoStreamAtom,
  videoPlayingAtom,
  videoExpandedAtom,
} from "../atoms/video";
import { sonosPendingResumeSeekAtom, sonosVolumeAtom } from "../atoms/sonos";
import { getMixItems, checkNetworkError } from "../api/tidal";
import { useToast } from "../contexts/ToastContext";
import { stampQid, stampQids, ensureQid } from "../lib/qid";
import {
  notifySeek,
  getInterpolatedPosition,
  markPlaybackLoading,
} from "../lib/playbackPosition";
import {
  isTrackUnavailable,
  isUnplayableError,
} from "../lib/trackAvailability";
import { pickGaplessNext } from "../lib/gaplessPredict";
import { startVideoSession } from "../lib/videoSession";
import { videoElementRef } from "../lib/videoElement";
import type {
  Track,
  StreamInfo,
  ManualTrackSource,
  QueuedTrack,
} from "../types";
import { getTidalImageUrl } from "../types";
import { preloadImage } from "../components/TidalImage";
import {
  getTrackArtistDisplay,
  getTrackPrimaryArtist,
} from "../utils/itemHelpers";

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

/** Build the notify_track_started payload. Centralized so all call sites send the
 *  same fields — notably both `artist` (combined, for ListenBrainz) and
 *  `artistPrimary` (single primary, for Last.fm/Libre.fm). */
function buildTrackStartedPayload(track: Track, chosenByUser: boolean) {
  return {
    artist: getTrackArtistDisplay(track),
    artistPrimary: getTrackPrimaryArtist(track),
    title: track.title,
    album: track.album?.title || null,
    albumArtist: null,
    durationSecs: track.duration || 0,
    trackNumber: track.trackNumber || null,
    chosenByUser,
    isrc: track.isrc || null,
    trackId: track.id || null,
  };
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

/** Queue-entry display metadata for the Sonos native queue. */
function buildSonosMeta(track: Track) {
  return {
    title: track.title ?? "",
    artist: getTrackArtistDisplay(track),
    album: track.album?.title ?? "",
  };
}

type JotaiStore = ReturnType<typeof useStore>;

/** The single play chokepoint, target-aware. Every play path (playTrack,
 *  repeat-one, resume-replay, playPrevious) flows through here.
 *  - local  → play_tidal_track with device-busy retry, returns StreamInfo
 *  - sonos  → sonos_play_track (the SPEAKER resolves and streams the audio
 *             from TIDAL itself), returns null — there is no local stream. */
async function invokePlayForTarget(
  store: JotaiStore,
  track: Track,
  useTrackGain: boolean,
  onFirstRetry: () => void,
): Promise<StreamInfo | null> {
  if (isRemoteTarget(store)) {
    store.set(sonosPendingResumeSeekAtom, null); // new track voids any deferred seek
    await invoke("sonos_play_track", {
      trackId: track.id,
      meta: buildSonosMeta(track),
      start: true,
    });
    return null;
  }
  return invokePlayWithRetry(track.id, useTrackGain, onFirstRetry);
}

function isRemoteTarget(store: JotaiStore): boolean {
  return store.get(playbackTargetAtom).type === "sonos";
}

// Slider drags fire per pixel; each remote set is a SOAP round-trip to the
// speaker. Leading + trailing throttle: instant response, latest value
// always lands, ≤ ~7 calls/second. Module-level — one speaker, one gate.
const SONOS_VOLUME_THROTTLE_MS = 150;
let sonosVolumeTimer: ReturnType<typeof setTimeout> | null = null;
let sonosVolumePending: number | null = null;
let sonosVolumeSentAt = 0;

function sendSonosVolumeThrottled(volume: number) {
  sonosVolumePending = volume;
  const flush = () => {
    sonosVolumeTimer = null;
    if (sonosVolumePending === null) return;
    const value = sonosVolumePending;
    sonosVolumePending = null;
    sonosVolumeSentAt = Date.now();
    invoke("sonos_set_volume", { volume: value }).catch((error) => {
      console.error("Failed to set Sonos volume:", error);
    });
  };
  if (sonosVolumeTimer) return; // trailing flush already scheduled
  const elapsed = Date.now() - sonosVolumeSentAt;
  if (elapsed >= SONOS_VOLUME_THROTTLE_MS) {
    flush();
  } else {
    sonosVolumeTimer = setTimeout(flush, SONOS_VOLUME_THROTTLE_MS - elapsed);
  }
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
        /** Continuation of an already-scrobbling listen (Sonos↔local
         *  handoff): don't restart the scrobble clock with a new
         *  notify_track_started. */
        skipScrobbleStart?: boolean;
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
      // VIDEO queue item → render in the <video> player; keep it in the queue so
      // prev/next/history work uniformly. Do NOT touch the audio pipeline beyond stop.
      if (track.itemType === "video") {
        store.set(userPausedAtom, false);
        const v = ensureQid(normalizeTrack(track));
        const previousTrack = store.get(currentTrackAtom);
        if (previousTrack && !opts?.skipHistoryPush) {
          const h = [...store.get(historyAtom), previousTrack];
          store.set(
            historyAtom,
            h.length > MAX_HISTORY_TRACKS
              ? h.slice(h.length - MAX_HISTORY_TRACKS)
              : h,
          );
        }
        (v as any)._playingFrom = store.get(playbackSourceAtom);
        (v as any)._contextFrom = store.get(contextSourceAtom);
        store.set(currentTrackAtom, v);
        try {
          await startVideoSession(store, {
            id: v.id,
            title: v.title,
            imageId: v.imageId,
            artist: v.artist?.name ?? v.artists?.[0]?.name,
            duration: v.duration,
          });
          return { ok: true };
        } catch (e) {
          console.error("Failed to play video:", e);
          return { ok: false, reason: "transient" };
        }
      }
      // Mutual exclusion: starting AUDIO stops any background video
      // (mirrors useVideoPlayback.closeVideo's atom clears).
      if (store.get(currentVideoAtom)) {
        store.set(videoPlayingAtom, false);
        store.set(videoStreamAtom, null);
        store.set(currentVideoAtom, null);
        store.set(videoExpandedAtom, false);
      }
      store.set(userPausedAtom, false);
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
      // Freeze position interpolation across the load gap so the bar doesn't
      // climb from 0 before the first sample is actually heard.
      markPlaybackLoading(true);
      store.set(currentTrackAtom, stamped);

      try {
        const info = await invokePlayForTarget(
          store,
          stamped,
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
        // Playback confirmed — release the load gate and anchor from 0.
        markPlaybackLoading(false);

        // Notify backend for scrobbling
        if (!opts?.skipScrobbleStart) {
          invoke("notify_track_started", {
            payload: buildTrackStartedPayload(
              stamped,
              opts?.chosenByUser ?? true,
            ),
          }).catch(() => {});
        }
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
        markPlaybackLoading(false);
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
    // Video is current → pause the shared <video>, never the audio pipeline.
    if (store.get(currentVideoAtom)) {
      videoElementRef.current?.pause();
      return;
    }
    store.set(userPausedAtom, true);
    try {
      await invoke(isRemoteTarget(store) ? "sonos_pause" : "pause_track");
      store.set(isPlayingAtom, false);
    } catch (error) {
      console.error("Failed to pause track:", error);
    }
  }, [store]);

  const resumeTrack = useCallback(async () => {
    store.set(userPausedAtom, false);
    // Video is current → play the shared <video>.
    if (store.get(currentVideoAtom)) {
      videoElementRef.current?.play().catch(() => {});
      return;
    }
    // Restored video (post-relaunch / after closeVideo): the current track is a
    // video but there is no live session — start one instead of hitting the audio
    // backend with a video id (which 404s).
    const restored = store.get(currentTrackAtom);
    if (restored?.itemType === "video") {
      try {
        await startVideoSession(store, {
          id: restored.id,
          title: restored.title,
          imageId: restored.imageId,
          artist: restored.artist?.name ?? restored.artists?.[0]?.name,
          duration: restored.duration,
        });
      } catch (e) {
        console.error("Failed to resume video:", e);
      }
      return;
    }
    try {
      const track = store.get(currentTrackAtom);
      if (!track) return;

      if (isRemoteTarget(store)) {
        // Cast-while-paused left a deferred seek: the entry was enqueued
        // with the transport STOPPED (unseekable) — start, then jump.
        const pendingSeek = store.get(sonosPendingResumeSeekAtom);
        if (pendingSeek != null) {
          store.set(sonosPendingResumeSeekAtom, null);
          await invoke("sonos_resume");
          store.set(isPlayingAtom, true);
          await invoke("sonos_seek", { positionSecs: pendingSeek }).catch(
            () => {},
          );
          notifySeek(pendingSeek);
          return;
        }
        // The speaker keeps its own transport state — no finished-check
        // against the (stopped) local pipeline. A resume from STOPPED
        // replays the queue entry from the top, which is a fresh listen.
        const finishedRemotely = await invoke<{ state: string }>(
          "sonos_get_now_playing",
        )
          .then((now) => now.state === "STOPPED")
          .catch(() => false);
        await invoke("sonos_resume");
        store.set(isPlayingAtom, true);
        if (finishedRemotely) {
          notifySeek(0);
          invoke("notify_track_started", {
            payload: buildTrackStartedPayload(track, true),
          }).catch(() => {});
        }
        return;
      }

      const isFinished = await invoke<boolean>("is_track_finished");
      if (isFinished) {
        // Replaying a finished track from the top: gate interpolation so the bar
        // doesn't show the stale end position during the reload.
        markPlaybackLoading(true);
        const info = await invokePlayWithRetry(
          track.id,
          store.get(useTrackGainAtom),
          () => {
            store.set(isPlayingAtom, false);
            showToast("Preparing exclusive audio…", "info");
          },
        );
        store.set(streamInfoAtom, info);
        // Replay starts at 0; clears the load gate and re-emits to the miniplayer.
        notifySeek(0);

        // Notify backend so the replay is scrobbled
        invoke("notify_track_started", {
          payload: buildTrackStartedPayload(track, true),
        }).catch(() => {});
      } else {
        await invoke("resume_track");
      }
      store.set(isPlayingAtom, true);
    } catch (error) {
      console.error("Failed to resume track:", error);
      store.set(isPlayingAtom, false);
      markPlaybackLoading(false);
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

  const togglePlayPause = useCallback(async () => {
    // For a LIVE video, decide from the element itself — videoPlayingAtom trails the
    // <video> play/pause DOM events, so a rapid double-press off the atom could land
    // on the wrong state. Fall back to the atom only when the element isn't mounted
    // yet, then to the audio isPlaying state.
    const el = store.get(currentVideoAtom) ? videoElementRef.current : null;
    const playing = el
      ? !el.paused
      : store.get(currentVideoAtom)
        ? store.get(videoPlayingAtom)
        : store.get(isPlayingAtom);
    if (playing) await pauseTrack();
    else await resumeTrack();
  }, [store, pauseTrack, resumeTrack]);

  /** Peek the next track for gapless registration. Returns null unless the next track
   *  is the AVAILABLE head of manual/context queue AND its _source matches the current
   *  playback source (so gapless never changes the "Playing from" context wrongly).
   *  Read-only: never mutates any atom. */
  const predictNextTrack = useCallback((): Track | null => {
    return pickGaplessNext({
      repeat: store.get(repeatAtom),
      manualHead: store.get(manualQueueAtom)[0] ?? null,
      contextHead: store.get(queueAtom)[0] ?? null,
      currentSourceId: store.get(playbackSourceAtom)?.id,
    });
  }, [store]);

  /** Bookkeeping for a track the backend is ALREADY playing gaplessly.
   *  Mirrors playTrack's success path WITHOUT invoking play: bumps the generation
   *  guard (aborts any in-flight playTrack writes), pushes history, stamps source
   *  context, sets current/streamInfo, preserves user-pause intent, and fires the
   *  scrobble notify. */
  const advanceToTrack = useCallback(
    (track: Track, info: StreamInfo | null) => {
      ++playGenerationRef.current; // abort any in-flight playTrack writes
      const stamped = ensureQid(normalizeTrack(track));
      preloadImage(getTidalImageUrl(stamped.album?.cover, 640));
      preloadImage(getTidalImageUrl(stamped.album?.cover, 1280));
      const prev = store.get(currentTrackAtom);
      if (prev) {
        const h = [...store.get(historyAtom), prev];
        store.set(
          historyAtom,
          h.length > MAX_HISTORY_TRACKS
            ? h.slice(h.length - MAX_HISTORY_TRACKS)
            : h,
        );
      }
      (stamped as any)._playingFrom = store.get(playbackSourceAtom);
      (stamped as any)._contextFrom = store.get(contextSourceAtom);
      store.set(currentTrackAtom, stamped); // cascades MPRIS/Discord/position reset
      store.set(streamInfoAtom, info);
      // At a gapless advance the pipeline is definitionally rolling, so the new track IS
      // playing unless the USER paused. Use explicit pause intent via the GLOBAL
      // userPausedAtom (written by every pauseTrack/resumeTrack path, instance-independent),
      // NOT the per-hook ref and NOT the (possibly transient) isPlayingAtom.
      store.set(isPlayingAtom, !store.get(userPausedAtom));
      store.set(consecutiveFailCountAtom, 0);
      // The generation bump above aborts any in-flight playTrack, which would
      // otherwise return early without clearing its load gate. Release it here so
      // the gate can't stay stuck and freeze the position bar on this new track.
      markPlaybackLoading(false);
      invoke("notify_track_started", {
        payload: buildTrackStartedPayload(stamped, false),
      }).catch(() => {});
    },
    [store],
  );

  /** Reconcile SONE's queue model to a track the SPEAKER is already playing
   *  (mirrored self-advance, or an external Next/Previous/queue-jump from
   *  the Sonos app). Pure atom surgery — never invokes playback. Returns
   *  false when the track maps to nothing we know (possible takeover). */
  const adoptRemoteTrack = useCallback(
    (trackId: number, qid?: string): boolean => {
      const current = store.get(currentTrackAtom);
      if (current && current.id === trackId && (!qid || current._qid === qid)) {
        return true; // echo of our own state
      }
      const matches = (t: Track) => (qid ? t._qid === qid : t.id === trackId);
      const pushHistory = (tracks: Track[]) => {
        if (tracks.length === 0) return;
        const h = [...store.get(historyAtom), ...tracks];
        store.set(
          historyAtom,
          h.length > MAX_HISTORY_TRACKS
            ? h.slice(h.length - MAX_HISTORY_TRACKS)
            : h,
        );
      };

      // Forward: the target sits in the up-next queues. Everything before it
      // (in play order) was skipped over — same bookkeeping as N × Next.
      const manual = store.get(manualQueueAtom);
      const mIdx = manual.findIndex(matches);
      if (mIdx >= 0) {
        const target = manual[mIdx];
        pushHistory(manual.slice(0, mIdx));
        store.set(manualQueueAtom, manual.slice(mIdx + 1));
        advanceToTrack(target, null);
        return true;
      }
      const queue = store.get(queueAtom);
      const qIdx = queue.findIndex(matches);
      if (qIdx >= 0) {
        const target = queue[qIdx];
        const skipped = [...manual, ...queue.slice(0, qIdx)];
        pushHistory(skipped);
        store.set(manualQueueAtom, []);
        store.set(queueAtom, queue.slice(qIdx + 1));
        const orig = store.get(originalQueueAtom);
        if (orig) {
          const dropQids = new Set([
            target._qid,
            ...skipped.map((t) => t._qid),
          ]);
          store.set(
            originalQueueAtom,
            orig.filter((t) => !dropQids.has(t._qid)),
          );
        }
        advanceToTrack(target, null);
        return true;
      }

      // Backward: the target is in history (external Previous / jump back).
      const history = store.get(historyAtom);
      const hIdx = qid
        ? history.map((t) => t._qid).lastIndexOf(qid)
        : history.map((t) => t.id).lastIndexOf(trackId);
      if (hIdx >= 0) {
        const target = history[hIdx];
        store.set(
          historyAtom,
          history.filter((_, i) => i !== hIdx),
        );
        if (current) {
          store.set(manualQueueAtom, [current, ...store.get(manualQueueAtom)]);
        }
        ++playGenerationRef.current; // abort in-flight playTrack writes
        store.set(currentTrackAtom, target);
        store.set(streamInfoAtom, null);
        store.set(isPlayingAtom, !store.get(userPausedAtom));
        markPlaybackLoading(false);
        invoke("notify_track_started", {
          payload: buildTrackStartedPayload(target, true),
        }).catch(() => {});
        return true;
      }
      return false;
    },
    [store, advanceToTrack],
  );

  const setVolume = useCallback(
    async (level: number) => {
      if (isRemoteTarget(store)) {
        // Sonos group volume (0–100). The local volumeAtom is untouched so
        // it restores exactly on handoff; bit-perfect only gates local gain.
        const volume = Math.round(Math.max(0, Math.min(1, level)) * 100);
        store.set(sonosVolumeAtom, volume);
        sendSonosVolumeThrottled(volume);
        return;
      }
      const bitPerfect = store.get(bitPerfectAtom);
      const isVideo = !!store.get(currentVideoAtom);
      // Bit-perfect audio stays locked at unity; video audio is lossy, so the
      // slider must still work for it.
      if (bitPerfect && !isVideo) return;
      store.set(volumeAtom, level); // the <video> element reads this atom
      // Never push a non-unity level to the GStreamer pipeline while bit-perfect
      // is on — that would attenuate (and un-bit-perfect) audio playback.
      if (bitPerfect) return;
      try {
        await invoke("set_volume", { level });
      } catch (error) {
        console.error("Failed to set volume:", error);
      }
    },
    [store],
  );

  const setVolumeNormalization = useCallback(
    async (enabled: boolean) => {
      store.set(volumeNormalizationAtom, enabled);
      try {
        await invoke("set_volume_normalization", { enabled });
      } catch (error) {
        console.error("Failed to set volume normalization:", error);
      }
    },
    [store],
  );

  const rampVolume = useCallback(
    async (from: number, to: number, durationMs = 300, steps = 12) => {
      if (Math.abs(from - to) < 1e-4) return;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const level = from + (to - from) * t;
        store.set(volumeAtom, level);
        try {
          await invoke("set_volume", { level });
        } catch (error) {
          console.error("Failed to set volume:", error);
        }
        if (i < steps)
          await new Promise((r) => setTimeout(r, durationMs / steps));
      }
    },
    [store],
  );

  const setBitPerfect = useCallback(
    async (enabled: boolean) => {
      const currentlyEnabled = store.get(bitPerfectAtom);
      if (enabled === currentlyEnabled) return;

      if (enabled) {
        // Save current state so we can restore on disable.
        const prevVolume = store.get(volumeAtom);
        store.set(bitPerfectPreviousStateAtom, {
          volume: prevVolume,
          volumeNormalization: store.get(volumeNormalizationAtom),
        });
        // Ramp BEFORE flipping bit-perfect — the setVolume short-circuit
        // would block updates otherwise.
        await rampVolume(prevVolume, 1.0);
        store.set(volumeNormalizationAtom, false);
        try {
          await invoke("set_volume_normalization", { enabled: false });
        } catch (error) {
          console.error("Failed to set volume normalization:", error);
        }
        store.set(bitPerfectAtom, true);
        try {
          await invoke("set_bit_perfect", { enabled: true });
        } catch (error) {
          console.error("Failed to set bit perfect:", error);
        }
      } else {
        // Flip the atom FIRST so the ramp's setVolume calls go through.
        store.set(bitPerfectAtom, false);
        try {
          await invoke("set_bit_perfect", { enabled: false });
        } catch (error) {
          console.error("Failed to set bit perfect:", error);
        }
        const prev = store.get(bitPerfectPreviousStateAtom);
        if (prev) {
          await rampVolume(store.get(volumeAtom), prev.volume);
          store.set(volumeNormalizationAtom, prev.volumeNormalization);
          try {
            await invoke("set_volume_normalization", {
              enabled: prev.volumeNormalization,
            });
          } catch (error) {
            console.error("Failed to set volume normalization:", error);
          }
          store.set(bitPerfectPreviousStateAtom, null);
        }
      }
    },
    [store, rampVolume],
  );

  const seekTo = useCallback(
    async (positionSecs: number) => {
      try {
        if (isRemoteTarget(store)) {
          // Cast-while-paused: the transport is STOPPED and unseekable —
          // scrubs just move the deferred resume position.
          if (store.get(sonosPendingResumeSeekAtom) != null) {
            store.set(sonosPendingResumeSeekAtom, positionSecs);
            notifySeek(positionSecs);
            return;
          }
          await invoke("sonos_seek", { positionSecs });
        } else {
          await invoke("seek_track", { positionSecs });
        }
        notifySeek(positionSecs);
      } catch (error) {
        console.error("Failed to seek:", error);
      }
    },
    [store],
  );

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
      const eligible = filterExplicit
        ? tracks.filter((t) => !t.explicit)
        : tracks;
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
      const eligible = filterExplicit
        ? newTracks.filter((t) => !t.explicit)
        : newTracks;
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
      store.set(userPausedAtom, false);
      try {
        const repeatMode = store.get(repeatAtom);

        // Repeat-one: replay current track unless explicit skip
        if (repeatMode === 2 && !options?.explicit) {
          const current = store.get(currentTrackAtom);
          if (current) {
            if (current.itemType === "video") {
              // In-place loop: the element already holds the stream, so just
              // rewind — the autoplay guard would otherwise block a re-attach.
              const v = videoElementRef.current;
              if (v) {
                v.currentTime = 0;
                v.play().catch(() => {});
              } else {
                try {
                  await startVideoSession(store, {
                    id: current.id,
                    title: current.title,
                    imageId: current.imageId,
                    artist: current.artist?.name ?? current.artists?.[0]?.name,
                    duration: current.duration,
                  });
                } catch (e) {
                  console.error("Failed to repeat video:", e);
                }
              }
              return;
            }
            // In-place replay: currentTrackAtom is unchanged, so no track-change
            // reset fires. Gate interpolation so the bar doesn't keep climbing
            // past the old track's end during the reload.
            markPlaybackLoading(true);
            try {
              const info = await invokePlayForTarget(
                store,
                current,
                store.get(useTrackGainAtom),
                () => {
                  store.set(isPlayingAtom, false);
                  showToast("Preparing exclusive audio…", "info");
                },
              );
              store.set(streamInfoAtom, info);
              store.set(isPlayingAtom, true);
              // Restart from 0; clears the load gate and re-emits to the miniplayer.
              notifySeek(0);
              invoke("notify_track_started", {
                payload: buildTrackStartedPayload(current, false),
              }).catch(() => {});
            } catch (error: any) {
              markPlaybackLoading(false);
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

        // Stop old pipeline to prevent stale track-finished events. Remote:
        // no local pipeline is rolling, and sonos_play_track replaces the
        // speaker queue atomically — nothing to stop.
        if (!isRemoteTarget(store)) {
          await invoke("stop_track").catch(() => {});
        }

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
          store.set(manualQueueAtom, [
            nextTrack,
            ...store.get(manualQueueAtom),
          ]);
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
          const repeatSource =
            store.get(contextSourceAtom) ?? store.get(playbackSourceAtom);
          const sourceTracks = repeatSource?.tracks;
          const explicitOk = store.get(allowExplicitAtom);
          const hasSource = !!(sourceTracks && sourceTracks.length > 0);
          const raw = hasSource
            ? sourceTracks
            : [
                ...store.get(historyAtom),
                ...(store.get(currentTrackAtom)
                  ? [store.get(currentTrackAtom)!]
                  : []),
              ];
          // Pre-filter unavailable so the rebuilt queue doesn't immediately hit them.
          const all = stampQids(
            (explicitOk ? raw : raw.filter((t) => !t.explicit)).filter(
              (t) => !isTrackUnavailable(t),
            ),
          );

          if (all.length > 0) {
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
            // Source-backed loops keep history so Previous + the history view
            // survive the loop; the history-derived fallback clears it so the
            // rebuilt queue doesn't grow each loop.
            if (!hasSource) store.set(historyAtom, []);
            const result = await playTrack(
              first,
              hasSource ? undefined : { skipHistoryPush: true },
            );
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
              const historyIds = new Set(
                store.get(historyAtom).map((t) => t.id),
              );
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

      // Stop old pipeline to prevent stale track-finished events (local only).
      if (!isRemoteTarget(store)) {
        await invoke("stop_track").catch(() => {});
      }

      // Mutual exclusion: clear any background video. If the resolved previous
      // item is itself a video, startVideoSession (below) re-establishes these.
      if (store.get(currentVideoAtom)) {
        store.set(videoPlayingAtom, false);
        store.set(videoStreamAtom, null);
        store.set(currentVideoAtom, null);
        store.set(videoExpandedAtom, false);
      }

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
          const sourceTag = src
            ? {
                type: src.type,
                id: src.id,
                name: src.name,
                image: src.image,
                subtitle: src.subtitle,
                mixType: src.mixType,
              }
            : undefined;
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
        // Freeze interpolation across the load gap so the bar doesn't climb
        // from 0 before the previous track's first sample is heard.
        markPlaybackLoading(true);
        store.set(currentTrackAtom, prevTrack);

        if (prevTrack.itemType === "video") {
          markPlaybackLoading(false);
          try {
            await startVideoSession(store, {
              id: prevTrack.id,
              title: prevTrack.title,
              imageId: prevTrack.imageId,
              artist: prevTrack.artist?.name ?? prevTrack.artists?.[0]?.name,
              duration: prevTrack.duration,
            });
          } catch (e) {
            console.error("Failed to play previous video:", e);
          }
          return;
        }

        try {
          preloadImage(getTidalImageUrl(prevTrack.album?.cover, 640));
          preloadImage(getTidalImageUrl(prevTrack.album?.cover, 1280));
          const info = await invokePlayForTarget(
            store,
            prevTrack,
            store.get(useTrackGainAtom),
            () => {
              store.set(isPlayingAtom, false);
              showToast("Preparing exclusive audio…", "info");
            },
          );
          store.set(streamInfoAtom, info);
          store.set(isPlayingAtom, true);
          markPlaybackLoading(false);

          // Notify backend for scrobbling
          invoke("notify_track_started", {
            payload: buildTrackStartedPayload(prevTrack, true),
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
          markPlaybackLoading(false);
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
              const sourceTag = src
                ? {
                    type: src.type,
                    id: src.id,
                    name: src.name,
                    image: src.image,
                    subtitle: src.subtitle,
                    mixType: src.mixType,
                  }
                : undefined;
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
                  store.set(originalQueueAtom, [
                    current,
                    ...savedOriginalQueue,
                  ]);
                }
              }
            }

            // Eagerly update UI
            markPlaybackLoading(true);
            store.set(currentTrackAtom, prevTrack);

            if (prevTrack.itemType === "video") {
              markPlaybackLoading(false);
              try {
                await startVideoSession(store, {
                  id: prevTrack.id,
                  title: prevTrack.title,
                  imageId: prevTrack.imageId,
                  artist:
                    prevTrack.artist?.name ?? prevTrack.artists?.[0]?.name,
                  duration: prevTrack.duration,
                });
              } catch (e) {
                console.error("Failed to play previous video:", e);
              }
              return;
            }

            try {
              const info = await invokePlayForTarget(
                store,
                prevTrack,
                store.get(useTrackGainAtom),
                () => {
                  store.set(isPlayingAtom, false);
                  showToast("Preparing exclusive audio…", "info");
                },
              );
              store.set(streamInfoAtom, info);
              store.set(isPlayingAtom, true);
              markPlaybackLoading(false);

              // Notify backend for scrobbling
              invoke("notify_track_started", {
                payload: buildTrackStartedPayload(prevTrack, true),
              }).catch(() => {});
            } catch (error: any) {
              // Rollback all state
              store.set(currentTrackAtom, current);
              store.set(queueAtom, savedQueue);
              store.set(originalQueueAtom, savedOriginalQueue);
              store.set(manualQueueAtom, savedManualQueue);
              console.error("Failed to play previous track:", error);
              store.set(isPlayingAtom, false);
              markPlaybackLoading(false);
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
      const eligible = filterExplicit
        ? tracks.filter((t) => !t.explicit)
        : tracks;
      const stamped = stampQids(eligible.map(normalizeTrack));
      store.set(manualQueueAtom, []);
      store.set(contextSourceAtom, null);
      const shuffleOn = store.get(shuffleAtom);
      store.set(originalQueueAtom, shuffleOn ? stamped : null);
      store.set(queueAtom, fisherYatesShuffle(stamped));
      store.set(useTrackGainAtom, !options?.albumMode);
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
      const eligible = filterExplicit
        ? allTracks.filter((t) => !t.explicit)
        : allTracks;
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
      const eligible = allTracks.filter(
        (t) => !isTrackUnavailable(t) && (!filterExplicit || !t.explicit),
      );
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
    togglePlayPause,
    setVolume,
    setVolumeNormalization,
    setBitPerfect,
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
    predictNextTrack,
    advanceToTrack,
    adoptRemoteTrack,
    playNextLockRef,
    playGenerationRef,
    autoplayIdsRef,
  };
}
