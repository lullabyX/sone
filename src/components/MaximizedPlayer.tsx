import {
  Heart,
  MoreHorizontal,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Repeat,
  Shuffle,
  Volume2,
  VolumeX,
  Volume1,
  Minimize2,
  Infinity as InfinityIcon,
} from "lucide-react";
import { useState, useEffect, useRef, useCallback, memo } from "react";
import { useAtomValue, useSetAtom, useAtom } from "jotai";
import {
  currentTrackAtom,
  isPlayingAtom,
  volumeAtom,
  streamInfoAtom,
  autoplayAtom,
  bitPerfectAtom,
  repeatAtom,
  shuffleAtom,
} from "../atoms/playback";
import { favoriteTrackIdsAtom } from "../atoms/favorites";
import { maximizedPlayerAtom } from "../atoms/ui";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useFavorites } from "../hooks/useFavorites";
import { getTidalImageUrl } from "../types";
import TidalImage from "./TidalImage";
import CrossfadeTidalImage from "./CrossfadeTidalImage";
import TrackContextMenu from "./TrackContextMenu";

// ─── MaxProgressScrubber ──────────────────────────────────────────────────

const MaxProgressScrubber = memo(function MaxProgressScrubber() {
  const currentTrack = useAtomValue(currentTrackAtom);
  const isPlaying = useAtomValue(isPlayingAtom);
  const { getPlaybackPosition, seekTo } = usePlaybackActions();

  const [currentTime, setCurrentTime] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragTime, setDragTime] = useState(0);
  const [isHoveringProgress, setIsHoveringProgress] = useState(false);
  const progressRef = useRef<HTMLDivElement>(null);
  const seekGuardUntil = useRef(0);

  useEffect(() => {
    if (!isPlaying || !currentTrack || isDragging) return;

    const syncPosition = async () => {
      if (Date.now() < seekGuardUntil.current) return;
      const pos = await getPlaybackPosition();
      setCurrentTime(pos);
    };

    syncPosition();
    const interval = setInterval(syncPosition, 500);
    return () => clearInterval(interval);
  }, [isPlaying, currentTrack, isDragging, getPlaybackPosition]);

  useEffect(() => {
    setCurrentTime(0);
  }, [currentTrack?.id]);

  const duration = currentTrack?.duration ?? 0;
  const displayTime = isDragging ? dragTime : currentTime;
  const progress = duration > 0 ? (displayTime / duration) * 100 : 0;
  const clampedProgress = Math.min(100, Math.max(0, progress));

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

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
        seekGuardUntil.current = Date.now() + 600;
        await seekTo(finalTime);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [currentTrack, getTimeFromClientX, seekTo],
  );

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

// ─── MaxQualityBadge ──────────────────────────────────────────────────────

const MaxQualityBadge = memo(function MaxQualityBadge() {
  const currentTrack = useAtomValue(currentTrackAtom);
  const streamInfo = useAtomValue(streamInfoAtom);

  const quality = streamInfo?.audioQuality || currentTrack?.audioQuality;
  if (!quality) return null;

  const isMax = quality === "HI_RES_LOSSLESS" || quality === "HI_RES";
  const isHiFi = quality === "LOSSLESS";

  const parts: string[] = [];
  if (streamInfo?.bitDepth) parts.push(`${streamInfo.bitDepth}-BIT`);
  if (streamInfo?.sampleRate) {
    const sr = streamInfo.sampleRate;
    parts.push(
      sr >= 1000
        ? `${(sr / 1000).toFixed(sr % 1000 === 0 ? 0 : 1)}kHz`
        : `${sr}Hz`,
    );
  }
  if (streamInfo?.codec) parts.push(streamInfo.codec);
  const detail = parts.join(" ");

  const label = isMax ? "HI-RES LOSSLESS" : isHiFi ? "LOSSLESS" : "HIGH";

  return (
    <div className="flex flex-col items-end gap-0.5">
      {detail && (
        <span className="text-[9px] text-th-text-faint font-medium tracking-wide inline">
          {detail}
        </span>
      )}
      <span
        className={`px-2 py-0.5 text-[9px] font-black rounded tracking-wider leading-none ${
          isMax
            ? "bg-th-accent text-black"
            : isHiFi
              ? "bg-th-accent/70 text-black"
              : "bg-th-button-hover text-white"
        }`}
      >
        {label}
      </span>
    </div>
  );
});

// ─── MaxVolumeSlider ──────────────────────────────────────────────────────

