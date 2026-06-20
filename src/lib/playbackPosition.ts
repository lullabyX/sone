import { invoke } from "@tauri-apps/api/core";

// ─── Module-level singleton state ────────────────────────────────────────
let lastKnownPosition = 0;
let lastFetchTime = 0;
let playing = false;
let syncInterval: ReturnType<typeof setInterval> | null = null;
let seekCorrectionTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;
let unsubPlaying: (() => void) | null = null;
let unsubTrack: (() => void) | null = null;
let trackGeneration = 0;
// Timestamp (performance.now) of the most recent track-change reset. Used to
// open a short settle window during which a poll value that is implausibly far
// ahead of the locally-interpolated position is rejected — this rides over the
// brief cumulative-runtime transient the Normal-mode `concat` element exposes
// at a gapless boundary (query_position momentarily returns the previous
// track's total runtime before the new per-track segment applies).
let trackResetTime = 0;
// True while a user-initiated play is loading (from the currentTrackAtom reset
// until the backend confirms playback started). Freezes interpolation so the
// position doesn't climb from 0 during the load gap, or past the old track's
// end during an in-place replay. Gapless advances never set this.
let loadingTrack = false;
// How long after a track change to apply the guard.
const SETTLE_WINDOW_MS = 3000;
// A poll exceeding the expected position by more than this is treated as the
// stale cumulative transient (only within the settle window) and discarded.
const SETTLE_AHEAD_TOLERANCE_SECS = 2;

// ─── Private helpers ─────────────────────────────────────────────────────

async function fetchAndAnchor() {
  const gen = trackGeneration;
  try {
    const pos = await invoke<number>("get_playback_position");
    // Discard stale response if track changed while awaiting
    if (gen !== trackGeneration) return;

    // Settle-window guard: right after a gapless track change the backend may
    // briefly report the *previous* track's cumulative runtime (concat
    // re-basing transient). During the settle window, reject any poll that
    // jumps far ahead of where local interpolation expects us to be, and keep
    // interpolating from the reset (0). Scoped to track-change resets only —
    // seeks anchor via notifySeek() and never touch trackResetTime, so a
    // deliberate forward seek is never rejected. A legitimately-large position
    // (e.g. a track that genuinely resumed near its end) is established by the
    // track-change reset/interpolation itself, not by this poll.
    if (performance.now() - trackResetTime < SETTLE_WINDOW_MS) {
      const expected = getInterpolatedPosition();
      if (pos > expected + SETTLE_AHEAD_TOLERANCE_SECS) {
        return;
      }
    }

    lastKnownPosition = pos;
    lastFetchTime = performance.now();
  } catch {
    // Backend unavailable — keep last known value
  }
}

function startSyncLoop() {
  stopSyncLoop();
  // Immediate fetch to re-anchor (e.g. after resume)
  fetchAndAnchor();
  syncInterval = setInterval(fetchAndAnchor, 2000);
}

