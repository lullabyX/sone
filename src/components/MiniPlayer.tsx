import { useState, useEffect, useRef, useCallback, type RefObject } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Heart,
  Shuffle,
  Repeat,
  X,
  Share2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useMiniplayerBridge } from "../hooks/useMiniplayerBridge";
import { getTidalImageUrl, getTrackDisplayTitle } from "../types";
import { formatTime } from "../lib/format";
import TidalImage from "./TidalImage";
import ResizeEdges from "./ResizeEdges";

// ─── Types ──────────────────────────────────────────────────────────────────

type Tier = "narrow" | "compact" | "full";

interface VibrantColors {
  bg: string;
  bgRgba: string;
  overlay: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  isDark: boolean;
}

// ─── useTier ────────────────────────────────────────────────────────────────

function useTier(ref: RefObject<HTMLDivElement | null>): { tier: Tier; width: number; height: number } {
  const [state, setState] = useState<{ tier: Tier; width: number; height: number }>({
    tier: "full", width: 300, height: 120,
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;

      let tier: Tier;
      if (height < 100) {
        tier = "narrow";
      } else if (height < 220) {
        tier = "compact";
      } else {
        tier = "full";
      }
      setState({ tier, width, height });
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return state;
}

// ─── useVibrantColors ───────────────────────────────────────────────────────

function parseHex(hex: string): [number, number, number] | null {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function useVibrantColors(vibrantColor?: string): VibrantColors {
  if (!vibrantColor) {
    return {
      bg: "#0a0a0a",
      bgRgba: "rgba(26,26,26,0.3)",
      overlay: "rgba(0,0,0,0.15)",
      textPrimary: "#ffffff",
      textSecondary: "rgba(255,255,255,0.7)",
      textMuted: "rgba(255,255,255,0.5)",
      isDark: true,
    };
  }

  const rgb = parseHex(vibrantColor);
  if (!rgb) {
    return {
      bg: "#0a0a0a",
      bgRgba: "rgba(26,26,26,0.3)",
      overlay: "rgba(0,0,0,0.15)",
      textPrimary: "#ffffff",
      textSecondary: "rgba(255,255,255,0.7)",
      textMuted: "rgba(255,255,255,0.5)",
      isDark: true,
    };
  }

  const [r, g, b] = rgb;
  const luminance = (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255;
  const isDark = luminance < 0.6;

  return {
    bg: "#0a0a0a",
    bgRgba: `rgba(${r},${g},${b},0.3)`,
    overlay: isDark ? "rgba(0,0,0,0.15)" : "rgba(0,0,0,0.05)",
    textPrimary: "#ffffff",
    textSecondary: "rgba(255,255,255,0.7)",
    textMuted: "rgba(255,255,255,0.5)",
    isDark,
  };
}

// ─── DragHandle ─────────────────────────────────────────────────────────────

function DragHandle({ tier }: { tier: Tier }) {
  const dotColor = "rgba(255,255,255,0.5)";
  const isNarrow = tier === "narrow";

  if (isNarrow) {
    return (
      <div
        data-tauri-drag-region
        className="absolute top-0 left-0 bottom-0 z-10 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ width: 20 }}
      >
        <div data-tauri-drag-region className="grid grid-cols-2 grid-rows-3 gap-[2px]">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              data-tauri-drag-region
              className="w-[3px] h-[3px] rounded-full"
              style={{ backgroundColor: dotColor }}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      data-tauri-drag-region
      className="absolute top-0 left-0 right-0 z-10 flex justify-center items-center opacity-0 group-hover:opacity-100 transition-opacity"
      style={{ height: 16 }}
    >
      <div data-tauri-drag-region className="grid grid-cols-3 gap-[2px]">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            data-tauri-drag-region
            className="w-[3px] h-[3px] rounded-full"
            style={{ backgroundColor: dotColor }}
          />
        ))}
      </div>
    </div>
  );
}

// ─── CloseButton ────────────────────────────────────────────────────────────

function CloseButton({ tier, colors }: { tier: Tier; colors: VibrantColors }) {
  const isNarrow = tier === "narrow";

  return (
    <button
      onClick={() => getCurrentWindow().close()}
      className={`absolute z-20 w-5 h-5 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity ${
        isNarrow ? "top-1 left-0.5" : "top-1 left-1.5"
      }`}
      style={{
        backgroundColor: colors.isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.1)",
        color: colors.textPrimary,
      }}
    >
      <X size={11} strokeWidth={2.5} />
    </button>
  );
}

// ─── FavoriteButton ─────────────────────────────────────────────────────────

function FavoriteButton({
  isFavorite,
  onClick,
  colors,
  accentColor,
  size = 16,
}: {
  isFavorite: boolean;
  onClick: () => void;
  colors: VibrantColors;
  accentColor: string;
  size?: number;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-center transition-[color,transform] duration-200 active:scale-90 flex-shrink-0"
      style={{
        color: isFavorite ? accentColor : colors.textSecondary,
      }}
    >
      <Heart size={size} fill={isFavorite ? "currentColor" : "none"} strokeWidth={isFavorite ? 0 : 2} />
    </button>
  );
}

// ─── AlbumArt ───────────────────────────────────────────────────────────────

function AlbumArt({
  cover,
  title,
  className,
  style,
  imageSize,
  onClick,
}: {
  cover?: string;
  title: string;
  className?: string;
  style?: React.CSSProperties;
  imageSize: number;
  onClick?: () => void;
}) {
  return (
    <div className={`overflow-hidden ${className ?? ""}`} style={style} onClick={onClick}>
      <TidalImage
        src={getTidalImageUrl(cover, imageSize)}
        alt={title}
        className="w-full h-full object-cover"
      />
    </div>
  );
}

// ─── ArtOverlayControls ─────────────────────────────────────────────────────

function ArtOverlayControls({
  isPlaying,
  sendCommand,
  full,
}: {
  isPlaying: boolean;
  sendCommand: (action: string, value?: number) => void;
  full?: {
    shuffle: boolean;
    repeat: number;
    volume: number;
    sendVolume: (vol: number) => void;
    colors: VibrantColors;
    accentColor: string;
  };
}) {
  const [showVolume, setShowVolume] = useState(false);

  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center opacity-0 hover:opacity-100 transition-opacity duration-200 rounded-lg"
      style={{ background: full
        ? `linear-gradient(rgba(0,0,0,0.55), rgba(0,0,0,0.55)), ${full.colors.bgRgba.replace(/[\d.]+\)$/, "0.4)")}`
        : "rgba(0,0,0,0.6)"
      }}
    >
      {/* Primary transport */}
      <div className="flex items-center justify-center gap-6">
        <button
          onClick={(e) => { e.stopPropagation(); sendCommand("play-previous"); }}
          className="w-9 h-9 flex items-center justify-center text-white/80 hover:text-white transition-colors"
        >
          <SkipBack size={20} fill="currentColor" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); sendCommand("toggle-play"); }}
          className="w-12 h-12 rounded-full flex items-center justify-center bg-white/20 hover:bg-white/30 text-white transition-colors backdrop-blur-sm"
        >
          {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" style={{ marginLeft: 2 }} />}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); sendCommand("play-next"); }}
          className="w-9 h-9 flex items-center justify-center text-white/80 hover:text-white transition-colors"
        >
          <SkipForward size={20} fill="currentColor" />
        </button>
      </div>
      {/* Secondary controls — only in full tier */}
      {full && (
        <div className="flex items-center justify-center gap-4 mt-3">
          <div className="relative">
            <button
              onClick={(e) => { e.stopPropagation(); setShowVolume((v) => !v); }}
              className="w-9 h-9 flex items-center justify-center text-white/70 hover:text-white transition-colors"
            >
              {full.volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
            </button>
            {showVolume && (
              <VolumeSlider volume={full.volume} sendVolume={full.sendVolume} colors={full.colors} horizontal={false} onClose={() => setShowVolume(false)} />
            )}
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); sendCommand("toggle-shuffle"); }}
            className={`w-9 h-9 flex items-center justify-center transition-colors ${full.shuffle ? "" : "text-white/70 hover:text-white"}`}
            style={full.shuffle ? { color: full.accentColor } : undefined}
          >
            <Shuffle size={20} strokeWidth={2} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); sendCommand("cycle-repeat"); }}
            className={`w-9 h-9 flex items-center justify-center transition-colors relative ${full.repeat > 0 ? "" : "text-white/70 hover:text-white"}`}
            style={full.repeat > 0 ? { color: full.accentColor } : undefined}
          >
            <Repeat size={20} strokeWidth={2} />
            {full.repeat === 2 && (
              <span
                className="absolute -top-0.5 -right-0.5 text-[8px] font-bold rounded-full w-3.5 h-3.5 flex items-center justify-center leading-none"
                style={{ backgroundColor: full.accentColor, color: full.colors.bg }}
              >
                1
              </span>
            )}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); sendCommand("share"); }}
            className="w-9 h-9 flex items-center justify-center text-white/70 hover:text-white transition-colors"
          >
            <Share2 size={20} />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── VolumeSlider ───────────────────────────────────────────────────────────

