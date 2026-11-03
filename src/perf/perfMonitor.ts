/**
 * Optional renderer performance monitor, gated behind SONE_PERF_MONITOR=1
 * (see commands/diagnostics.rs get_perf_flags). Loaded dynamically from
 * main.tsx so the shipped app pays zero runtime cost when the switch is off.
 *
 * What it measures, all sampled at 1 s granularity:
 *   - fps buckets          via a requestAnimationFrame frame counter
 *   - longest frame gap    the stalled-frame signature (dropped animation)
 *   - long tasks           PerformanceObserver "longtask" (main-thread work
 *                          over 50 ms: renderer CPU work, layout, hydration)
 *
 * Summaries are pushed to the backend log every REPORT_EVERY_S seconds via
 * the log_perf_sample INFO channel, so A/B runs are scored with:
 *   grep '\[perf\]' ~/.config/sone/logs/sone_rCURRENT.log
 *
 * Designed to be near-inert while visible: it never touches layout or DOM,
 * and pauses its sampler when the window is hidden (WebKit throttles rAF
 * while hidden, which would otherwise report fake stalls).
 */

import { invoke } from "@tauri-apps/api/core";

const REPORT_EVERY_S = 60;
const HISTORY_BUCKETS = 60;

interface FrameBucket {
  fps: number;
  /** Longest gap between two consecutive rAF callbacks, in ms. */
  maxGapMs: number;
}

type Summary = {
  windowSeconds: number;
  avgFps: number;
  minFps: number;
  worstGapMs: number;
  avgGapMs: number;
  longTasks: number;
  longTaskTotalMs: number;
  worstLongTaskMs: number;
};

const buckets: FrameBucket[] = [];
let longTaskCount = 0;
let longTaskTotalMs = 0;
let worstLongTaskMs = 0;
let reporting = false;

function startLongTaskObserver(): void {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // 1000 ms entries come from the browser's own event loop; ignore
        // whole-page freezes caused by pausing under gdb sampling.
        if (entry.duration >= 900) continue;
        longTaskCount += 1;
        longTaskTotalMs += entry.duration;
        if (entry.duration > worstLongTaskMs) worstLongTaskMs = entry.duration;
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch (err) {
    // WebKit may not expose longtask; the rAF gap metric still covers jank.
    console.info(`[perf-monitor] longtask observer unavailable: ${String(err)}`);
  }
}

function summarize(): Summary | null {
  if (buckets.length === 0) return null;
  let fpsSum = 0;
  let minFps = Number.POSITIVE_INFINITY;
  let gapSum = 0;
  let worstGap = 0;
  let seconds = 0;
  for (const b of buckets) {
    if (b.fps > 0 || b.maxGapMs > 0) seconds += 1;
    fpsSum += b.fps;
    if (b.fps < minFps) minFps = b.fps;
    gapSum += b.maxGapMs;
    if (b.maxGapMs > worstGap) worstGap = b.maxGapMs;
  }
  if (seconds === 0) return null;
  return {
    windowSeconds: seconds,
    avgFps: Math.round((fpsSum / seconds) * 10) / 10,
    minFps,
    worstGapMs: Math.round(worstGap * 10) / 10,
    avgGapMs: Math.round((gapSum / seconds) * 10) / 10,
    longTasks: longTaskCount,
    longTaskTotalMs: Math.round(longTaskTotalMs),
    worstLongTaskMs: Math.round(worstLongTaskMs * 10) / 10,
  };
}

async function report(): Promise<void> {
  const summary = summarize();
  if (summary === null) return;
  const minFps = Number.isFinite(summary.minFps) ? summary.minFps : 0;
  const line =
    "fps avg=" + summary.avgFps +
    " min=" + minFps +
    " worstGap=" + summary.worstGapMs + "ms" +
    " avgGap=" + summary.avgGapMs + "ms" +
    " longTasks=" + summary.longTasks +
    " (" + summary.longTaskTotalMs + "ms total," +
    " worst=" + summary.worstLongTaskMs + "ms)" +
    " over " + summary.windowSeconds + "s";
  try {
    await invoke("log_perf_sample", { message: line });
  } catch {
    /* report delivery must never break the app */
  }
}

/** Keep the sampler honest when the window is hidden/unfocused. */
let samplerRunning = false;
let lastFrameTime = 0;

function sampleTick(now: number): void {
  if (!samplerRunning) return;
  const gap = lastFrameTime > 0 ? now - lastFrameTime : 0;
  lastFrameTime = now;
  const current = buckets[buckets.length - 1];
  if (current) {
    current.fps += 1;
    if (gap > current.maxGapMs) current.maxGapMs = gap;
  }
  window.requestAnimationFrame(sampleTick);
}

function openBucket(): void {
  buckets.push({ fps: 0, maxGapMs: 0 });
  if (buckets.length > HISTORY_BUCKETS) buckets.shift();
}

function startSampler(): void {
  if (samplerRunning) return;
  samplerRunning = true;
  lastFrameTime = 0;
  openBucket();
  window.requestAnimationFrame(sampleTick);
}

function stopSampler(): void {
  samplerRunning = false;
}

function installVisibilityGating(): void {
  // Timers: open a bucket each second while visible; a hidden window yields
  // zero rAF, so buckets opened there would corrupt averages.
  window.setInterval(() => {
    if (reporting && document.visibilityState === "visible") openBucket();
  }, 1000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      lastFrameTime = 0;
      startSampler();
    } else {
      stopSampler();
    }
  });

  if (document.visibilityState === "visible") startSampler();
}

function install(): void {
  startLongTaskObserver();
  installVisibilityGating();

  window.setInterval(() => {
    if (!reporting) return;
    void report().then(() => {
      longTaskCount = 0;
      longTaskTotalMs = 0;
      worstLongTaskMs = 0;
    });
  }, REPORT_EVERY_S * 1000);

  reporting = true;

  // Snapshot hook for future scripted harness use:
  // __sonePerfSnapshot() returns the current counters without resetting them.
  (
    window as unknown as Record<string, unknown>
  ).__sonePerfSnapshot = () => summarize();
}

install();
