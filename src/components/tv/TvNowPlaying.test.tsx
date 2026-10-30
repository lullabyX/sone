import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../lib/playbackPosition", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/playbackPosition")>()),
  getInterpolatedPosition: vi.fn(() => 0),
}));
const api = vi.hoisted(() => ({
  getTrackLyrics: vi.fn(
    async () => ({ subtitles: "", isRightToLeft: false }) as Lyrics,
  ),
}));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()),
  ...api,
}));

import { invoke } from "@tauri-apps/api/core";
import { getInterpolatedPosition } from "../../lib/playbackPosition";
import {
  bitPerfectAtom,
  currentTrackAtom,
  volumeAtom,
} from "../../atoms/playback";
import { currentVideoAtom } from "../../atoms/video";
import type { Lyrics, TidalVideo, Track } from "../../types";
import TvNowPlaying from "./TvNowPlaying";
import {
  mkTrack,
  mockInvoke,
  renderTv,
  setupTvTest,
  withQueue,
} from "./tvTestUtils";

setupTvTest();

beforeEach(() => {
  for (const m of Object.values(api)) m.mockReset();
  mockInvoke({
    seek_track: () => undefined,
    play_tidal_track: () => ({ url: "u" }),
  });
});

const playing = (t = mkTrack(1), queue: Track[] = []) => withQueue(queue, t);

describe("TvNowPlaying progress", () => {
  it("does not read the position while the screen is hidden", () => {
    vi.useFakeTimers();
    renderTv(<TvNowPlaying />, { store: playing(), active: false });
    const before = vi.mocked(getInterpolatedPosition).mock.calls.length;
    act(() => vi.advanceTimersByTime(2000));
    expect(vi.mocked(getInterpolatedPosition).mock.calls.length).toBe(before);
  });

  it("reads it while shown", () => {
    vi.useFakeTimers();
    renderTv(<TvNowPlaying />, { store: playing(), active: true });
    const before = vi.mocked(getInterpolatedPosition).mock.calls.length;
    act(() => vi.advanceTimersByTime(2000));
    expect(
      vi.mocked(getInterpolatedPosition).mock.calls.length,
    ).toBeGreaterThan(before);
  });

  it("drops a pending seek when the track changes", () => {
    vi.useFakeTimers();
    const { store } = renderTv(<TvNowPlaying />, { store: playing() });
    fireEvent.keyDown(screen.getByRole("slider", { name: "Seek" }), {
      key: "ArrowRight",
    });
    act(() => store.set(currentTrackAtom, mkTrack(2)));
    act(() => vi.advanceTimersByTime(1000));
    expect(invoke).not.toHaveBeenCalledWith("seek_track", expect.anything());
  });

  it("still seeks when the track stays", () => {
    vi.useFakeTimers();
    renderTv(<TvNowPlaying />, { store: playing() });
    fireEvent.keyDown(screen.getByRole("slider", { name: "Seek" }), {
      key: "ArrowRight",
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(invoke).toHaveBeenCalledWith("seek_track", { positionSecs: 10 });
  });
});

describe("TvNowPlaying volume", () => {
  it("lets the remote change video volume while bit-perfect is on", () => {
    const store = playing(mkTrack(9, { itemType: "video" }));
    store.set(bitPerfectAtom, true);
    store.set(volumeAtom, 0.5);
    store.set(currentVideoAtom, {
      id: 9,
      title: "V",
      duration: 100,
    } as TidalVideo);
    renderTv(<TvNowPlaying />, { store });
    fireEvent.keyDown(screen.getByRole("slider", { name: "Volume" }), {
      key: "ArrowRight",
    });
    expect(store.get(volumeAtom)).toBeCloseTo(0.55);
  });

  it("shows the fixed-volume label for audio", () => {
    const store = playing();
    store.set(bitPerfectAtom, true);
    renderTv(<TvNowPlaying />, { store });
    expect(screen.getByText("Volume fixed (bit-perfect)")).toBeTruthy();
    expect(screen.queryByRole("slider", { name: "Volume" })).toBeNull();
  });

  it("toggles mute once while OK is held", () => {
    mockInvoke({ set_volume: () => undefined });
    const store = playing();
    store.set(volumeAtom, 0.5);
    renderTv(<TvNowPlaying />, { store });
    const slider = screen.getByRole("slider", { name: "Volume" });
    fireEvent.keyDown(slider, { key: "Enter" });
    fireEvent.keyDown(slider, { key: "Enter", repeat: true });
    expect(store.get(volumeAtom)).toBe(0);
  });
});
