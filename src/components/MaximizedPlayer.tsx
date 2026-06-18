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
  Mic2,
} from "lucide-react";
import { useState, useEffect, useRef, useCallback, memo } from "react";
import { useAtomValue, useSetAtom, useAtom, useStore } from "jotai";
import {
  currentTrackAtom,
  isPlayingAtom,
  repeatAtom,
  shuffleAtom,
} from "../atoms/playback";
import { favoriteTrackIdsAtom } from "../atoms/favorites";
import {
  maximizedPlayerAtom,
  maximizedLyricsAtom,
  videoCoversAtom,
} from "../atoms/ui";
import { authTokensAtom } from "../atoms/auth";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useProgressScrub } from "../hooks/useProgressScrub";
import { getTidalImageUrl, getTrackDisplayTitle } from "../types";
import ExplicitBadge from "./ExplicitBadge";
import TidalImage, { fetchCachedImageUrl } from "./TidalImage";
import TidalVideoCover from "./TidalVideoCover";
import { TiltCover } from "./TiltCover";

import TrackContextMenu from "./TrackContextMenu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { formatTime } from "../lib/format";
import { getInterpolatedPosition } from "../lib/playbackPosition";
import QualityBadge from "./QualityBadge";
import SignalPathPanel from "./SignalPathPanel";
import { getTrackArtistDisplay } from "../utils/itemHelpers";
import VolumeSlider from "./VolumeSlider";
import {
  addTrackToFavoritesCache,
  removeTrackFromFavoritesCache,
  getTrackLyrics,
} from "../api/tidal";
import { parseLrc, type LrcLine } from "../lib/lrc";
import { themeAtom } from "../atoms/theme";

