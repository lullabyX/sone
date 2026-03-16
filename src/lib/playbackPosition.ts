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

// ─── Private helpers ─────────────────────────────────────────────────────

async function fetchAndAnchor() {
  try {
    const pos = await invoke<number>("get_playback_position");
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
  if (!playing) return lastKnownPosition;
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

  // Notify miniplayer emitter of position change
  window.dispatchEvent(new CustomEvent("playback-seeked", { detail: targetSecs }));

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
    playing = nowPlaying;

    if (playing) {
      // Resuming — re-anchor and start loop
      startSyncLoop();
    } else {
      // Pausing — freeze at current interpolated position
      lastKnownPosition = getInterpolatedPosition();
      lastFetchTime = performance.now();
      stopSyncLoop();
    }
  });

  // Subscribe to track changes — reset to 0
  unsubTrack = store.sub(currentTrackAtom, () => {
    lastKnownPosition = 0;
    lastFetchTime = performance.now();

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
  playing = false;
}