const MaxVolumeSlider = memo(function MaxVolumeSlider() {
  const volume = useAtomValue(volumeAtom);
  const bitPerfect = useAtomValue(bitPerfectAtom);
  const { setVolume } = usePlaybackActions();

  const displayVolume = bitPerfect ? 1 : volume;

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (bitPerfect) return;
    setVolume(parseFloat(e.target.value));
  };

  const VolumeIcon =
    displayVolume === 0 ? VolumeX : displayVolume < 0.5 ? Volume1 : Volume2;

  return (
    <div
      className={`flex items-center gap-2 group/vol w-[130px] ${bitPerfect ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      <button
        onClick={() => {
          if (bitPerfect) return;
          setVolume(volume > 0 ? 0 : 1);
        }}
        className={`flex-shrink-0 transition-colors duration-150 ${
          bitPerfect
            ? "text-th-text-faint cursor-not-allowed"
            : "text-th-text-secondary hover:text-white"
        }`}
        disabled={bitPerfect}
      >
        <VolumeIcon size={16} strokeWidth={2} />
      </button>
      <div
        className={`flex-1 relative rounded-full ${bitPerfect ? "cursor-not-allowed" : "cursor-pointer"}`}
      >
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={displayVolume}
          onChange={handleVolumeChange}
          disabled={bitPerfect}
          className={`absolute inset-0 w-full h-full opacity-0 z-10 ${bitPerfect ? "cursor-not-allowed" : "cursor-pointer"}`}
        />
        <div className="relative h-[3px] group-hover/vol:h-[4px] transition-[height] duration-100 rounded-full">
          <div className="absolute inset-0 bg-white/[0.12] rounded-full" />
          <div
            className="absolute h-full bg-white/70 group-hover/vol:bg-th-accent rounded-full transition-colors duration-100"
            style={{ width: `${displayVolume * 100}%` }}
          />
          <div
            className="absolute top-1/2 -translate-y-1/2 w-[10px] h-[10px] bg-white rounded-full shadow-sm opacity-0 group-hover/vol:opacity-100 transition-opacity duration-100"
            style={{ left: `calc(${displayVolume * 100}% - 5px)` }}
          />
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
  const { addFavoriteTrack, removeFavoriteTrack } = useFavorites();

  // Context menu state
  const [contextMenuTrack, setContextMenuTrack] = useState<typeof currentTrack | null>(null);
  const contextMenuAnchorRef = useRef<HTMLButtonElement>(null);

  // All hooks MUST be above the early return (Rules of Hooks).
  const isLiked = currentTrack ? favoriteTrackIds.has(currentTrack.id) : false;

  const toggleLike = useCallback(async () => {
    if (!currentTrack) return;
    try {
      if (isLiked) {
        await removeFavoriteTrack(currentTrack.id);
      } else {
        await addFavoriteTrack(currentTrack.id, currentTrack);
      }
    } catch (err) {
      console.error("Failed to toggle track favorite:", err);
    }
  }, [currentTrack, isLiked, addFavoriteTrack, removeFavoriteTrack]);

  // Transport control hooks
  const isPlaying = useAtomValue(isPlayingAtom);
  const [repeatMode, setRepeatMode] = useAtom(repeatAtom);
  const [autoplay, setAutoplay] = useAtom(autoplayAtom);
  const isShuffle = useAtomValue(shuffleAtom);
  const { pauseTrack, resumeTrack, playNext, playPrevious, toggleShuffle } = usePlaybackActions();

  // Reset maximized state when track goes away (queue depleted)
  useEffect(() => {
    if (!currentTrack) setMaximized(false);
  }, [currentTrack, setMaximized]);

  if (!currentTrack) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center select-none bg-black"
    >
      {/* Blurred album art background — 320px source is sufficient under 40px blur */}
      <div className="absolute inset-0 overflow-hidden">
        <CrossfadeTidalImage
          src={getTidalImageUrl(currentTrack.album?.cover, 320)}
          alt=""
          className="w-full h-full scale-110 blur-[40px]"
        />
        <div className="absolute inset-0 bg-black/60" />
      </div>

      {/* Center content */}
      <div className="relative z-10 flex flex-col items-center gap-5">
        {/* Large album art — responsive: 80vmin capped at 400px */}
        <div className="max-w-[400px] w-[80vmin] aspect-square rounded-lg overflow-hidden shadow-2xl shadow-black/60">
          <CrossfadeTidalImage
            src={getTidalImageUrl(currentTrack.album?.cover, 1280)}
            alt={currentTrack.album?.title || currentTrack.title}
            className="w-full h-full"
          />
        </div>

        {/* Track info */}
        <div className="flex flex-col items-center gap-1 max-w-[400px] w-[80vmin]">
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

      {/* Bottom bar — transparent, pinned to bottom */}
      <div className="absolute bottom-0 left-0 right-0 z-20 px-6 pb-4 pt-8 bg-gradient-to-t from-black/60 to-transparent">
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
                onClick={() => setRepeatMode(((repeatMode as number) + 1) % 3)}
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
            <MaxProgressScrubber />
          </div>

          {/* Right: Quality + Volume + Minimize */}
          <div className="flex items-center justify-end gap-4 w-[30%] min-w-[180px]">
            <MaxQualityBadge />
            <MaxVolumeSlider />
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
    </div>
  );
}