function useThemeContext() {
  const theme = useAtomValue(themeAtom);
  const hex = theme.bgBase.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const isDark = (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255 < 0.5;
  return { isDark, bgBaseRgb: `${r},${g},${b}` };
}

// One separable box-blur pass (horizontal or vertical) over RGBA pixels, using a
// sliding running-sum so cost is O(pixels) regardless of radius. Edges clamped.
function boxBlurPass(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
  horizontal: boolean,
) {
  const div = radius * 2 + 1;
  const lineLen = horizontal ? w : h;
  const lineCount = horizontal ? h : w;
  const stride = horizontal ? 4 : w * 4; // step between pixels along a line
  const lineStep = horizontal ? w * 4 : 4; // step between lines
  const line = new Float32Array(lineLen * 4);
  for (let l = 0; l < lineCount; l++) {
    const base = l * lineStep;
    let sr = 0,
      sg = 0,
      sb = 0,
      sa = 0;
    for (let i = -radius; i <= radius; i++) {
      const p = base + Math.min(lineLen - 1, Math.max(0, i)) * stride;
      sr += data[p];
      sg += data[p + 1];
      sb += data[p + 2];
      sa += data[p + 3];
    }
    for (let x = 0; x < lineLen; x++) {
      line[x * 4] = sr / div;
      line[x * 4 + 1] = sg / div;
      line[x * 4 + 2] = sb / div;
      line[x * 4 + 3] = sa / div;
      const pOut =
        base + Math.min(lineLen - 1, Math.max(0, x - radius)) * stride;
      const pIn =
        base + Math.min(lineLen - 1, Math.max(0, x + radius + 1)) * stride;
      sr += data[pIn] - data[pOut];
      sg += data[pIn + 1] - data[pOut + 1];
      sb += data[pIn + 2] - data[pOut + 2];
      sa += data[pIn + 3] - data[pOut + 3];
    }
    for (let x = 0; x < lineLen; x++) {
      const p = base + x * stride;
      data[p] = line[x * 4];
      data[p + 1] = line[x * 4 + 1];
      data[p + 2] = line[x * 4 + 2];
      data[p + 3] = line[x * 4 + 3];
    }
  }
}

// Dependency-free near-gaussian blur: 3 box passes per axis (central-limit
// theorem ≈ gaussian). Runs ONCE per track, never on the per-frame paint path.
function blurRGBA(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
) {
  if (radius < 1) return;
  for (let pass = 0; pass < 3; pass++) {
    boxBlurPass(data, w, h, radius, true);
    boxBlurPass(data, w, h, radius, false);
  }
}

const BlurredBackground = memo(function BlurredBackground({
  coverUrl,
}: {
  coverUrl: string | undefined;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !coverUrl) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Modest bake resolution: upscaling already-blurred pixels stays smooth, and
    // it keeps the one-time blur cheap so it never hitches playback.
    const cap = 1280;
    const sw = window.innerWidth || 1920;
    const sh = window.innerHeight || 1080;
    const ratio = Math.min(1, cap / Math.max(sw, sh));
    const W = Math.round(sw * ratio);
    const H = Math.round(sh * ratio);
    const radius = Math.max(1, Math.round(40 * (W / sw)));

    let cancelled = false;
    const img = new Image();
    // crossOrigin + cache-bust query: a separate, CORS-clean cache entry the
    // app's non-CORS <img> loads can't poison. Without this, getImageData can
    // throw on a tainted canvas and the blur is silently skipped (sharp bg).
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      // Draw + blur on an OFFSCREEN canvas, then blit the finished result in one
      // step. The visible canvas keeps the previous backdrop until the new one
      // is ready — no black flash on track change.
      const off = document.createElement("canvas");
      off.width = W;
      off.height = H;
      const octx = off.getContext("2d");
      if (!octx) return;
      const scale = Math.max(W / img.width, H / img.height) * 1.1;
      const dw = img.width * scale;
      const dh = img.height * scale;
      octx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      try {
        const id = octx.getImageData(0, 0, W, H);
        blurRGBA(id.data, W, H, radius);
        octx.putImageData(id, 0, 0);
      } catch {
        return; // tainted/failed — keep the previous backdrop rather than black
      }
      if (cancelled) return;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      ctx.drawImage(off, 0, 0);
    };
    img.src = `${getTidalImageUrl(coverUrl, 320)}?blur=1`;
    return () => {
      cancelled = true;
    };
  }, [coverUrl]);
  // A frozen bitmap — no live filter, so each per-frame paint is a cheap blit.
  return <canvas ref={canvasRef} className="w-full h-full object-cover" />;
});

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
          <div className="absolute inset-0 bg-th-slider-track rounded-full" />
          <div
            className={`absolute left-0 rounded-full transition-[height,top,background-color] duration-100 ${
              isHoveringProgress || isDragging
                ? "h-full top-0 bg-th-accent"
                : "h-[3px] top-[1.5px] bg-th-slider-fill"
            }`}
            style={{ width: `${clampedProgress}%` }}
          />
          {!(isHoveringProgress || isDragging) && (
            <div className="absolute inset-0 rounded-full">
              <div className="absolute left-0 right-0 top-0 h-[1px] bg-th-slider-border" />
              <div className="absolute left-0 right-0 bottom-0 h-[1px] bg-th-slider-border" />
            </div>
          )}
        </div>
        <div
          className={`absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 bg-th-text-primary rounded-full shadow-md shadow-black/50 pointer-events-none transition-opacity duration-100 ${
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
  isDark,
  bgBaseRgb,
}: {
  currentTrack: {
    title: string;
    artist?: { name?: string };
    artists?: { name: string }[];
    album?: { cover?: string; title?: string };
    explicit?: boolean;
  };
  controlsVisible: boolean;
  isDraggingRef: React.MutableRefObject<boolean>;
  resetHideTimer: () => void;
  setMaximized: (v: boolean) => void;
  isDark: boolean;
  bgBaseRgb: string;
}) {
  const isPlaying = useAtomValue(isPlayingAtom);
  const [repeatMode, setRepeatMode] = useAtom(repeatAtom);

  const isShuffle = useAtomValue(shuffleAtom);
  const [showLyrics, setShowLyrics] = useAtom(maximizedLyricsAtom);
  const [signalPathOpen, setSignalPathOpen] = useState(false);
  const { pauseTrack, resumeTrack, playNext, playPrevious, toggleShuffle } =
    usePlaybackActions();

  return (
    <div
      className={`absolute bottom-0 left-0 right-0 z-20 px-6 pb-4 pt-8 transition-opacity duration-300 ${controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      style={{
        background: `linear-gradient(to top, rgba(${isDark ? "0,0,0,0.6" : `${bgBaseRgb},0.7`}), transparent)`,
      }}
    >
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
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-th-text-primary text-[13px] font-semibold truncate leading-tight">
                {getTrackDisplayTitle(currentTrack)}
              </span>
              {currentTrack.explicit && <ExplicitBadge />}
            </div>
            <span className="text-th-text-secondary text-[11px] truncate">
              {getTrackArtistDisplay(currentTrack)}
            </span>
          </div>
        </div>

        {/* Center: Transport controls + scrubber */}
        <div className="flex flex-col items-center w-[40%] max-w-[800px] gap-1">
          {/* Transport buttons */}
          <div className="flex items-center gap-4">
            <button
              onClick={toggleShuffle}
              className={`w-8 h-8 flex items-center justify-center rounded-full transition-[color,background-color,transform] duration-200 active:scale-90 relative ${
                isShuffle
                  ? "text-th-accent"
                  : "text-th-text-secondary hover:text-th-text-primary hover:bg-th-border-subtle"
              }`}
            >
              <Shuffle size={15} strokeWidth={2} />
              {isShuffle && (
                <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-th-accent" />
              )}
            </button>
            <button
              onClick={playPrevious}
              className="w-8 h-8 flex items-center justify-center rounded-full text-th-text-secondary hover:text-th-text-primary hover:bg-th-border-subtle transition-[color,background-color,transform] duration-150 active:scale-90"
            >
              <SkipBack size={20} fill="currentColor" />
            </button>
            <button
              onClick={() => (isPlaying ? pauseTrack() : resumeTrack())}
              className="w-10 h-10 bg-th-text-primary rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-transform duration-150"
            >
              {isPlaying ? (
                <Pause size={19} fill="currentColor" className="text-th-base" />
              ) : (
                <Play
                  size={19}
                  fill="currentColor"
                  className="text-th-base ml-0.5"
                />
              )}
            </button>
            <button
              onClick={() => playNext({ explicit: true })}
              className="w-8 h-8 flex items-center justify-center rounded-full text-th-text-secondary hover:text-th-text-primary hover:bg-th-border-subtle transition-[color,background-color,transform] duration-150 active:scale-90"
            >
              <SkipForward size={20} fill="currentColor" />
            </button>
            <button
              onClick={() => setRepeatMode((repeatMode + 1) % 3)}
              className={`w-8 h-8 flex items-center justify-center rounded-full transition-[color,background-color,transform] duration-200 active:scale-90 relative ${
                repeatMode > 0
                  ? "text-th-accent"
                  : "text-th-text-secondary hover:text-th-text-primary hover:bg-th-border-subtle"
              }`}
            >
              <Repeat size={15} strokeWidth={2} />
              {repeatMode === 2 && (
                <span className="absolute -top-0.5 -right-0.5 text-[7px] font-bold bg-th-accent text-th-base rounded-full w-3 h-3 flex items-center justify-center leading-none">
                  1
                </span>
              )}
              {repeatMode > 0 && (
                <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-th-accent" />
              )}
            </button>
          </div>
          <MaxProgressScrubber
            isDraggingRef={isDraggingRef}
            resetHideTimer={resetHideTimer}
          />
        </div>

        {/* Right: Quality + Lyrics toggle + Volume + Minimize */}
        <div className="flex items-center justify-end gap-4 w-[30%] min-w-[180px]">
          <QualityBadge onClick={() => setSignalPathOpen(true)} />
          <SignalPathPanel
            open={signalPathOpen}
            onClose={() => setSignalPathOpen(false)}
          />
          <button
            onClick={() => setShowLyrics((v) => !v)}
            className={`relative transition-[color,transform] duration-150 active:scale-90 ${
              showLyrics
                ? "text-th-accent"
                : "text-th-text-faint hover:text-th-text-primary"
            }`}
            title="Lyrics"
          >
            <Mic2 size={18} strokeWidth={2} />
            {showLyrics && (
              <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-th-accent" />
            )}
          </button>
          <VolumeSlider
            widthClass="w-[130px]"
            isDraggingRef={isDraggingRef}
            onDragEnd={resetHideTimer}
          />
          <button
            onClick={() => setMaximized(false)}
            className="text-th-text-faint hover:text-th-text-primary transition-colors duration-150"
            title="Exit fullscreen"
          >
            <Minimize2 size={18} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
});

