import { useState, useEffect, useCallback, useRef } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MiniplayerState } from "./useMiniplayerEmitter";

export function useMiniplayerBridge() {
  const [state, setState] = useState<MiniplayerState>({
    track: null,
    isPlaying: false,
    position: 0,
    duration: 0,
    isFavorite: false,
    shuffle: false,
    repeat: 0,
    volume: 1,
    playbackSourceLabel: null,
    bitPerfect: false,
    accentColor: "#A855F7",
  });

  // Local position interpolation
  const posAnchor = useRef({
    position: 0,
    time: performance.now(),
    playing: false,
  });
  const seekUntil = useRef(0); // suppress incoming position updates until this timestamp
  const lastAnchoredTrackId = useRef<number | null>(null); // track the anchor belongs to
  const [displayPosition, setDisplayPosition] = useState(0);

  // Listen for state updates from main window
  useEffect(() => {
    const unlisten = getCurrentWindow().listen<MiniplayerState>(
      "miniplayer-state-update",
      (event) => {
        const s = event.payload;
        setState(s);
        // The seek-echo suppression window only applies to the SAME track. If
        // the track changed, always re-anchor — otherwise a track change landing
        // within 500ms of a seek keeps interpolating from the stale seek target.
        const trackChanged =
          (s.track?.id ?? null) !== lastAnchoredTrackId.current;
        lastAnchoredTrackId.current = s.track?.id ?? null;
        if (!trackChanged && performance.now() < seekUntil.current) {
          posAnchor.current.playing = s.isPlaying;
        } else {
          posAnchor.current = {
            position: s.position,
            time: performance.now(),
            playing: s.isPlaying,
          };
        }
      },
    );

    // Signal readiness — main window will respond with full state
    emitTo("main", "miniplayer-ready", {}).catch(() => {});

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // rAF loop for position interpolation
  useEffect(() => {
    let rafId: number;
    const tick = () => {
      const anchor = posAnchor.current;
      if (anchor.playing) {
        const elapsed = (performance.now() - anchor.time) / 1000;
        setDisplayPosition(anchor.position + elapsed);
      } else {
        setDisplayPosition(anchor.position);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // Optimistic play/pause with revert timeout
  const optimisticPlayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [optimisticPlaying, setOptimisticPlaying] = useState<boolean | null>(
    null,
  );

  // Clear optimistic override when real state arrives
  useEffect(() => {
    if (optimisticPlayRef.current) {
      clearTimeout(optimisticPlayRef.current);
      optimisticPlayRef.current = null;
    }
    setOptimisticPlaying(null);
  }, [state.isPlaying]);

  const isPlayingRef = useRef(state.isPlaying);
  isPlayingRef.current = state.isPlaying;
  const optimisticRef = useRef(optimisticPlaying);
  optimisticRef.current = optimisticPlaying;

  const sendCommand = useCallback((action: string, value?: number) => {
    // Optimistic UI for toggle-play
    if (action === "toggle-play") {
      const newState = !(optimisticRef.current ?? isPlayingRef.current);
      setOptimisticPlaying(newState);
      // Optimistically (un)freeze the local position clock so the progress bar
      // matches the icon immediately, instead of ticking onward until the
      // round-trip miniplayer-state-update arrives. The authoritative state
      // re-anchors on arrival (and the emitter's periodic re-emit self-heals if
      // the backend toggle never lands).
      const a = posAnchor.current;
      const current = a.playing
        ? a.position + (performance.now() - a.time) / 1000
        : a.position;
      posAnchor.current = {
        position: current,
        time: performance.now(),
        playing: newState,
      };
      setDisplayPosition(current);
      optimisticPlayRef.current = setTimeout(() => {
        setOptimisticPlaying(null);
      }, 2000);
    }
    // Optimistic seek — update anchor + displayPosition immediately, suppress stale echoes for 500ms
    if (action === "seek" && value !== undefined) {
      posAnchor.current = {
        position: value,
        time: performance.now(),
        playing: posAnchor.current.playing,
      };
      setDisplayPosition(value);
      seekUntil.current = performance.now() + 500;
    }
    emitTo("main", "miniplayer-command", { action, value }).catch(() => {});
  }, []);

  // Debounced volume command
  const volumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendVolume = useCallback(
    (vol: number) => {
      if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current);
      volumeTimerRef.current = setTimeout(() => {
        sendCommand("set-volume", vol);
      }, 50);
    },
    [sendCommand],
  );

  return {
    state,
    displayPosition,
    isPlaying: optimisticPlaying ?? state.isPlaying,
    sendCommand,
    sendVolume,
  };
}
