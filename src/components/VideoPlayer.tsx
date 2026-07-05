import {
  Play,
  Pause,
  X,
  Maximize2,
  Minimize2,
  Settings,
  Loader2,
} from "lucide-react";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  memo,
  type RefObject,
} from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  currentVideoAtom,
  videoStreamAtom,
  videoPlayingAtom,
  videoFullscreenAtom,
  videoExpandedAtom,
} from "../atoms/video";
import { useVideoPlayback, type VideoQuality } from "../hooks/useVideoPlayback";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { volumeAtom } from "../atoms/playback";
import { getTidalImageUrl } from "../types";
import { formatTime } from "../lib/format";
import { videoElementRef } from "../lib/videoElement";
import ExplicitBadge from "./ExplicitBadge";

const QUALITIES: VideoQuality[] = ["HIGH", "MEDIUM", "LOW"];
const QUALITY_LABEL: Record<VideoQuality, string> = {
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

// ─── HLS attach: native-first, hls.js fallback ──────────────────────────────

/** Returns a cleanup fn. Tries native HLS; falls back to hls.js (MSE). */
function attachHls(
  video: HTMLVideoElement,
  url: string,
  onFatal: () => void,
): () => void {
  let destroyed = false;
  let hlsInstance: { destroy: () => void } | null = null;

  const canNative =
    video.canPlayType("application/vnd.apple.mpegurl") !== "" ||
    video.canPlayType("application/x-mpegURL") !== "";

  const startFallback = () => {
    if (destroyed) return;
    import("hls.js")
      .then(({ default: Hls }) => {
        if (destroyed) return;
        if (!Hls.isSupported()) {
          onFatal();
          return;
        }
        const hls = new Hls({ enableWorker: true });
        hlsInstance = hls;
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) onFatal();
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      })
      .catch(() => {
        if (!destroyed) onFatal();
      });
  };

  if (canNative) {
    // Native path: set src directly; on a load error, fall back to hls.js.
    const onError = () => {
      video.removeEventListener("error", onError);
      startFallback();
    };
    video.addEventListener("error", onError);
    video.src = url;
    return () => {
      destroyed = true;
      video.removeEventListener("error", onError);
      hlsInstance?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }

  startFallback();
  return () => {
    destroyed = true;
    hlsInstance?.destroy();
    video.removeAttribute("src");
    video.load();
  };
}

// ─── Scrubber (bound to the <video> element, not playbackPosition.ts) ────────

const VideoScrubber = memo(function VideoScrubber({
  videoRef,
  resetHideTimer,
  isDraggingRef,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  resetHideTimer: () => void;
  isDraggingRef: RefObject<boolean>;
}) {
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [hovering, setHovering] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);

  // Poll the element's currentTime via rAF, but throttle the React state update to
  // ~6-7 Hz. Updating every frame (60 Hz) re-renders + repaints the progress bar each
  // frame, which at 4K fullscreen contends with video compositing and causes stutter.
  // A progress bar has no need for 60 Hz; ~150 ms is visually identical and far cheaper.
  useEffect(() => {
    let raf: number;
    let last = 0;
    const tick = (now: number) => {
      const v = videoRef.current;
      if (v && !isDraggingRef.current && now - last >= 150) {
        last = now;
        setPosition(v.currentTime);
        if (v.duration && !Number.isNaN(v.duration)) setDuration(v.duration);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoRef, isDraggingRef]);

  const seekToClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      const v = videoRef.current;
      if (!track || !v || !duration) return;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const target = ratio * duration;
      setPosition(target);
      v.currentTime = target;
    },
    [videoRef, duration],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);
      isDraggingRef.current = true;
      seekToClientX(e.clientX);

      const onMove = (me: MouseEvent) => seekToClientX(me.clientX);
      const onUp = () => {
        setDragging(false);
        isDraggingRef.current = false;
        resetHideTimer();
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [seekToClientX, isDraggingRef, resetHideTimer],
  );

  const progress = duration > 0 ? (position / duration) * 100 : 0;

  return (
    <div className="w-full flex items-center gap-2 text-th-text-muted">
      <span className="min-w-[40px] text-right text-[12px] tabular-nums select-none">
        {formatTime(position)}
      </span>
      <div
        ref={trackRef}
        onMouseDown={handleMouseDown}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => {
          if (!dragging) setHovering(false);
        }}
        className="scrubber flex-1 relative cursor-pointer h-[17px] flex items-center"
      >
        <div className="relative w-full h-[6px] rounded-full">
          <div className="absolute inset-0 bg-th-slider-track rounded-full" />
          <div
            className={`absolute left-0 rounded-full transition-[height,top,background-color] duration-100 ${
              hovering || dragging
                ? "h-full top-0 bg-th-accent"
                : "h-[3px] top-[1.5px] bg-th-slider-fill"
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <div
          className={`absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 bg-th-text-primary rounded-full shadow-md shadow-black/50 pointer-events-none transition-opacity duration-100 ${
            hovering || dragging ? "opacity-100" : "opacity-0"
          }`}
          style={{ left: `calc(${progress}% - 7px)` }}
        />
      </div>
      <span className="min-w-[40px] text-[12px] tabular-nums select-none">
        {formatTime(duration)}
      </span>
    </div>
  );
});

// ─── VideoPlayer ─────────────────────────────────────────────────────────────

export default function VideoPlayer() {
  const video = useAtomValue(currentVideoAtom);
  const stream = useAtomValue(videoStreamAtom);
  const setVideoPlaying = useSetAtom(videoPlayingAtom);
  const fullscreen = useAtomValue(videoFullscreenAtom);
  const setFullscreen = useSetAtom(videoFullscreenAtom);
  const expanded = useAtomValue(videoExpandedAtom);
  const volume = useAtomValue(volumeAtom);
  const { closeVideo, minimizeVideo, setVideoQuality } = useVideoPlayback();
  const { playNext } = usePlaybackActions();

  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [quality, setQuality] = useState<VideoQuality>("HIGH");
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);

  // Attach the HLS stream (native-first, hls.js fallback). Autoplay must wait until
  // the source is actually attached: attachHls's hls.js path is async (dynamic import),
  // so calling play() synchronously here races the attach and no-ops, parking the video
  // on the first frame until a manual toggle. Start on `canplay` instead — once per
  // video, so a quality re-attach doesn't override a user's paused state.
  const autoplayedIdRef = useRef<number | null>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream?.url) return;
    setLoading(true);
    setFailed(false);
    const detach = attachHls(v, stream.url, () => setFailed(true));
    const onCanPlay = () => {
      v.removeEventListener("canplay", onCanPlay);
      if (video?.id != null && autoplayedIdRef.current !== video.id) {
        autoplayedIdRef.current = video.id;
        v.play().catch(() => {});
      }
    };
    v.addEventListener("canplay", onCanPlay);
    return () => {
      v.removeEventListener("canplay", onCanPlay);
      detach();
    };
  }, [stream?.url, video?.id]);

  // Publish the live element so the player bar can drive it when minimized.
  useEffect(() => {
    videoElementRef.current = videoRef.current;
    return () => {
      videoElementRef.current = null;
    };
  }, []);

  // Drive the element's audio from the shared volume atom (the GStreamer
  // pipeline is stopped during video, so the slider only reaches us here).
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume]);

  // Mirror element play state into local + atom.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => {
      setIsPlaying(true);
      setVideoPlaying(true);
    };
    const onPause = () => {
      setIsPlaying(false);
      setVideoPlaying(false);
    };
    const onPlaying = () => setLoading(false);
    const onWaiting = () => setLoading(true);
    const onError = () => setFailed(true);
    const onEnded = () => {
      playNext();
    };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("playing", onPlaying);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("error", onError);
    v.addEventListener("ended", onEnded);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("error", onError);
      v.removeEventListener("ended", onEnded);
    };
  }, [setVideoPlaying, playNext]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  const toggleFullscreen = useCallback(() => {
    const next = !fullscreen;
    setFullscreen(next);
    getCurrentWindow()
      .setFullscreen(next)
      .catch(() => {});
  }, [fullscreen, setFullscreen]);

  const handleQualityChange = useCallback(
    async (q: VideoQuality) => {
      setQualityMenuOpen(false);
      if (q === quality) return;
      setQuality(q);
      const v = videoRef.current;
      const resumeAt = v?.currentTime ?? 0;
      const wasPlaying = v ? !v.paused : true;
      const newStream = await setVideoQuality(q);
      // The stream atom change re-runs the attach effect; restore position once
      // the new source can seek.
      if (newStream && v) {
        const onLoaded = () => {
          v.currentTime = resumeAt;
          if (wasPlaying) v.play().catch(() => {});
          v.removeEventListener("loadedmetadata", onLoaded);
        };
        v.addEventListener("loadedmetadata", onLoaded);
      }
    },
    [quality, setVideoQuality],
  );

  // Auto-hide controls on mouse idle (mirrors MaximizedPlayer).
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsVisibleRef = useRef(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isDraggingRef = useRef(false);
  const lastMousePos = useRef({ x: 0, y: 0 });

  const resetHideTimer = useCallback((e?: React.MouseEvent) => {
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

  // ESC closes (exits fullscreen first if active).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (fullscreen) {
        setFullscreen(false);
        getCurrentWindow()
          .setFullscreen(false)
          .catch(() => {});
        return;
      }
      closeVideo();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [fullscreen, setFullscreen, closeVideo]);

  if (!video) return null;

  const artistName =
    video.artist?.name ||
    video.artists?.map((a) => a.name).join(", ") ||
    "";

  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseMove={resetHideTimer}
      className={`fixed inset-0 z-[9998] flex items-center justify-center bg-black select-none ${
        expanded ? "" : "hidden"
      } ${controlsVisible ? "cursor-default" : "cursor-none"}`}
    >
      <video
        ref={videoRef}
        poster={getTidalImageUrl(video.imageId, 1280)}
        playsInline
        onClick={togglePlay}
        className="absolute inset-0 w-full h-full object-contain bg-black"
      />

      {/* Loading / error overlay */}
      {(loading || failed) && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          {failed ? (
            <p className="text-th-text-muted text-sm">
              Unable to play this video
            </p>
          ) : (
            <Loader2 size={40} className="text-th-text-primary animate-spin" />
          )}
        </div>
      )}

      {/* Top bar — title + close */}
      <div
        className={`absolute top-0 left-0 right-0 z-20 px-6 pt-5 pb-10 flex items-start justify-between transition-opacity duration-300 ${
          controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        style={{
          background: "linear-gradient(to bottom, rgba(0,0,0,0.6), transparent)",
        }}
      >
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-th-text-primary text-[17px] font-bold truncate">
              {video.title}
            </h2>
            {video.explicit && <ExplicitBadge />}
          </div>
          {artistName && (
            <p className="text-th-text-muted text-[13px] truncate mt-0.5">
              {artistName}
            </p>
          )}
        </div>
        <button
          onClick={minimizeVideo}
          className="ml-4 shrink-0 text-th-text-faint hover:text-th-text-primary transition-colors duration-150"
          title="Minimize video"
        >
          <X size={22} />
        </button>
      </div>

      {/* Bottom bar — transport + scrubber */}
      <div
        className={`absolute bottom-0 left-0 right-0 z-20 px-6 pb-5 pt-12 transition-opacity duration-300 ${
          controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        style={{
          background: "linear-gradient(to top, rgba(0,0,0,0.7), transparent)",
        }}
      >
        <VideoScrubber
          videoRef={videoRef}
          resetHideTimer={resetHideTimer}
          isDraggingRef={isDraggingRef}
        />
        <div className="flex items-center justify-between mt-2">
          <button
            onClick={togglePlay}
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

          <div className="flex items-center gap-4">
            {/* Quality selector */}
            <div className="relative">
              <button
                onClick={() => setQualityMenuOpen((v) => !v)}
                className={`flex items-center gap-1.5 text-[13px] transition-colors duration-150 ${
                  qualityMenuOpen
                    ? "text-th-accent"
                    : "text-th-text-faint hover:text-th-text-primary"
                }`}
                title="Quality"
              >
                <Settings size={18} strokeWidth={2} />
                <span className="tabular-nums">{QUALITY_LABEL[quality]}</span>
              </button>
              {qualityMenuOpen && (
                <div className="absolute bottom-full right-0 mb-2 py-1 min-w-[120px] bg-th-elevated border border-th-border-subtle rounded-lg shadow-xl shadow-black/40">
                  {QUALITIES.map((q) => (
                    <button
                      key={q}
                      onClick={() => handleQualityChange(q)}
                      className={`w-full text-left px-3 py-1.5 text-[13px] transition-colors ${
                        q === quality
                          ? "text-th-accent"
                          : "text-th-text-secondary hover:text-th-text-primary hover:bg-th-hl-faint"
                      }`}
                    >
                      {QUALITY_LABEL[q]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={toggleFullscreen}
              className="text-th-text-faint hover:text-th-text-primary transition-colors duration-150"
              title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {fullscreen ? (
                <Minimize2 size={18} strokeWidth={2} />
              ) : (
                <Maximize2 size={18} strokeWidth={2} />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