// ─── MaximizedLyrics ──────────────────────────────────────────────────────
// All sync updates use direct DOM manipulation — zero React re-renders during playback.

// Responsive tiers: small (<1600px), medium (default), large (≥2560px)
function getLyricsTier() {
  const zoom = parseFloat(document.documentElement.style.zoom || "1");
  const w = window.innerWidth / zoom;
  if (w > 2560) return "lg" as const;
  if (w < 1600) return "sm" as const;
  return "md" as const;
}

type Tier = "sm" | "md" | "lg";

const TIER_CONFIG = {
  sm: {
    lineHeight: 48,
    fontCls: "text-4xl",
    padding: 96,
    gap: 64,
    artSize: "55vmin",
    artSizeSolo: "65vmin",
    artMax: 500,
    titleSize: 20,
    artistSize: 14,
    iconSize: 20,
  },
  md: {
    lineHeight: 80,
    fontCls: "text-6xl",
    padding: 208,
    gap: 160,
    artSize: "70vmin",
    artSizeSolo: "80vmin",
    artMax: 800,
    titleSize: 28,
    artistSize: 18,
    iconSize: 26,
  },
  lg: {
    lineHeight: 112,
    fontCls: "text-8xl",
    padding: 288,
    gap: 224,
    artSize: "75vmin",
    artSizeSolo: "85vmin",
    artMax: 1200,
    titleSize: 38,
    artistSize: 24,
    iconSize: 34,
  },
} as const;

