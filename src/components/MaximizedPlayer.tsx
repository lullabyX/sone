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
import { maximizedPlayerAtom, maximizedLyricsAtom } from "../atoms/ui";
import { authTokensAtom } from "../atoms/auth";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useProgressScrub } from "../hooks/useProgressScrub";
import { getTidalImageUrl } from "../types";
import TidalImage, { fetchCachedImageUrl } from "./TidalImage";

import TrackContextMenu from "./TrackContextMenu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { formatTime } from "../lib/format";
import QualityBadge from "./QualityBadge";
import VolumeSlider from "./VolumeSlider";
import {
  addTrackToFavoritesCache,
  removeTrackFromFavoritesCache,
  getTrackLyrics,
} from "../api/tidal";
import { parseLrc, type LrcLine } from "../lib/lrc";

const BlurredBackground = memo(function BlurredBackground({
  coverUrl,
}: {
  coverUrl: string | undefined;
}) {
  return (
    <div className="w-full h-full scale-110 blur-[40px]">
      <TidalImage
        key={coverUrl}
        src={getTidalImageUrl(coverUrl, 160)}
        alt=""
        className="w-full h-full"
      />
    </div>
  );
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
  const [showLyrics, setShowLyrics] = useAtom(maximizedLyricsAtom);
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
        <div className="flex flex-col items-center w-[40%] max-w-[800px] gap-1">
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

        {/* Right: Quality + Lyrics toggle + Volume + Minimize */}
        <div className="flex items-center justify-end gap-4 w-[30%] min-w-[180px]">
          <QualityBadge />
          <button
            onClick={() => setShowLyrics((v) => !v)}
            className={`relative transition-[color,transform] duration-150 active:scale-90 ${
              showLyrics ? "text-th-accent" : "text-th-text-faint hover:text-white"
            }`}
            title="Lyrics"
          >
            <Mic2 size={18} strokeWidth={2} />
            {showLyrics && (
              <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-th-accent" />
            )}
          </button>
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
  sm: { lineHeight: 48, fontCls: "text-4xl", padding: 96, gap: 64, artSize: "55vmin", artSizeSolo: "65vmin", artMax: 500, titleSize: 20, artistSize: 14, iconSize: 20 },
  md: { lineHeight: 80, fontCls: "text-6xl", padding: 208, gap: 160, artSize: "70vmin", artSizeSolo: "80vmin", artMax: 800, titleSize: 28, artistSize: 18, iconSize: 26 },
  lg: { lineHeight: 112, fontCls: "text-8xl", padding: 288, gap: 224, artSize: "75vmin", artSizeSolo: "85vmin", artMax: 1200, titleSize: 38, artistSize: 24, iconSize: 34 },
} as const;

const ACTIVE_CLS = "text-white font-black";
const PAST_CLS = "text-white/30";
const FUTURE_CLS = "text-white/40";

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
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    return () => {
      window.removeEventListener("resize", update);
      obs.disconnect();
    };
  }, []);
  return tier;
}

