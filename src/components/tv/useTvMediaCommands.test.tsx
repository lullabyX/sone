import { afterEach, expect, it, vi } from "vitest";
import { currentTrackAtom, preMuteVolumeAtom, volumeAtom } from "../../atoms/playback";
import { currentVideoAtom } from "../../atoms/video";
import { getInterpolatedPosition } from "../../lib/playbackPosition";
import { videoElementRef } from "../../lib/videoElement";
import { mkTrack, renderTvHook, setupTvTest } from "./tvTestUtils";
import { useTvMediaCommands } from "./useTvMediaCommands";

setupTvTest();
const actions = vi.hoisted(() => ({ togglePlayPause: vi.fn(), resumeTrack: vi.fn(), pauseTrack: vi.fn(),
  playNext: vi.fn(), playPrevious: vi.fn(), seekTo: vi.fn(), setVolume: vi.fn() }));
vi.mock("../../hooks/usePlaybackActions", () => ({ usePlaybackActions: () => actions }));
vi.mock("../../lib/playbackPosition", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/playbackPosition")>()), getInterpolatedPosition: vi.fn(() => 5) }));
afterEach(() => { videoElementRef.current = null; });
it("seeks audio within the track", () => {
  const { result, store } = renderTvHook(() => useTvMediaCommands());
  store.set(currentTrackAtom, mkTrack(1));
  result.current({ kind: "seek", by: -10 });
  expect(actions.seekTo).toHaveBeenCalledWith(0);
  vi.mocked(getInterpolatedPosition).mockReturnValueOnce(175);
  result.current({ kind: "seek", by: 10 });
  expect(actions.seekTo).toHaveBeenLastCalledWith(179);
});
it("steps and mutes the volume", () => {
  const { result, store } = renderTvHook(() => useTvMediaCommands());
  store.set(volumeAtom, 0.98);
  result.current({ kind: "volume", by: 0.05 });
  expect(actions.setVolume).toHaveBeenCalledWith(1);
  store.set(volumeAtom, 0.4);
  result.current({ kind: "mute" });
  expect(store.get(preMuteVolumeAtom)).toBe(0.4);
  expect(actions.setVolume).toHaveBeenLastCalledWith(0);
});
it("seeks a playing video through its element", () => {
  const { result, store } = renderTvHook(() => useTvMediaCommands());
  const el = document.createElement("video");
  Object.defineProperty(el, "duration", { value: 100 });
  videoElementRef.current = el;
  store.set(currentVideoAtom, { id: 9 } as never);
  el.currentTime = 95;
  result.current({ kind: "seek", by: 10 });
  expect(el.currentTime).toBe(99.5);
  expect(actions.seekTo).not.toHaveBeenCalled();
});
it("maps transport commands", () => {
  const { result } = renderTvHook(() => useTvMediaCommands());
  result.current({ kind: "next" }); result.current({ kind: "play" }); result.current({ kind: "pause" });
  expect(actions.playNext).toHaveBeenCalledWith({ explicit: true });
  expect(actions.resumeTrack).toHaveBeenCalledTimes(1);
  expect(actions.pauseTrack).toHaveBeenCalledTimes(1);
});
