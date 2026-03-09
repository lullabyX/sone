import {
  Heart,
  MoreHorizontal,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Repeat,
  Shuffle,
  Minimize2,
  Infinity as InfinityIcon,
} from "lucide-react";
import { useState, useEffect, useRef, useCallback, memo } from "react";
import { useAtomValue, useSetAtom, useAtom, useStore } from "jotai";
import {
  currentTrackAtom,
  isPlayingAtom,
  autoplayAtom,
  repeatAtom,
  shuffleAtom,
} from "../atoms/playback";
import { favoriteTrackIdsAtom } from "../atoms/favorites";
import { maximizedPlayerAtom } from "../atoms/ui";
import { authTokensAtom } from "../atoms/auth";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useProgressScrub } from "../hooks/useProgressScrub";
import { getTidalImageUrl } from "../types";
import TidalImage from "./TidalImage";
import CrossfadeTidalImage from "./CrossfadeTidalImage";
import TrackContextMenu from "./TrackContextMenu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { formatTime } from "../lib/format";
import QualityBadge from "./QualityBadge";
import VolumeSlider from "./VolumeSlider";
import {
  addTrackToFavoritesCache,
  removeTrackFromFavoritesCache,
} from "../api/tidal";

// ─── MaxProgressScrubber ──────────────────────────────────────────────────

const MaxProgressScrubber = memo(function MaxProgressScrubber({
  isDraggingRef,
  resetHideTimer,
}: {
  isDraggingRef: React.MutableRefObject<boolean>;
  resetHideTimer: () => void;
}) {
  const {
    progressRef,
    currentTrack,
    displayTime,
    duration,
    clampedProgress,
    isDragging,
    isHoveringProgress,
    setIsHoveringProgress,
    handleProgressMouseDown,
  } = useProgressScrub({ isDraggingRef, onDragEnd: resetHideTimer });

  return (
    <div className="w-full flex items-center gap-2 text-th-text-muted">
      <span className="min-w-[40px] text-right text-[12px] tabular-nums select-none">
        {formatTime(displayTime)}
      </span>
      <div
        ref={progressRef}
        onMouseDown={handleProgressMouseDown}
        onMouseEnter={() => setIsHoveringProgress(true)}
        onMouseLeave={() => {
          if (!isDragging) setIsHoveringProgress(false);
        }}
        className="scrubber flex-1 relative cursor-pointer h-[17px] flex items-center"
      >
        <div className="relative w-full h-[6px] rounded-full">
          <div className="absolute inset-0 bg-white/[0.12] rounded-full" />
          <div
            className={`absolute left-0 rounded-full transition-[height,top,background-color] duration-100 ${
              isHoveringProgress || isDragging
                ? "h-full top-0 bg-th-accent"
                : "h-[3px] top-[1.5px] bg-white/60"
            }`}
            style={{ width: `${clampedProgress}%` }}
          />
          {!(isHoveringProgress || isDragging) && (
            <div className="absolute inset-0 rounded-full">
              <div className="absolute left-0 right-0 top-0 h-[1px] bg-th-elevated" />
              <div className="absolute left-0 right-0 bottom-0 h-[1px] bg-th-elevated" />
            </div>
          )}
        </div>
        <div
          className={`absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 bg-white rounded-full shadow-md shadow-black/50 pointer-events-none transition-opacity duration-100 ${
            isHoveringProgress || isDragging ? "opacity-100" : "opacity-0"
          }`}
          style={{ left: `calc(${clampedProgress}% - 7px)` }}
        />
      </div>
      <span className="min-w-[40px] text-[12px] tabular-nums select-none">
        {currentTrack ? formatTime(duration) : "0:00"}
      </span>
    </div>
  );
});

// ─── MaxTransportBar ──────────────────────────────────────────────────────