const MaximizedLyrics = memo(function MaximizedLyrics({ tier }: { tier: Tier }) {
  const currentTrack = useAtomValue(currentTrackAtom);
  const isPlaying = useAtomValue(isPlayingAtom);
  const { getPlaybackPosition } = usePlaybackActions();

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
      const scrollTarget = el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2;
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

    return () => { active = false; };
  }, [currentTrack?.id]);

  // Sync active line — 300ms polling, pure DOM updates
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
        const scrollTarget = el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2;
        container.scrollTo({ top: scrollTarget });
      }

      activeLineRef.current = idx;
    };

    const sync = async () => {
      const pos = await getPlaybackPosition();
      let idx = -1;
      for (let i = lrcLines.length - 1; i >= 0; i--) {
        if (pos >= lrcLines[i].time) {
          idx = i;
          break;
        }
      }
      applyLine(idx);
    };

    sync();
    const interval = setInterval(sync, 300);
    return () => clearInterval(interval);
  }, [lrcLines, isPlaying, getPlaybackPosition, lh, baseCls]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        {[72, 55, 85, 40, 68, 90, 50].map((w, i) => (
          <div
            key={i}
            className="h-[28px] rounded bg-white/[0.06] animate-pulse"
            style={{ width: `${w}%`, animationDelay: `${i * 80}ms` }}
          />
        ))}
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
        scrollBehavior: "smooth",
        maskImage: "linear-gradient(to bottom, transparent 0%, black 50%, black 80%, transparent 100%)",
        WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 50%, black 80%, transparent 100%)",
      }}
    >
      <div className="flex flex-col items-start" style={{ paddingTop: "50%", paddingBottom: "50%" }}>
        {lrcLines.map((line, i) => (
          <p
            key={i}
            ref={(el) => { if (el) lineEls.current[i] = el; }}
            className={`${baseCls} ${FUTURE_CLS}`}
            style={{ lineHeight: `${lh}px` }}
          >
            {line.text}
          </p>
        ))}
        {provider && (
          <p
            className="text-[11px] text-white/20 mt-4"
            style={{ lineHeight: `${lh}px` }}
          >
            Lyrics provided by {provider}
          </p>
        )}
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

  // Progressive album art: 160px instantly, upgrade to 1280 when ready
  const coverKey = currentTrack?.album?.cover;
  const [hiResReady, setHiResReady] = useState(false);
  useEffect(() => {
    if (!coverKey) return;
    setHiResReady(false);
    let cancelled = false;
    fetchCachedImageUrl(getTidalImageUrl(coverKey, 1280))
      .then(() => { if (!cancelled) setHiResReady(true); })
      .catch(() => {});
    return () => { cancelled = true; };
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
      {/* Blurred album art background — pre-rendered to canvas once, zero per-frame cost */}
      <div className="absolute inset-0 overflow-hidden">
        <BlurredBackground coverUrl={currentTrack.album?.cover} />
        <div className="absolute inset-0 bg-black/60" />
      </div>

      {/* Center content — single column (art centered) or two-column (art + lyrics) */}
      <div
        className={`relative z-10 flex items-center ${
          showLyrics ? "w-full" : "flex-col gap-5"
        }`}
        style={showLyrics ? {
          paddingLeft: TIER_CONFIG[lyricsTier].padding,
          paddingRight: TIER_CONFIG[lyricsTier].padding,
          gap: TIER_CONFIG[lyricsTier].gap,
        } : undefined}
      >
        {/* Left: album art + track info + actions */}
        <div className={`flex flex-col items-center gap-5 ${
          showLyrics ? "flex-shrink-0" : ""
        }`}>
          {/* Large album art */}
          <div
            className={`aspect-square rounded-lg overflow-hidden shadow-2xl shadow-black/60 transition-[filter] duration-700 ease-out ${
              hiResReady ? "" : "blur-[12px]"
            }`}
            style={{
              width: showLyrics ? TIER_CONFIG[lyricsTier].artSize : TIER_CONFIG[lyricsTier].artSizeSolo,
              maxWidth: TIER_CONFIG[lyricsTier].artMax,
            }}
          >
            <TidalImage
              src={getTidalImageUrl(coverKey, hiResReady ? 1280 : 160)}
              alt={currentTrack.album?.title || currentTrack.title}
              className="w-full h-full"
            />
          </div>

          {/* Track info */}
          <div
            className="flex flex-col items-center gap-1 w-full"
            style={{
              width: showLyrics ? TIER_CONFIG[lyricsTier].artSize : TIER_CONFIG[lyricsTier].artSizeSolo,
              maxWidth: TIER_CONFIG[lyricsTier].artMax,
            }}
          >
            <span className="text-white font-bold truncate max-w-full" style={{ fontSize: TIER_CONFIG[lyricsTier].titleSize }}>
              {currentTrack.title}
            </span>
            <span className="text-th-text-muted truncate max-w-full" style={{ fontSize: TIER_CONFIG[lyricsTier].artistSize }}>
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
                size={TIER_CONFIG[lyricsTier].iconSize}
                fill={isLiked ? "currentColor" : "none"}
                strokeWidth={isLiked ? 0 : 2}
              />
            </button>
            <button
              ref={contextMenuAnchorRef}
              onClick={() => setContextMenuTrack(currentTrack)}
              className="text-th-text-faint hover:text-white transition-colors duration-150"
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
      />
    </div>
  );
}
