import { useEffect, useRef } from "react";
import { drawBanner } from "../lib/lovedBanner";
import { isWindowActive, onWindowActiveChange } from "../lib/windowFocus";

// Animated "Living Heart" backdrop for the Loved Tracks header, drawn on a
// low-resolution canvas; the browser's upscale keeps the blobs soft.

export const FRAME_INTERVAL_MS = 1000 / 15;
export const BACKING_DIVISOR = 4;
export const MAX_BACKING_WIDTH = 1024;

// rAF timestamps jitter around vsync; without slack a 60 Hz display skips to 12 fps.
const FRAME_SLACK_MS = 1;

export default function LovedTracksBanner() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!wrapper || !canvas || !ctx) return;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const mountedAt = performance.now();
    let reduced = motion.matches;
    let windowActive = isWindowActive();
    let intersecting = true;
    let running = false;
    let pausedAt = mountedAt;
    let pausedAccum = 0;
    let lastDraw = -Infinity;
    let raf = 0;

    const time = () =>
      reduced
        ? 0
        : ((running ? performance.now() : pausedAt) - mountedAt - pausedAccum) /
          1000;
    const paint = () => drawBanner(ctx, canvas.width, canvas.height, time());

    const frame = (now: number) => {
      raf = 0;
      if (running && now - lastDraw < FRAME_INTERVAL_MS - FRAME_SLACK_MS) {
        schedule();
        return;
      }
      lastDraw = now;
      paint();
      if (running) schedule();
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };

    const update = () => {
      const next = windowActive && intersecting && !reduced;
      if (next === running) return;
      running = next;
      const now = performance.now();
      if (running) {
        pausedAccum += now - pausedAt;
        schedule();
      } else {
        pausedAt = now;
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    const offActive = onWindowActiveChange((active) => {
      windowActive = active;
      update();
    });

    const onMotion = () => {
      reduced = motion.matches;
      update();
      schedule();
    };
    motion.addEventListener("change", onMotion);

    const resize = new ResizeObserver((entries) => {
      const { width, height } = entries[entries.length - 1].contentRect;
      if (!width || !height) return;
      const scale = Math.min(
        (window.devicePixelRatio || 1) / BACKING_DIVISOR,
        MAX_BACKING_WIDTH / width,
      );
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      paint();
    });
    resize.observe(wrapper);

    const intersection = new IntersectionObserver((entries) => {
      intersecting = entries[entries.length - 1].isIntersecting;
      update();
    });
    intersection.observe(wrapper);

    update();
    schedule();

    return () => {
      cancelAnimationFrame(raf);
      offActive();
      motion.removeEventListener("change", onMotion);
      resize.disconnect();
      intersection.disconnect();
    };
  }, []);

  return (
    <div
      ref={wrapperRef}
      className="pointer-events-none absolute inset-0 overflow-hidden select-none"
    >
      <canvas
        ref={canvasRef}
        data-testid="loved-banner-canvas"
        className="absolute inset-0 w-full h-full"
      />
      {/* Base-tone overlay: keeps the title readable on light or dark themes. */}
      <div className="absolute inset-0 bg-th-base/60" />
      {/* Settle the right edge into the page tone, like CoverBanner. */}
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-th-base/20 to-th-base/60" />
      <div className="absolute inset-0 bg-gradient-to-b from-transparent from-70% to-th-surface" />
    </div>
  );
}