const ACTIVE_CLS = "text-th-text-primary font-black";
const PAST_CLS = "text-th-text-primary opacity-30";
const FUTURE_CLS = "text-th-text-primary opacity-40";

function getLineBaseCls(tier: Tier) {
  return `${TIER_CONFIG[tier].fontCls} font-semibold transition-[color,opacity,transform] duration-500 ease-out origin-left`;
}

function useLyricsTier() {
  const [tier, setTier] = useState<Tier>(getLyricsTier);
  useEffect(() => {
    const update = () => setTier(getLyricsTier());
    window.addEventListener("resize", update);
    // Re-check when zoom changes via MutationObserver on style attribute
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
    return () => {
      window.removeEventListener("resize", update);
      obs.disconnect();
    };
  }, []);
  return tier;
}

const MaximizedLyrics = memo(function MaximizedLyrics({
  tier,
}: {
  tier: Tier;
}) {
  const currentTrack = useAtomValue(currentTrackAtom);
  const isPlaying = useAtomValue(isPlayingAtom);

  const [lrcLines, setLrcLines] = useState<LrcLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasLyrics, setHasLyrics] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  const [isRtl, setIsRtl] = useState(false);
  const activeLineRef = useRef(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const lineEls = useRef<HTMLParagraphElement[]>([]);

  const lh = TIER_CONFIG[tier].lineHeight;
  const baseCls = getLineBaseCls(tier);

  // Re-apply styles when tier changes
  useEffect(() => {
    for (let i = 0; i < lineEls.current.length; i++) {
      const el = lineEls.current[i];
      if (!el) continue;
      const active = i === activeLineRef.current;
      const past = activeLineRef.current >= 0 && i < activeLineRef.current;
      el.className = `${baseCls} ${active ? ACTIVE_CLS : past ? PAST_CLS : FUTURE_CLS}`;
      el.style.lineHeight = `${lh}px`;
    }
    const container = containerRef.current;
    const idx = activeLineRef.current;
    if (container && idx >= 0 && idx < lineEls.current.length) {
      const el = lineEls.current[idx];
      const scrollTarget =
        el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2;
      container.scrollTo({ top: scrollTarget });
    }
  }, [tier, baseCls, lh]);

  // Fetch lyrics on track change
  useEffect(() => {
    if (!currentTrack) return;
    let active = true;
    setLoading(true);
    setLrcLines([]);
    activeLineRef.current = -1;
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
    setHasLyrics(false);
    setProvider(null);
    setIsRtl(false);

    getTrackLyrics(currentTrack.id)
      .then((result) => {
        if (!active) return;
        setProvider(result.lyricsProvider ?? null);
        setIsRtl(result.isRightToLeft ?? false);
        if (result.subtitles) {
          const parsed = parseLrc(result.subtitles);
          if (parsed.length > 0) {
            setLrcLines(parsed);
            setHasLyrics(true);
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [currentTrack?.id]);

  // Sync active line — rAF loop with interpolated position, pure DOM updates
  useEffect(() => {
    if (lrcLines.length === 0 || !isPlaying) return;

    const applyLine = (idx: number) => {
      const prev = activeLineRef.current;
      if (idx === prev) return;

      const els = lineEls.current;
      const container = containerRef.current;

      // Update previous active line
      if (prev >= 0 && prev < els.length) {
        els[prev].className = `${baseCls} ${PAST_CLS}`;
      }

      // Update new active line
      if (idx >= 0 && idx < els.length) {
        els[idx].className = `${baseCls} ${ACTIVE_CLS}`;
      }

      // Scroll active line to center
      if (container && idx >= 0 && idx < els.length) {
        const el = els[idx];
        const scrollTarget =
          el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2;
        container.scrollTo({ top: scrollTarget, behavior: "smooth" });
      }

      activeLineRef.current = idx;
    };

    let rafId: number;
    const tick = () => {
      const pos = getInterpolatedPosition();
      let idx = -1;
      for (let i = lrcLines.length - 1; i >= 0; i--) {
        if (pos >= lrcLines[i].time) {
          idx = i;
          break;
        }
      }
      applyLine(idx);
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [lrcLines, isPlaying, lh, baseCls]);

  if (loading) {
    return (
      <div
        className="relative h-full overflow-hidden"
        style={{
          maskImage:
            "linear-gradient(to bottom, transparent 0%, black 50%, black 80%, transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, transparent 0%, black 50%, black 80%, transparent 100%)",
        }}
      >
        <div className="h-1/2 shrink-0" />
        <div className="flex flex-col items-start">
          {[72, 55, 85, 40, 68, 90, 50].map((w, i) => (
            <div
              key={i}
              className={`${TIER_CONFIG[tier].fontCls} font-semibold animate-pulse rounded`}
              style={{
                width: `${w}%`,
                height: "0.75em",
                lineHeight: `${lh}px`,
                marginBottom: `${lh * 0.25}px`,
                background: "var(--th-hl-med)",
                animationDelay: `${i * 80}ms`,
              }}
            />
          ))}
        </div>
      </div>
    );
  }

  if (!hasLyrics) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-th-text-disabled">
        <Mic2 size={40} className="mb-3" />
        <p className="text-sm">No synced lyrics available</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative h-full overflow-y-auto pointer-events-none no-scrollbar"
      dir={isRtl ? "rtl" : "ltr"}
      style={{
        maskImage:
          "linear-gradient(to bottom, transparent 0%, black 50%, black 80%, transparent 100%)",
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0%, black 50%, black 80%, transparent 100%)",
      }}
    >
      <div className="h-1/2 shrink-0" />
      <div className="flex flex-col items-start">
        {lrcLines.map((line, i) => (
          <p
            key={i}
            ref={(el) => {
              if (el) lineEls.current[i] = el;
            }}
            className={`${baseCls} ${FUTURE_CLS}`}
            style={{ lineHeight: `${lh}px` }}
          >
            {line.text}
          </p>
        ))}
        {provider && (
          <p
            className="text-[11px] text-th-text-primary opacity-20 mt-4"
            style={{ lineHeight: `${lh}px` }}
          >
            Lyrics provided by {provider}
          </p>
        )}
      </div>
      <div className="h-1/2 shrink-0" />
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
  const { isDark, bgBaseRgb } = useThemeContext();

  // Context menu state
  const [contextMenuTrack, setContextMenuTrack] = useState<
    typeof currentTrack | null
  >(null);
  const contextMenuAnchorRef = useRef<HTMLButtonElement>(null);

  // Progressive album art: 160px instantly, upgrade to 1280 when ready
  const coverKey = currentTrack?.album?.cover;
  const videoCovers = useAtomValue(videoCoversAtom);
  const animatedCover = videoCovers && Boolean(currentTrack?.album?.videoCover);
  const [hiResReady, setHiResReady] = useState(false);
  useEffect(() => {
    if (!coverKey) return;
    setHiResReady(false);
    let cancelled = false;
    fetchCachedImageUrl(getTidalImageUrl(coverKey, 1280))
      .then(() => {
        if (!cancelled) setHiResReady(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [coverKey]);

  // All hooks MUST be above the early return (Rules of Hooks).
  const isLiked = currentTrack ? favoriteTrackIds.has(currentTrack.id) : false;
  const showLyrics = useAtomValue(maximizedLyricsAtom);
  const lyricsTier = useLyricsTier();

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
        await invoke("remove_favorite_track", {
          userId,
          trackId: currentTrack.id,
        });
      } else {
        setFavoriteTrackIds(
          (prev: Set<number>) => new Set([...prev, currentTrack.id]),
        );
        addTrackToFavoritesCache(userId, currentTrack);
        await invoke("add_favorite_track", {
          userId,
          trackId: currentTrack.id,
        });
      }
    } catch (err) {
      // Rollback optimistic update
      if (isLiked) {
        setFavoriteTrackIds(
          (prev: Set<number>) => new Set([...prev, currentTrack.id]),
        );
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
  const lastMousePos = useRef({ x: 0, y: 0 });

  const resetHideTimer = useCallback((e?: React.MouseEvent) => {
    // Ignore phantom mousemove from layout shifts / scroll
    if (e) {
      const { clientX, clientY } = e;
      const last = lastMousePos.current;
      if (clientX === last.x && clientY === last.y) return;
      lastMousePos.current = { x: clientX, y: clientY };
    }

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
    return () => {
      appWindow.setFullscreen(false);
    };
  }, []);

  // Inhibit screensaver + system sleep while fullscreen
  useEffect(() => {
    invoke("inhibit_idle").catch(() => {});
    return () => {
      invoke("uninhibit_idle").catch(() => {});
    };
  }, []);

  // Hide miniplayer during fullscreen to avoid always-on-top conflict
  useEffect(() => {
    const wasOpenRef = { current: false };

    (async () => {
      const win = await WebviewWindow.getByLabel("miniplayer");
      if (win) {
        wasOpenRef.current = true;
        await win.hide();
      }
    })();

    return () => {
      if (wasOpenRef.current) {
        WebviewWindow.getByLabel("miniplayer").then((win) => {
          if (win) win.show();
        });
      }
    };
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
      className={`fixed inset-0 z-[9999] flex flex-col items-center justify-center select-none ${controlsVisible ? "cursor-default" : "cursor-none"}`}
      style={{ backgroundColor: isDark ? "#000" : `rgb(${bgBaseRgb})` }}
    >
      {/* Blurred album art background — pre-rendered to canvas once, zero per-frame cost */}
      <div className="absolute inset-0 overflow-hidden">
        <BlurredBackground coverUrl={currentTrack.album?.cover} />
        <div
          className={`absolute inset-0 ${!isDark ? "backdrop-brightness-[1.6] backdrop-saturate-50" : ""}`}
          style={{
            backgroundColor: isDark
              ? "rgba(0,0,0,0.6)"
              : `rgba(${bgBaseRgb},0.45)`,
          }}
        />
      </div>

      {/* Center content — single column (art centered) or two-column (art + lyrics) */}
      <div
        className={`relative z-10 flex items-center ${
          showLyrics ? "w-full" : "flex-col gap-5"
        }`}
        style={
          showLyrics
            ? {
                paddingLeft: TIER_CONFIG[lyricsTier].padding,
                paddingRight: TIER_CONFIG[lyricsTier].padding,
                gap: TIER_CONFIG[lyricsTier].gap,
              }
            : undefined
        }
      >
        {/* Left: album art + track info + actions */}
        <div
          className={`flex flex-col items-center gap-7 ${
            showLyrics ? "flex-shrink-0" : ""
          }`}
        >
          {/* Large album art */}
          <div
            className={`aspect-square rounded-lg transition-[filter] duration-700 ease-out ${
              hiResReady || animatedCover
                ? "shadow-none"
                : "blur-[12px] shadow-2xl shadow-black/60"
            }`}
            style={{
              width: showLyrics
                ? TIER_CONFIG[lyricsTier].artSize
                : TIER_CONFIG[lyricsTier].artSizeSolo,
              maxWidth: TIER_CONFIG[lyricsTier].artMax,
            }}
          >
            {animatedCover ? (
              <TidalVideoCover
                cover={coverKey}
                videoCover={currentTrack.album?.videoCover}
                size={1280}
                imageSize={1280}
                alt={currentTrack.album?.title || currentTrack.title}
                className="aspect-square rounded-lg overflow-hidden"
              />
            ) : (
              <TiltCover className="aspect-square rounded-lg">
                <TidalImage
                  src={getTidalImageUrl(coverKey, hiResReady ? 1280 : 160)}
                  alt={currentTrack.album?.title || currentTrack.title}
                  className="w-full h-full"
                />
              </TiltCover>
            )}
          </div>

          {/* Track info */}
          <div
            className="flex flex-col items-center gap-1 w-full"
            style={{
              width: showLyrics
                ? TIER_CONFIG[lyricsTier].artSize
                : TIER_CONFIG[lyricsTier].artSizeSolo,
              maxWidth: TIER_CONFIG[lyricsTier].artMax,
            }}
          >
            <div className="flex items-center justify-center gap-2 max-w-full">
              <span
                className="text-th-text-primary font-bold truncate"
                style={{ fontSize: TIER_CONFIG[lyricsTier].titleSize }}
              >
                {getTrackDisplayTitle(currentTrack)}
              </span>
              {currentTrack?.explicit && <ExplicitBadge />}
            </div>
            <span
              className={`${isDark ? "text-th-text-muted" : "text-th-text-secondary"} truncate max-w-full`}
              style={{ fontSize: TIER_CONFIG[lyricsTier].artistSize }}
            >
              {getTrackArtistDisplay(currentTrack)}
            </span>
          </div>

          {/* Favorite + context menu */}
          <div className="flex items-center gap-3">
            <button
              onClick={toggleLike}
              className={`transition-[color,transform] duration-200 active:scale-90 ${
                isLiked
                  ? "text-th-accent"
                  : `${isDark ? "text-th-text-faint" : "text-th-text-secondary"} hover:text-th-text-primary`
              }`}
            >
              <Heart
                size={TIER_CONFIG[lyricsTier].iconSize}
                fill={isLiked ? "currentColor" : "none"}
                strokeWidth={isLiked ? 0 : 2}
              />
            </button>
            <button
              ref={contextMenuAnchorRef}
              onClick={() => setContextMenuTrack(currentTrack)}
              className={`${isDark ? "text-th-text-faint" : "text-th-text-secondary"} hover:text-th-text-primary transition-colors duration-150`}
            >
              <MoreHorizontal size={TIER_CONFIG[lyricsTier].iconSize} />
            </button>
          </div>
        </div>

        {/* Right: Lyrics panel (only when toggled on) */}
        {showLyrics && (
          <div className="flex-1 h-[80vmin] max-h-[1000px] pointer-events-none">
            <MaximizedLyrics tier={lyricsTier} />
          </div>
        )}
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
        isDark={isDark}
        bgBaseRgb={bgBaseRgb}
      />
    </div>
  );
}