const MaxTransportBar = memo(function MaxTransportBar({
  currentTrack,
  controlsVisible,
  isDraggingRef,
  resetHideTimer,
  setMaximized,
}: {
  currentTrack: { title: string; artist?: { name?: string }; album?: { cover?: string; title?: string } };
  controlsVisible: boolean;
  isDraggingRef: React.MutableRefObject<boolean>;
  resetHideTimer: () => void;
  setMaximized: (v: boolean) => void;
}) {
  const isPlaying = useAtomValue(isPlayingAtom);
  const [repeatMode, setRepeatMode] = useAtom(repeatAtom);
  const [autoplay, setAutoplay] = useAtom(autoplayAtom);
  const isShuffle = useAtomValue(shuffleAtom);
  const { pauseTrack, resumeTrack, playNext, playPrevious, toggleShuffle } = usePlaybackActions();

  return (
    <div className={`absolute bottom-0 left-0 right-0 z-20 px-6 pb-4 pt-8 bg-gradient-to-t from-black/60 to-transparent transition-opacity duration-300 ${controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
      <div className="flex items-center justify-between">
        {/* Left: Track info */}
        <div className="flex items-center gap-3 w-[30%] min-w-[180px]">
          <div className="w-12 h-12 rounded-md overflow-hidden shadow-lg shadow-black/40 flex-shrink-0">
            <TidalImage
              src={getTidalImageUrl(currentTrack.album?.cover, 160)}
              alt={currentTrack.album?.title || currentTrack.title}
              className="w-full h-full object-cover"
            />
          </div>
          <div className="flex flex-col justify-center min-w-0 gap-0.5">
            <span className="text-white text-[13px] font-semibold truncate leading-tight">
              {currentTrack.title}
            </span>
            <span className="text-th-text-secondary text-[11px] truncate">
              {currentTrack.artist?.name || "Unknown Artist"}
            </span>
          </div>
        </div>

        {/* Center: Transport controls + scrubber */}
        <div className="flex flex-col items-center w-[40%] max-w-[600px] gap-1">
          {/* Transport buttons */}
          <div className="flex items-center gap-4">
            <button
              onClick={toggleShuffle}
              className={`w-8 h-8 flex items-center justify-center rounded-full transition-[color,background-color,transform] duration-200 active:scale-90 relative ${
                isShuffle
                  ? "text-th-accent"
                  : "text-th-text-secondary hover:text-white hover:bg-th-border-subtle"
              }`}
            >
              <Shuffle size={15} strokeWidth={2} />
              {isShuffle && (
                <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-th-accent" />
              )}
            </button>
            <button
              onClick={playPrevious}
              className="w-8 h-8 flex items-center justify-center rounded-full text-th-text-secondary hover:text-white hover:bg-th-border-subtle transition-[color,background-color,transform] duration-150 active:scale-90"
            >
              <SkipBack size={20} fill="currentColor" />
            </button>
            <button
              onClick={() => (isPlaying ? pauseTrack() : resumeTrack())}
              className="w-10 h-10 bg-white rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-transform duration-150"
            >
              {isPlaying ? (
                <Pause size={19} fill="black" className="text-black" />
              ) : (
                <Play size={19} fill="black" className="text-black ml-0.5" />
              )}
            </button>
            <button
              onClick={() => playNext({ explicit: true })}
              className="w-8 h-8 flex items-center justify-center rounded-full text-th-text-secondary hover:text-white hover:bg-th-border-subtle transition-[color,background-color,transform] duration-150 active:scale-90"
            >
              <SkipForward size={20} fill="currentColor" />
            </button>
            <button
              onClick={() => setRepeatMode((repeatMode + 1) % 3)}
              className={`w-8 h-8 flex items-center justify-center rounded-full transition-[color,background-color,transform] duration-200 active:scale-90 relative ${
                repeatMode > 0
                  ? "text-th-accent"
                  : "text-th-text-secondary hover:text-white hover:bg-th-border-subtle"
              }`}
            >
              <Repeat size={15} strokeWidth={2} />
              {repeatMode === 2 && (
                <span className="absolute -top-0.5 -right-0.5 text-[7px] font-bold bg-th-accent text-black rounded-full w-3 h-3 flex items-center justify-center leading-none">
                  1
                </span>
              )}
              {repeatMode > 0 && (
                <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-th-accent" />
              )}
            </button>
            <button
              onClick={() => setAutoplay(!autoplay)}
              className={`w-8 h-8 flex items-center justify-center rounded-full transition-[color,background-color,transform] duration-200 active:scale-90 relative ${
                autoplay
                  ? "text-th-accent"
                  : "text-th-text-secondary hover:text-white hover:bg-th-border-subtle"
              }`}
              title="Autoplay"
            >
              <InfinityIcon size={17} strokeWidth={2.5} />
              {autoplay && (
                <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-th-accent" />
              )}
            </button>
          </div>
          <MaxProgressScrubber isDraggingRef={isDraggingRef} resetHideTimer={resetHideTimer} />
        </div>

        {/* Right: Quality + Volume + Minimize */}
        <div className="flex items-center justify-end gap-4 w-[30%] min-w-[180px]">
          <QualityBadge />
          <VolumeSlider widthClass="w-[130px]" isDraggingRef={isDraggingRef} onDragEnd={resetHideTimer} />
          <button
            onClick={() => setMaximized(false)}
            className="text-th-text-faint hover:text-white transition-colors duration-150"
            title="Exit fullscreen"
          >
            <Minimize2 size={18} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
});

// ─── MaximizedPlayer ──────────────────────────────────────────────────────

export default function MaximizedPlayer() {
  const currentTrack = useAtomValue(currentTrackAtom);
  const setMaximized = useSetAtom(maximizedPlayerAtom);
  const favoriteTrackIds = useAtomValue(favoriteTrackIdsAtom);
  const setFavoriteTrackIds = useSetAtom(favoriteTrackIdsAtom);
  const store = useStore();

  // Context menu state
  const [contextMenuTrack, setContextMenuTrack] = useState<typeof currentTrack | null>(null);
  const contextMenuAnchorRef = useRef<HTMLButtonElement>(null);

  // All hooks MUST be above the early return (Rules of Hooks).
  const isLiked = currentTrack ? favoriteTrackIds.has(currentTrack.id) : false;

  const toggleLike = useCallback(async () => {
    if (!currentTrack) return;
    const authTokens = store.get(authTokensAtom);
    if (!authTokens?.user_id) return;
    const userId = authTokens.user_id;

    try {
      if (isLiked) {
        setFavoriteTrackIds((prev: Set<number>) => {
          const next = new Set(prev);
          next.delete(currentTrack.id);
          return next;
        });
        removeTrackFromFavoritesCache(userId, currentTrack.id);
        await invoke("remove_favorite_track", { userId, trackId: currentTrack.id });
      } else {
        setFavoriteTrackIds((prev: Set<number>) => new Set([...prev, currentTrack.id]));
        addTrackToFavoritesCache(userId, currentTrack);
        await invoke("add_favorite_track", { userId, trackId: currentTrack.id });
      }
    } catch (err) {
      // Rollback optimistic update
      if (isLiked) {
        setFavoriteTrackIds((prev: Set<number>) => new Set([...prev, currentTrack.id]));
        addTrackToFavoritesCache(userId, currentTrack);
      } else {
        setFavoriteTrackIds((prev: Set<number>) => {
          const next = new Set(prev);
          next.delete(currentTrack.id);
          return next;
        });
        removeTrackFromFavoritesCache(userId, currentTrack.id);
      }
      console.error("Failed to toggle track favorite:", err);
    }
  }, [currentTrack, isLiked, setFavoriteTrackIds, store]);

  // Auto-hide controls — ref guards against redundant setState on mouse move
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsVisibleRef = useRef(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isDraggingRef = useRef(false);

  const resetHideTimer = useCallback(() => {
    if (!controlsVisibleRef.current) {
      controlsVisibleRef.current = true;
      setControlsVisible(true);
    }
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (!isDraggingRef.current) {
        controlsVisibleRef.current = false;
        setControlsVisible(false);
      }
    }, 3000);
  }, []);

  useEffect(() => {
    resetHideTimer();
    return () => clearTimeout(hideTimerRef.current);
  }, [resetHideTimer]);

  // Reset maximized state when track goes away (queue depleted)
  useEffect(() => {
    if (!currentTrack) setMaximized(false);
  }, [currentTrack, setMaximized]);

  // Enter true fullscreen on mount, exit on unmount (Tauri — instant, no browser animation)
  useEffect(() => {
    const appWindow = getCurrentWindow();
    appWindow.setFullscreen(true);
    return () => { appWindow.setFullscreen(false); };
  }, []);

  // ESC to close — yields to context menu if open
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (contextMenuTrack) return;
      setMaximized(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setMaximized, contextMenuTrack]);

  if (!currentTrack) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseMove={resetHideTimer}
      className={`fixed inset-0 z-[60] flex flex-col items-center justify-center select-none bg-black ${controlsVisible ? "cursor-default" : "cursor-none"}`}
    >
      {/* Blurred album art background — 320px source (blur hides detail), GPU-promoted layer */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="w-full h-full scale-110 blur-[40px] will-change-transform">
          <TidalImage
            src={getTidalImageUrl(currentTrack.album?.cover, 320)}
            alt=""
            className="w-full h-full object-cover"
          />
        </div>
        <div className="absolute inset-0 bg-black/60" />
      </div>

      {/* Center content */}
      <div className="relative z-10 flex flex-col items-center gap-5">
        {/* Large album art — responsive: 80vmin capped at 800px */}
        <div className="max-w-[800px] w-[80vmin] aspect-square rounded-lg overflow-hidden shadow-2xl shadow-black/60">
          <CrossfadeTidalImage
            src={getTidalImageUrl(currentTrack.album?.cover, 1280)}
            alt={currentTrack.album?.title || currentTrack.title}
            className="w-full h-full"
          />
        </div>

        {/* Track info */}
        <div className="flex flex-col items-center gap-1 max-w-[800px] w-[80vmin]">
          <span className="text-white text-[24px] font-bold truncate max-w-full">
            {currentTrack.title}
          </span>
          <span className="text-th-text-muted text-[16px] truncate max-w-full">
            {currentTrack.artist?.name || "Unknown Artist"}
          </span>
        </div>

        {/* Favorite + context menu */}
        <div className="flex items-center gap-3">
          <button
            onClick={toggleLike}
            className={`transition-[color,transform] duration-200 active:scale-90 ${
              isLiked ? "text-th-accent" : "text-th-text-faint hover:text-white"
            }`}
          >
            <Heart
              size={22}
              fill={isLiked ? "currentColor" : "none"}
              strokeWidth={isLiked ? 0 : 2}
            />
          </button>
          <button
            ref={contextMenuAnchorRef}
            onClick={() => setContextMenuTrack(currentTrack)}
            className="text-th-text-faint hover:text-white transition-colors duration-150"
          >
            <MoreHorizontal size={22} />
          </button>
        </div>
      </div>

      {/* Context menu */}
      {contextMenuTrack && (
        <TrackContextMenu
          track={contextMenuTrack}
          index={0}
          anchorRef={contextMenuAnchorRef}
          onClose={() => setContextMenuTrack(null)}
        />
      )}

      {/* Bottom bar — memo'd to isolate transport atom subscriptions */}
      <MaxTransportBar
        currentTrack={currentTrack}
        controlsVisible={controlsVisible}
        isDraggingRef={isDraggingRef}
        resetHideTimer={resetHideTimer}
        setMaximized={setMaximized}
      />
    </div>
  );
}
