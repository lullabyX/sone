import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// fetchAndAnchor() calls invoke("get_playback_position"); stub it. It resolves
// only on a microtask, so the synchronous assertions below run before it can
// re-anchor — which is exactly the window these tests care about.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(0),
}));

import {
  getInterpolatedPosition,
  notifySeek,
  markPlaybackLoading,
  initPositionInterpolator,
  destroyPositionInterpolator,
} from "./playbackPosition";

// Stand-in atoms — the interpolator only uses them as opaque keys.
const PLAYING = Symbol("isPlaying");
const TRACK = Symbol("currentTrack");

function makeStore(init: { playing: boolean; track: unknown }) {
  const values = new Map<unknown, unknown>([
    [PLAYING, init.playing],
    [TRACK, init.track],
  ]);
  const subs = new Map<unknown, Set<() => void>>();
  return {
    get: (atom: unknown) => values.get(atom),
    set: (atom: unknown, v: unknown) => {
      values.set(atom, v);
      subs.get(atom)?.forEach((cb) => cb());
    },
    sub: (atom: unknown, cb: () => void) => {
      let s = subs.get(atom);
      if (!s) subs.set(atom, (s = new Set()));
      s.add(cb);
      return () => s!.delete(cb);
    },
  };
}

let nowVal = 0;

beforeEach(() => {
  nowVal = 0;
  vi.spyOn(performance, "now").mockImplementation(() => nowVal);
});

afterEach(() => {
  destroyPositionInterpolator();
  vi.restoreAllMocks();
});

describe("playbackPosition pause/resume anchoring", () => {
  it("freezes at the LIVE interpolated position on pause (no backward jump)", () => {
    const store = makeStore({ playing: true, track: { id: 1 } });
    initPositionInterpolator(store, PLAYING, TRACK);

    notifySeek(10); // anchor: pos=10 at t=0, still playing
    nowVal = 2000; // 2s of playback
    expect(getInterpolatedPosition()).toBeCloseTo(12, 5);

    store.set(PLAYING, false); // pause
    // Must capture the live 12s, not the stale 10s anchor.
    expect(getInterpolatedPosition()).toBeCloseTo(12, 5);
  });

  it("does NOT count the paused interval as elapsed on resume (no forward jump)", () => {
    const store = makeStore({ playing: true, track: { id: 1 } });
    initPositionInterpolator(store, PLAYING, TRACK);

    notifySeek(10);
    nowVal = 2000;
    store.set(PLAYING, false); // pause at 12s
    expect(getInterpolatedPosition()).toBeCloseTo(12, 5);

    nowVal = 32000; // sit paused for 30s
    expect(getInterpolatedPosition()).toBeCloseTo(12, 5); // frozen

    store.set(PLAYING, true); // resume
    // At the resume instant (before the async re-fetch) the position must be the
    // frozen 12s, NOT 12 + 30 = 42s.
    expect(getInterpolatedPosition()).toBeCloseTo(12, 1);

    nowVal = 33000; // 1s into resumed playback
    expect(getInterpolatedPosition()).toBeCloseTo(13, 1);
  });
});

describe("playbackPosition load gate", () => {
  it("freezes at 0 while an explicit play is loading (no climb during the gap)", () => {
    const store = makeStore({ playing: true, track: { id: 1 } });
    initPositionInterpolator(store, PLAYING, TRACK);

    notifySeek(50);
    nowVal = 1000;
    expect(getInterpolatedPosition()).toBeCloseTo(51, 5);

    markPlaybackLoading(true); // user picks a new track
    store.set(TRACK, { id: 2 }); // track-change reset to 0
    nowVal = 1800; // 800ms load gap
    expect(getInterpolatedPosition()).toBe(0); // frozen, not 0.8

    markPlaybackLoading(false); // backend confirms playback started
    nowVal = 2300; // 0.5s of real playback
    expect(getInterpolatedPosition()).toBeCloseTo(0.5, 1);
  });

  it("notifySeek clears a pending load gate", () => {
    const store = makeStore({ playing: true, track: { id: 1 } });
    initPositionInterpolator(store, PLAYING, TRACK);

    markPlaybackLoading(true);
    store.set(TRACK, { id: 2 });
    nowVal = 500;
    expect(getInterpolatedPosition()).toBe(0); // gated

    notifySeek(0); // in-place replay anchors at 0 and clears the gate
    nowVal = 1500; // 1s later
    expect(getInterpolatedPosition()).toBeCloseTo(1, 1);
  });
});