function VolumeSlider({
  volume,
  sendVolume,
  colors,
  horizontal,
  onClose,
}: {
  volume: number;
  sendVolume: (vol: number) => void;
  colors: VibrantColors;
  horizontal: boolean;
  onClose: () => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [localVol, setLocalVol] = useState(volume);
  const isDragging = useRef(false);

  // Sync local vol from prop when not dragging
  useEffect(() => {
    if (!isDragging.current) setLocalVol(volume);
  }, [volume]);

  const getVolFromEvent = useCallback(
    (clientX: number, clientY: number) => {
      const el = barRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      if (horizontal) {
        return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      }
      return Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
    },
    [horizontal],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      isDragging.current = true;
      const vol = getVolFromEvent(e.clientX, e.clientY);
      setLocalVol(vol);
      sendVolume(vol);
    },
    [getVolFromEvent, sendVolume],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging.current) return;
      const vol = getVolFromEvent(e.clientX, e.clientY);
      setLocalVol(vol);
      sendVolume(vol);
    },
    [getVolFromEvent, sendVolume],
  );

  const handlePointerUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  const trackColor = "rgba(255,255,255,0.2)";
  const fillColor = colors.textSecondary;

  if (horizontal) {
    return (
      <div
        className="absolute left-full top-1/2 -translate-y-1/2 ml-1 rounded-lg px-3 py-2 flex items-center z-30"
        style={{ backgroundColor: "rgba(30,30,30,0.95)" }}
        onMouseLeave={onClose}
      >
        <div
          ref={barRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className="h-[6px] rounded-full relative cursor-pointer flex items-center"
          style={{ width: 80, backgroundColor: trackColor }}
        >
          <div
            className="absolute left-0 top-0 h-full rounded-full"
            style={{ width: `${localVol * 100}%`, backgroundColor: fillColor }}
          />
          <div
            className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full shadow-md"
            style={{ left: `calc(${localVol * 100}% - 6px)`, backgroundColor: "#fff" }}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 rounded-lg px-2 py-3 flex flex-col items-center z-30"
      style={{ backgroundColor: "rgba(30,30,30,0.95)" }}
      onMouseLeave={onClose}
    >
      <div
        ref={barRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="w-[6px] rounded-full relative cursor-pointer flex justify-center"
        style={{ height: 80, backgroundColor: trackColor }}
      >
        <div
          className="absolute bottom-0 left-0 w-full rounded-full"
          style={{ height: `${localVol * 100}%`, backgroundColor: fillColor }}
        />
        <div
          className="absolute left-1/2 -translate-x-1/2 w-3 h-3 rounded-full shadow-md"
          style={{ bottom: `calc(${localVol * 100}% - 6px)`, backgroundColor: "#fff" }}
        />
      </div>
    </div>
  );
}

// ─── ProgressBar ────────────────────────────────────────────────────────────

function ProgressBar({
  displayPosition,
  duration,
  sendCommand,
  colors,
}: {
  displayPosition: number;
  duration: number;
  sendCommand: (action: string, value?: number) => void;
  colors: VibrantColors;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragProgress, setDragProgress] = useState(0);

  const getProgressFromMouse = useCallback(
    (clientX: number) => {
      const el = barRef.current;
      if (!el || duration <= 0) return 0;
      const rect = el.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    },
    [duration],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const progress = getProgressFromMouse(e.clientX);
      setDragProgress(progress);
      setIsDragging(true);

      const handleMouseMove = (ev: MouseEvent) => {
        setDragProgress(getProgressFromMouse(ev.clientX));
      };

      const handleMouseUp = (ev: MouseEvent) => {
        const finalProgress = getProgressFromMouse(ev.clientX);
        sendCommand("seek", finalProgress * duration);
        setIsDragging(false);
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [getProgressFromMouse, duration, sendCommand],
  );

  const progress = isDragging
    ? dragProgress
    : duration > 0
      ? Math.min(1, displayPosition / duration)
      : 0;

  const currentTime = isDragging ? dragProgress * duration : displayPosition;

  const trackColor = colors.isDark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.15)";
  const fillColor = colors.textPrimary;

  return (
    <div className="w-full flex items-center gap-2">
      <span
        className="min-w-[34px] text-right text-[11px] tabular-nums select-none"
        style={{ color: colors.textMuted }}
      >
        {formatTime(currentTime)}
      </span>
      <div
        ref={barRef}
        onMouseDown={handleMouseDown}
        className="flex-1 relative cursor-pointer h-[14px] flex items-center"
      >
        <div className="relative w-full h-[4px] rounded-full" style={{ backgroundColor: trackColor }}>
          <div
            className="absolute left-0 top-0 h-full rounded-full"
            style={{
              width: `${progress * 100}%`,
              backgroundColor: fillColor,
            }}
          />
        </div>
        {isDragging && (
          <div
            className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full shadow-md pointer-events-none"
            style={{
              left: `calc(${progress * 100}% - 5px)`,
              backgroundColor: fillColor,
            }}
          />
        )}
      </div>
      <span
        className="min-w-[34px] text-[11px] tabular-nums select-none"
        style={{ color: colors.textMuted }}
      >
        {formatTime(duration)}
      </span>
    </div>
  );
}

// ─── NarrowTier ─────────────────────────────────────────────────────────────

function NarrowTier({
  track,
  isPlaying,
  isFavorite,
  shuffle,
  repeat,
  volume,
  sendCommand,
  sendVolume,
  colors,
  accentColor,
  containerWidth,
}: {
  track: ReturnType<typeof useMiniplayerBridge>["state"]["track"];
  isPlaying: boolean;
  isFavorite: boolean;
  shuffle: boolean;
  repeat: number;
  volume: number;
  sendCommand: (action: string, value?: number) => void;
  sendVolume: (vol: number) => void;
  colors: VibrantColors;
  accentColor: string;
  containerWidth: number;
}) {
  const title = track ? getTrackDisplayTitle(track) : "";
  const artistName = track?.artist?.name ?? "";
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);

  // Progressive controls based on width — hide order: share, shuffle, repeat, volume, prev, next
  const showNext = containerWidth >= 260;
  const showPrev = containerWidth >= 300;
  const showVolume = containerWidth >= 370;
  const showRepeat = containerWidth >= 420;
  const showShuffle = containerWidth >= 470;
  const showShare = containerWidth >= 520;

  return (
    <div className="flex items-center gap-1.5 w-full h-full p-1.5" style={{ containerType: "size" }}>
      <AlbumArt
        cover={track?.album?.cover}
        title={title}
        className="rounded-md flex-shrink-0"
        style={{ width: "min(100cqh, 30cqw)", height: "min(100cqh, 30cqw)" }}
        imageSize={160}
      />
      <div className="flex flex-col justify-center min-w-0 flex-1">
        <span
          className="text-[12px] font-bold truncate leading-tight cursor-pointer hover:underline hover:!text-white w-fit max-w-full"
          style={{ color: colors.textPrimary }}
          onClick={() => sendCommand("focus-main")}
        >
          {title}
        </span>
        <span
          className="text-[11px] truncate mt-0.5 cursor-pointer hover:underline hover:!text-white w-fit max-w-full"
          style={{ color: colors.textSecondary }}
          onClick={() => sendCommand("show-artist")}
        >
          {artistName}
        </span>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <FavoriteButton
          isFavorite={isFavorite}
          onClick={() => sendCommand("toggle-favorite")}
          colors={colors}
          accentColor={accentColor}
          size={18}
        />
        {showVolume && (
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setShowVolumeSlider((v) => !v)}
              className="w-8 h-8 flex items-center justify-center transition-colors"
              style={{ color: colors.textSecondary }}
            >
              {volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            {showVolumeSlider && (
              <VolumeSlider volume={volume} sendVolume={sendVolume} colors={colors} horizontal={true} onClose={() => setShowVolumeSlider(false)} />
            )}
          </div>
        )}
        {showShuffle && (
          <button
            onClick={() => sendCommand("toggle-shuffle")}
            className="w-8 h-8 flex items-center justify-center transition-colors flex-shrink-0"
            style={{ color: shuffle ? accentColor : colors.textSecondary }}
          >
            <Shuffle size={18} strokeWidth={2} />
          </button>
        )}
        {showPrev && (
          <button
            onClick={() => sendCommand("play-previous")}
            className="w-8 h-8 flex items-center justify-center transition-colors flex-shrink-0"
            style={{ color: colors.textSecondary }}
          >
            <SkipBack size={18} fill="currentColor" />
          </button>
        )}
        <button
          onClick={() => sendCommand("toggle-play")}
          className="w-8 h-8 rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-transform flex-shrink-0"
          style={{ backgroundColor: colors.textPrimary, color: colors.bg }}
        >
          {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" style={{ marginLeft: 1 }} />}
        </button>
        {showNext && (
          <button
            onClick={() => sendCommand("play-next")}
            className="w-8 h-8 flex items-center justify-center transition-colors flex-shrink-0"
            style={{ color: colors.textSecondary }}
          >
            <SkipForward size={18} fill="currentColor" />
          </button>
        )}
        {showRepeat && (
          <button
            onClick={() => sendCommand("cycle-repeat")}
            className="w-8 h-8 flex items-center justify-center transition-colors relative flex-shrink-0"
            style={{ color: repeat > 0 ? accentColor : colors.textSecondary }}
          >
            <Repeat size={18} strokeWidth={2} />
          </button>
        )}
        {showShare && (
          <button
            onClick={() => sendCommand("share")}
            className="w-8 h-8 flex items-center justify-center transition-colors flex-shrink-0"
            style={{ color: colors.textSecondary }}
          >
            <Share2 size={18} />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── CompactTier ────────────────────────────────────────────────────────────

function CompactTier({
  track,
  isPlaying,
  isFavorite,
  shuffle,
  repeat,
  volume,
  playbackSourceLabel,
  sendCommand,
  sendVolume,
  colors,
  accentColor,
  containerHeight,
  containerWidth,
}: {
  track: ReturnType<typeof useMiniplayerBridge>["state"]["track"];
  isPlaying: boolean;
  isFavorite: boolean;
  shuffle: boolean;
  repeat: number;
  volume: number;
  playbackSourceLabel: { type: string; name: string } | null;
  sendCommand: (action: string, value?: number) => void;
  sendVolume: (vol: number) => void;
  colors: VibrantColors;
  accentColor: string;
  containerHeight: number;
  containerWidth: number;
}) {
  const title = track ? getTrackDisplayTitle(track) : "";
  const artistName = track?.artist?.name ?? "";
  const [showVolume, setShowVolume] = useState(false);
  const showPlayingFrom = containerHeight >= 130 && playbackSourceLabel;
  const showCompactVolume = containerWidth >= 300;
  const showCompactShare = containerWidth >= 300;

  return (
    <div className="flex flex-col w-full h-full p-2 pb-3 gap-1.5">
      {/* Row 1: Art + Info + Fav */}
      <div className="flex items-center gap-2.5 min-w-0 min-h-0 flex-1" style={{ containerType: "size" }}>
        <AlbumArt
          cover={track?.album?.cover}
          title={title}
          className="rounded-md flex-shrink-0"
          style={{ width: "min(100cqh, 40cqw)", height: "min(100cqh, 40cqw)" }}
          imageSize={320}
        />
        <div className="flex flex-col justify-center min-w-0 flex-1">
          <span
            className="text-[15px] font-bold truncate leading-tight cursor-pointer hover:underline hover:!text-white w-fit max-w-full"
            style={{ color: colors.textPrimary }}
            onClick={() => sendCommand("focus-main")}
          >
            {title}
          </span>
          <span
            className="text-[13px] truncate mt-0.5 cursor-pointer hover:underline hover:!text-white w-fit max-w-full"
            style={{ color: colors.textSecondary }}
            onClick={() => sendCommand("show-artist")}
          >
            {artistName}
          </span>
          {showPlayingFrom && (
            <span
              className="text-[11px] truncate mt-0.5 cursor-pointer hover:underline hover:!text-white w-fit max-w-full"
              style={{ color: colors.textMuted }}
              onClick={() => sendCommand("show-source")}
            >
              Playing from {playbackSourceLabel.name}
            </span>
          )}
        </div>
        <FavoriteButton
          isFavorite={isFavorite}
          onClick={() => sendCommand("toggle-favorite")}
          colors={colors}
          accentColor={accentColor}
          size={18}
        />
      </div>

      {/* Row 2: Controls */}
      <div className="flex items-center justify-center gap-2.5 flex-shrink-0">
        {showCompactVolume && (
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setShowVolume((v) => !v)}
              className="w-8 h-8 flex items-center justify-center transition-colors"
              style={{ color: colors.textSecondary }}
            >
              {volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            {showVolume && (
              <VolumeSlider volume={volume} sendVolume={sendVolume} colors={colors} horizontal={containerHeight < 180} onClose={() => setShowVolume(false)} />
            )}
          </div>
        )}
        <button
          onClick={() => sendCommand("toggle-shuffle")}
          className="w-8 h-8 flex items-center justify-center transition-colors flex-shrink-0"
          style={{ color: shuffle ? accentColor : colors.textSecondary }}
        >
          <Shuffle size={18} strokeWidth={2} />
        </button>
        <button
          onClick={() => sendCommand("play-previous")}
          className="w-8 h-8 flex items-center justify-center transition-colors flex-shrink-0"
          style={{ color: colors.textSecondary }}
        >
          <SkipBack size={18} fill="currentColor" />
        </button>
        <button
          onClick={() => sendCommand("toggle-play")}
          className="w-8 h-8 rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-transform flex-shrink-0"
          style={{ backgroundColor: colors.textPrimary, color: colors.bg }}
        >
          {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" style={{ marginLeft: 1 }} />}
        </button>
        <button
          onClick={() => sendCommand("play-next")}
          className="w-8 h-8 flex items-center justify-center transition-colors flex-shrink-0"
          style={{ color: colors.textSecondary }}
        >
          <SkipForward size={18} fill="currentColor" />
        </button>
        <button
          onClick={() => sendCommand("cycle-repeat")}
          className="w-8 h-8 flex items-center justify-center transition-colors relative flex-shrink-0"
          style={{ color: repeat > 0 ? accentColor : colors.textSecondary }}
        >
          <Repeat size={18} strokeWidth={2} />
          {repeat === 2 && (
            <span
              className="absolute -top-0.5 -right-0.5 text-[7px] font-bold rounded-full w-2.5 h-2.5 flex items-center justify-center leading-none"
              style={{ backgroundColor: accentColor, color: colors.bg }}
            >
              1
            </span>
          )}
        </button>
        {showCompactShare && (
          <button
            onClick={() => sendCommand("share")}
            className="w-8 h-8 flex items-center justify-center transition-colors flex-shrink-0"
            style={{ color: colors.textSecondary }}
          >
            <Share2 size={18} />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── FullTier ───────────────────────────────────────────────────────────────

function FullTier({
  track,
  isPlaying,
  isFavorite,
  shuffle,
  repeat,
  volume,
  displayPosition,
  duration,
  playbackSourceLabel,
  sendCommand,
  sendVolume,
  colors,
  accentColor,
}: {
  track: ReturnType<typeof useMiniplayerBridge>["state"]["track"];
  isPlaying: boolean;
  isFavorite: boolean;
  shuffle: boolean;
  repeat: number;
  volume: number;
  displayPosition: number;
  duration: number;
  playbackSourceLabel: { type: string; name: string } | null;
  sendCommand: (action: string, value?: number) => void;
  sendVolume: (vol: number) => void;
  colors: VibrantColors;
  accentColor: string;
}) {
  const title = track ? getTrackDisplayTitle(track) : "";
  const artistName = track?.artist?.name ?? "";

  return (
    <div className="flex flex-col w-full h-full p-2 min-h-0">
      {/* Album art — always square, sized to fit */}
      <div
        className="flex-1 min-h-0 min-w-0 flex items-center justify-center relative"
        style={{ containerType: "size" }}
      >
        <div
          className="rounded-lg overflow-hidden cursor-pointer"
          style={{ width: "min(100cqw, 100cqh)", height: "min(100cqw, 100cqh)" }}
          onClick={() => sendCommand("focus-main")}
        >
          <TidalImage
            src={getTidalImageUrl(track?.album?.cover, 640)}
            alt={title}
            className="w-full h-full object-cover"
          />
        </div>
        <ArtOverlayControls
          isPlaying={isPlaying}
          sendCommand={sendCommand}
          full={{ shuffle, repeat, volume, sendVolume, colors, accentColor }}
        />
      </div>

      {/* Progress bar — visible on hover */}
      <div className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200 mt-2">
        <ProgressBar
          displayPosition={displayPosition}
          duration={duration}
          sendCommand={sendCommand}
          colors={colors}
        />
      </div>

      {/* Track info + fav */}
      <div className="flex items-start gap-2 mt-1.5 min-w-0 flex-shrink-0">
        <div className="flex flex-col min-w-0 flex-1">
          <span
            className="text-[18px] font-bold truncate leading-tight cursor-pointer hover:underline hover:!text-white w-fit max-w-full"
            style={{ color: colors.textPrimary }}
            onClick={() => sendCommand("focus-main")}
          >
            {title}
          </span>
          <span
            className="text-[14px] truncate mt-0.5 cursor-pointer hover:underline hover:!text-white w-fit max-w-full"
            style={{ color: colors.textSecondary }}
            onClick={() => sendCommand("show-artist")}
          >
            {artistName}
          </span>
          {playbackSourceLabel && (
            <span
              className="text-[12px] truncate mt-0.5 cursor-pointer hover:underline hover:!text-white w-fit max-w-full"
              style={{ color: colors.textMuted }}
              onClick={() => sendCommand("show-source")}
            >
              Playing from {playbackSourceLabel.name}
            </span>
          )}
        </div>
        <FavoriteButton
          isFavorite={isFavorite}
          onClick={() => sendCommand("toggle-favorite")}
          colors={colors}
          accentColor={accentColor}
          size={20}
        />
      </div>
    </div>
  );
}

// ─── ErrorOverlay ───────────────────────────────────────────────────────────

function ErrorOverlay({ error }: { error?: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (error) {
      setVisible(true);
      const timer = setTimeout(() => setVisible(false), 4000);
      return () => clearTimeout(timer);
    }
    setVisible(false);
  }, [error]);

  if (!visible || !error) return null;

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
      <div className="bg-red-900/70 text-white text-[11px] px-3 py-1.5 rounded-md max-w-[90%] truncate">
        {error}
      </div>
    </div>
  );
}

// ─── MiniPlayer ─────────────────────────────────────────────────────────────

export default function MiniPlayer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { tier, width, height } = useTier(containerRef);
  const { state, displayPosition, isPlaying, sendCommand, sendVolume } = useMiniplayerBridge();
  const colors = useVibrantColors(state.track?.album?.vibrantColor);

  // Crossfade on tier change
  const [opacity, setOpacity] = useState(1);
  const prevTierRef = useRef(tier);

  useEffect(() => {
    if (prevTierRef.current !== tier) {
      prevTierRef.current = tier;
      setOpacity(0);
      const timer = setTimeout(() => setOpacity(1), 30);
      return () => clearTimeout(timer);
    }
  }, [tier]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      switch (e.code) {
        case "Space":
          e.preventDefault();
          sendCommand("toggle-play");
          break;
        case "ArrowRight":
          e.preventDefault();
          sendCommand("play-next");
          break;
        case "ArrowLeft":
          e.preventDefault();
          sendCommand("play-previous");
          break;
        case "Escape":
          getCurrentWindow().close();
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sendCommand]);

  const renderTier = () => {
    switch (tier) {
      case "narrow":
        return (
          <NarrowTier
            track={state.track}
            isPlaying={isPlaying}
            isFavorite={state.isFavorite}
            shuffle={state.shuffle}
            repeat={state.repeat}
            volume={state.volume}
            sendCommand={sendCommand}
            sendVolume={sendVolume}
            colors={colors}
            accentColor={state.accentColor}
            containerWidth={width}
          />
        );
      case "compact":
        return (
          <CompactTier
            track={state.track}
            isPlaying={isPlaying}
            isFavorite={state.isFavorite}
            shuffle={state.shuffle}
            repeat={state.repeat}
            volume={state.volume}
            playbackSourceLabel={state.playbackSourceLabel}
            sendCommand={sendCommand}
            sendVolume={sendVolume}
            colors={colors}
            accentColor={state.accentColor}
            containerHeight={height}
            containerWidth={width}
          />
        );
      case "full":
        return (
          <FullTier
            track={state.track}
            isPlaying={isPlaying}
            isFavorite={state.isFavorite}
            shuffle={state.shuffle}
            repeat={state.repeat}
            volume={state.volume}
            displayPosition={displayPosition}
            duration={state.duration}
            playbackSourceLabel={state.playbackSourceLabel}
            sendCommand={sendCommand}
            sendVolume={sendVolume}
            colors={colors}
            accentColor={state.accentColor}
          />
        );
    }
  };

  return (
    <div
      ref={containerRef}
      className="group w-full h-full overflow-hidden relative"
      style={{ borderRadius: 6 }}
    >
      <ResizeEdges />
      {/* Dark base background */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ backgroundColor: colors.bg }}
      />
      {/* Vibrant color at 50% opacity */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundColor: colors.bgRgba,
          transition: "background-color 500ms ease",
        }}
      />
      {/* Overlay */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ backgroundColor: colors.overlay }}
      />

      {/* Drag region + close */}
      <DragHandle tier={tier} />
      <CloseButton tier={tier} colors={colors} />

      {/* Error */}
      <ErrorOverlay error={state.error} />

      {/* Content with crossfade + hover padding */}
      <div
        className={`relative z-0 w-full h-full ${
          tier === "narrow"
            ? "pl-0 group-hover:pl-[20px]"
            : "pt-0 group-hover:pt-[16px]"
        }`}
        style={{
          opacity,
          transition: "opacity 150ms ease, padding 200ms ease",
        }}
      >
        {renderTier()}
      </div>
    </div>
  );
}