function stopSyncLoop() {
  if (syncInterval !== null) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Synchronous interpolated position read.
 * Returns seconds elapsed since last anchor when playing,
 * or the frozen position when paused.
 */
export function getInterpolatedPosition(): number {
  if (!playing || loadingTrack) return lastKnownPosition;
  const elapsed = (performance.now() - lastFetchTime) / 1000;
  return lastKnownPosition + elapsed;
}

/**
 * Call after any seekTo() resolves. Optimistically sets position,
 * then schedules a 300ms correction fetch to account for GStreamer
 * seek imprecision.
 */
export function notifySeek(targetSecs: number) {
  lastKnownPosition = targetSecs;
  lastFetchTime = performance.now();
  // A seek is an explicit, known anchor — clear any pending load gate so the
  // position interpolates from the seek target immediately.
  loadingTrack = false;
  // A deliberate seek explicitly anchors the position; close any open
  // track-change settle window so the 300ms correction poll (and subsequent
  // polls) are trusted even when the user seeked far forward.
  trackResetTime = 0;

  // Notify miniplayer emitter of position change
  window.dispatchEvent(
    new CustomEvent("playback-seeked", { detail: targetSecs }),
  );

  // Cancel any pending correction from a previous seek
  if (seekCorrectionTimer !== null) {
    clearTimeout(seekCorrectionTimer);
  }

  // Correction fetch after 300ms to re-anchor to actual backend position
  seekCorrectionTimer = setTimeout(() => {
    seekCorrectionTimer = null;
    fetchAndAnchor();
  }, 300);
}

/**
 * Gate interpolation while a user-initiated play is loading.
 * Call `markPlaybackLoading(true)` just before the currentTrackAtom reset for an
 * explicit play / in-place replay, and `markPlaybackLoading(false)` once the
 * backend confirms playback has started. This stops the displayed position from
 * climbing from 0 during the load gap. Gapless advances (advanceToTrack) leave
 * this untouched — the pipeline is already rolling, so they interpolate from 0
 * immediately and the settle window handles the concat transient.
 */
export function markPlaybackLoading(loading: boolean) {
  loadingTrack = loading;
  // On start, re-anchor the clock so interpolation resumes from the frozen
  // position at the confirmed-start instant rather than back-dating elapsed.
  if (!loading) lastFetchTime = performance.now();
}

/**
 * Initialise the interpolator. Called once from AppInitializer.
 * Subscribes to isPlayingAtom and currentTrackAtom via Jotai store.sub().
 */
export function initPositionInterpolator(
  store: {
    get: (atom: any) => any;
    sub: (atom: any, cb: () => void) => () => void;
  },
  isPlayingAtom: any,
  currentTrackAtom: any,
) {
  if (initialized) return;
  initialized = true;

  // Read initial state
  playing = store.get(isPlayingAtom);
  if (playing) startSyncLoop();

  // Subscribe to play/pause changes
  unsubPlaying = store.sub(isPlayingAtom, () => {
    const nowPlaying = store.get(isPlayingAtom);
    if (nowPlaying === playing) return;

    if (nowPlaying) {
      // Resuming — re-anchor the clock to NOW *before* flipping `playing`, so
      // the paused interval is not counted as elapsed playback, then re-fetch.
      lastFetchTime = performance.now();
      playing = true;
      startSyncLoop();
    } else {
      // Pausing — snapshot the LIVE interpolated position *before* flipping
      // `playing`; otherwise getInterpolatedPosition() short-circuits to the
      // stale anchor (lines above) and the position jumps backward.
      lastKnownPosition = getInterpolatedPosition();
      lastFetchTime = performance.now();
      playing = false;
      stopSyncLoop();
    }
  });

  // Subscribe to track changes — reset to 0
  unsubTrack = store.sub(currentTrackAtom, () => {
    trackGeneration++;
    lastKnownPosition = 0;
    lastFetchTime = performance.now();
    // Open the settle window so the next poll(s) ride over any stale
    // cumulative-runtime transient from the gapless concat boundary.
    trackResetTime = performance.now();

    // Cancel any pending seek correction (stale for new track)
    if (seekCorrectionTimer !== null) {
      clearTimeout(seekCorrectionTimer);
      seekCorrectionTimer = null;
    }
  });
}

/**
 * Tear down the interpolator. Called from AppInitializer cleanup.
 */
export function destroyPositionInterpolator() {
  stopSyncLoop();
  if (seekCorrectionTimer !== null) {
    clearTimeout(seekCorrectionTimer);
    seekCorrectionTimer = null;
  }
  unsubPlaying?.();
  unsubTrack?.();
  unsubPlaying = null;
  unsubTrack = null;
  initialized = false;
  lastKnownPosition = 0;
  lastFetchTime = 0;
  trackResetTime = 0;
  loadingTrack = false;
  playing = false;
}
