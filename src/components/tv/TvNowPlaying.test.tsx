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
import { currentTrackAtom } from "../../atoms/playback";
import type { Lyrics, Track } from "../../types";
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
