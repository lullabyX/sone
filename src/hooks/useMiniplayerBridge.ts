import { useState, useEffect, useCallback, useRef } from "react";
import { listen, emitTo } from "@tauri-apps/api/event";
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
  });

  // Local position interpolation
  const posAnchor = useRef({ position: 0, time: performance.now(), playing: false });
  const [displayPosition, setDisplayPosition] = useState(0);

  // Listen for state updates from main window
  useEffect(() => {
    const unlisten = listen<MiniplayerState>("miniplayer-state-update", (event) => {
      const s = event.payload;
      setState(s);
      posAnchor.current = {
        position: s.position,
        time: performance.now(),
        playing: s.isPlaying,
      };
    });

    // Signal readiness — main window will respond with full state
    emitTo("main", "miniplayer-ready", {}).catch(() => {});

    return () => { unlisten.then((fn) => fn()); };
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
  const [optimisticPlaying, setOptimisticPlaying] = useState<boolean | null>(null);

  // Clear optimistic override when real state arrives
  useEffect(() => {
    if (optimisticPlayRef.current) {
      clearTimeout(optimisticPlayRef.current);
      optimisticPlayRef.current = null;
    }
    setOptimisticPlaying(null);
  }, [state.isPlaying]);

  const sendCommand = useCallback(
    (action: string, value?: number) => {
      // Optimistic UI for toggle-play
      if (action === "toggle-play") {
        const newState = !(optimisticPlaying ?? state.isPlaying);
        setOptimisticPlaying(newState);
        optimisticPlayRef.current = setTimeout(() => {
          setOptimisticPlaying(null);
        }, 2000);
      }
      emitTo("main", "miniplayer-command", { action, value }).catch(() => {});
    },
    [state.isPlaying, optimisticPlaying],
  );

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
