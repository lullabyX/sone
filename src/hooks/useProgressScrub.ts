import { useState, useEffect, useRef, useCallback } from "react";
import { useAtomValue } from "jotai";
import { currentTrackAtom, isPlayingAtom } from "../atoms/playback";
import { usePlaybackActions } from "./usePlaybackActions";
import { getInterpolatedPosition, notifySeek } from "../lib/playbackPosition";

interface UseProgressScrubOptions {
  /** Ref to signal parent that a drag is in progress (for auto-hide) */
  isDraggingRef?: React.MutableRefObject<boolean>;
  /** Callback when drag ends (for resetting auto-hide timer) */
  onDragEnd?: () => void;
}

export function useProgressScrub(options?: UseProgressScrubOptions) {
  const currentTrack = useAtomValue(currentTrackAtom);
  const isPlaying = useAtomValue(isPlayingAtom);
  const { seekTo } = usePlaybackActions();

  // Destructure options for stable deps (refs are stable, useCallback fns are stable)
  const isDraggingRef = options?.isDraggingRef;
  const onDragEnd = options?.onDragEnd;

  const [currentTime, setCurrentTime] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragTime, setDragTime] = useState(0);
  const [isHoveringProgress, setIsHoveringProgress] = useState(false);
  const progressRef = useRef<HTMLDivElement>(null);

  // Sync progress with interpolated position (no IPC per tick)
  useEffect(() => {
    if (!isPlaying || !currentTrack || isDragging) return;

    const syncPosition = () => {
      setCurrentTime(getInterpolatedPosition());
    };

    syncPosition();
    const interval = setInterval(syncPosition, 500);
    return () => clearInterval(interval);
  }, [isPlaying, currentTrack, isDragging]);

  // Reset on track change
  useEffect(() => {
    setCurrentTime(0);
  }, [currentTrack?.id]);

  const duration = currentTrack?.duration ?? 0;
  const displayTime = isDragging ? dragTime : currentTime;
  const progress = duration > 0 ? (displayTime / duration) * 100 : 0;
  const clampedProgress = Math.min(100, Math.max(0, progress));

  const getTimeFromClientX = useCallback(
    (clientX: number) => {
      if (!progressRef.current || !currentTrack) return 0;
      const el = progressRef.current;
      const rect = el.getBoundingClientRect();

      let adjustedX = clientX;
      const cssWidth = el.offsetWidth;
      if (cssWidth > 0 && Math.abs(rect.width / cssWidth - 1) < 0.01) {
        const zoom = parseFloat(document.documentElement.style.zoom || "1");
        if (zoom !== 1) {
          adjustedX = clientX / zoom;
        }
      }

      const pct = Math.max(
        0,
        Math.min(1, (adjustedX - rect.left) / rect.width),
      );
      return pct * currentTrack.duration;
    },
    [currentTrack],
  );

  const handleProgressMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!currentTrack) return;
      e.preventDefault();
      // eslint-disable-next-line react-hooks/immutability
      if (isDraggingRef) isDraggingRef.current = true;
      const startTime = getTimeFromClientX(e.clientX);
      setIsDragging(true);
      setDragTime(startTime);

      const onMove = (ev: MouseEvent) => {
        setDragTime(getTimeFromClientX(ev.clientX));
      };

      const onUp = async (ev: MouseEvent) => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        const finalTime = getTimeFromClientX(ev.clientX);
        setCurrentTime(finalTime);
        setIsDragging(false);
        if (isDraggingRef) isDraggingRef.current = false;
        onDragEnd?.();
        notifySeek(finalTime);
        await seekTo(finalTime);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [currentTrack, getTimeFromClientX, seekTo, isDraggingRef, onDragEnd],
  );

  return {
    progressRef,
    currentTrack,
    displayTime,
    duration,
    clampedProgress,
    isDragging,
    isHoveringProgress,
    setIsHoveringProgress,
    handleProgressMouseDown,
  };
}
