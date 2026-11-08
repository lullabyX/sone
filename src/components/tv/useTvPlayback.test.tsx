import { expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({
  playSource: vi.fn(),
  playMedia: vi.fn(),
  actions: {
    playTrack: vi.fn(async () => ({ ok: true })),
    playFromQueue: vi.fn(async () => {}),
  },
}));
vi.mock("../../hooks/usePlaySource", () => ({
  usePlaySource: () => m.playSource,
}));
vi.mock("../../hooks/useMediaPlay", () => ({
  useMediaPlay: () => m.playMedia,
}));
vi.mock("../../hooks/usePlaybackActions", () => ({
  usePlaybackActions: () => m.actions,
}));

import {
  allowAiAtom,
  allowExplicitAtom,
  currentTrackAtom,
  playbackSourceAtom,
} from "../../atoms/playback";
import { currentVideoAtom, videoExpandedAtom } from "../../atoms/video";
import type { TidalVideo, Track } from "../../types";
import { useTvPlayback } from "./useTvPlayback";
import { mkTrack, renderTvHook, setupTvTest, withQueue } from "./tvTestUtils";

setupTvTest();

const meta = { type: "album", id: 9, name: "A" };

it("shows Now Playing only when playback started", async () => {
  const show = vi.fn();
  const { result } = renderTvHook(() => useTvPlayback(show));
  m.playSource.mockResolvedValueOnce(false);
  await act(() =>
    result.current.playTrack(mkTrack(1), [mkTrack(1), mkTrack(2)]),
  );
  expect(show).not.toHaveBeenCalled();
  m.playSource.mockResolvedValueOnce(true);
  await act(() =>
    result.current.playTrack(mkTrack(1), [mkTrack(1), mkTrack(2)], {
      source: { ...meta, allTracks: [] },
    }),
  );
  expect(m.playSource.mock.lastCall![0]).toMatchObject({
    meta: { type: "album", id: 9 },
    loaded: [mkTrack(1), mkTrack(2)],
  });
  expect(m.playSource.mock.lastCall![1]).toEqual({ startAt: mkTrack(1) });
  expect(show).toHaveBeenCalledTimes(1);
});

it("toasts and plays nothing for an unavailable track", async () => {
  const { result } = renderTvHook(() => useTvPlayback(vi.fn()));
  expect(
    await act(() =>
      result.current.playTrack(mkTrack(3, { streamReady: false }), []),
    ),
  ).toBe(false);
  expect(m.playSource).not.toHaveBeenCalled();
  expect(await screen.findByText("This track isn't available")).toBeTruthy();
});

it("says why a filtered track does not play and where to change it", async () => {
  const { result, store } = renderTvHook(() => useTvPlayback(vi.fn()));
  act(() => store.set(allowAiAtom, false));
  expect(
    await act(() => result.current.playTrack(mkTrack(6, { ai: true }), [])),
  ).toBe(false);
  expect(m.playSource).not.toHaveBeenCalled();
  expect(
    await screen.findByText(
      "AI-generated content is off — turn it on in Settings › Content",
    ),
  ).toBeTruthy();
});

it("playQueued refuses a filtered queue track with the TV message", async () => {
  const store = withQueue([mkTrack(8, { explicit: true })], mkTrack(1));
  store.set(allowExplicitAtom, false);
  const { result } = renderTvHook(() => useTvPlayback(vi.fn()), { store });
  expect(await act(() => result.current.playQueued(0))).toBe(false);
  expect(m.actions.playFromQueue).not.toHaveBeenCalled();
  expect(
    await screen.findByText(
      "Explicit content is off — turn it on in Settings › Content",
    ),
  ).toBeTruthy();
});

const playingFrom = (type: string, id: string | number) => ({
  type,
  id,
  name: "S",
  tracks: [],
});

it("only shows the track that is already playing", async () => {
  const show = vi.fn();
  const { result, store } = renderTvHook(() => useTvPlayback(show));
  act(() => {
    store.set(currentTrackAtom, mkTrack(1));
    store.set(playbackSourceAtom, playingFrom("tv-row", 1));
  });
  expect(
    await act(() => result.current.playTrack(mkTrack(1), [mkTrack(1)])),
  ).toBe(true);
  expect(m.playSource).not.toHaveBeenCalled();
  expect(show).toHaveBeenCalledTimes(1);
});

it("does not open Now Playing under a video that started", async () => {
  const show = vi.fn();
  const { result, store } = renderTvHook(() => useTvPlayback(show));
  const v = mkTrack(7, { itemType: "video" });
  m.playSource.mockImplementationOnce(async () => {
    store.set(currentTrackAtom, v);
    return true;
  });
  await act(() => result.current.playSource({ meta, loaded: [v] }));
  expect(show).not.toHaveBeenCalled();
});

it("menu Play opens Now Playing only when something started", async () => {
  const show = vi.fn();
  const { result, store } = renderTvHook(() => useTvPlayback(show));
  const playing = (t: Track) => async () => {
    store.set(currentTrackAtom, t);
    return true;
  };
  m.playMedia.mockResolvedValueOnce(false);
  await act(() =>
    result.current.playMedia({ type: "album", id: 1, title: "A" }),
  );
  m.playMedia.mockImplementationOnce(
    playing(mkTrack(2, { itemType: "video" })),
  );
  await act(() =>
    result.current.playMedia({ type: "video", id: 2, title: "V" }),
  );
  expect(show).not.toHaveBeenCalled();
  m.playMedia.mockImplementationOnce(playing(mkTrack(1)));
  await act(() =>
    result.current.playMedia({ type: "album", id: 1, title: "A" }),
  );
  expect(show).toHaveBeenCalledTimes(1);
});

it("playOne keeps the queue and refuses an unavailable track", async () => {
  const { result } = renderTvHook(() => useTvPlayback(vi.fn()));
  expect(
    await act(() => result.current.playOne(mkTrack(4, { streamReady: false }))),
  ).toBe(false);
  expect(m.actions.playTrack).not.toHaveBeenCalled();
  expect(await act(() => result.current.playOne(mkTrack(5)))).toBe(true);
  expect(m.actions.playTrack).toHaveBeenLastCalledWith(mkTrack(5));
});

it("opens Now Playing for the playing track in the list it plays from", async () => {
  const show = vi.fn();
  const { result, store } = renderTvHook(() => useTvPlayback(show));
  act(() => {
    store.set(currentTrackAtom, mkTrack(1));
    store.set(playbackSourceAtom, playingFrom("album", 9));
  });
  await act(() =>
    result.current.playSource(
      { meta, loaded: [mkTrack(1)] },
      { startAt: mkTrack(1) },
    ),
  );
  expect(m.playSource).not.toHaveBeenCalled();
  expect(show).toHaveBeenCalledTimes(1);
});

it("plays the playing track from another list instead of only showing it", async () => {
  const show = vi.fn();
  const { result, store } = renderTvHook(() => useTvPlayback(show));
  act(() => {
    store.set(currentTrackAtom, mkTrack(1));
    store.set(playbackSourceAtom, playingFrom("playlist", "p1"));
  });
  m.playSource.mockResolvedValueOnce(true);
  await act(() =>
    result.current.playSource(
      { meta, loaded: [mkTrack(1)] },
      { startAt: mkTrack(1) },
    ),
  );
  expect(m.playSource).toHaveBeenCalledTimes(1);
  expect(m.playSource.mock.lastCall![1]).toEqual({ startAt: mkTrack(1) });
  expect(show).toHaveBeenCalledTimes(1);
});

it("a track with the playing video's id is not the playing item", async () => {
  const show = vi.fn();
  const { result, store } = renderTvHook(() => useTvPlayback(show));
  act(() => {
    store.set(currentTrackAtom, mkTrack(1, { itemType: "video" }));
    store.set(playbackSourceAtom, playingFrom("album", 9));
  });
  m.playSource.mockResolvedValueOnce(true);
  await act(() =>
    result.current.playSource(
      { meta, loaded: [mkTrack(1)] },
      { startAt: mkTrack(1) },
    ),
  );
  expect(m.playSource).toHaveBeenCalledTimes(1);
});

const video = (id: number) => ({ id, title: "V", duration: 100 }) as TidalVideo;

it("brings back the playing video full screen instead of Now Playing", async () => {
  const show = vi.fn();
  const { result, store } = renderTvHook(() => useTvPlayback(show));
  const v = mkTrack(7, { itemType: "video" });
  act(() => {
    store.set(currentTrackAtom, v);
    store.set(currentVideoAtom, video(7));
    store.set(playbackSourceAtom, playingFrom("album", 9));
  });
  expect(
    await act(() =>
      result.current.playSource({ meta, loaded: [v] }, { startAt: v }),
    ),
  ).toBe(true);
  expect(m.playSource).not.toHaveBeenCalled();
  expect(show).not.toHaveBeenCalled();
  expect(store.get(videoExpandedAtom)).toBe(true);
});

it("plays a closed video again", async () => {
  const { result, store } = renderTvHook(() => useTvPlayback(vi.fn()));
  const v = mkTrack(7, { itemType: "video" });
  act(() => {
    store.set(currentTrackAtom, v);
    store.set(playbackSourceAtom, playingFrom("album", 9));
  });
  m.playSource.mockResolvedValueOnce(true);
  await act(() =>
    result.current.playSource({ meta, loaded: [v] }, { startAt: v }),
  );
  expect(m.playSource).toHaveBeenCalledTimes(1);
});

it("a video card of the playing video brings it back instead of restarting it", async () => {
  const show = vi.fn();
  const { result, store } = renderTvHook(() => useTvPlayback(show));
  act(() => {
    store.set(currentTrackAtom, mkTrack(7, { itemType: "video" }));
    store.set(currentVideoAtom, video(7));
  });
  expect(
    await act(() =>
      result.current.playMedia({ type: "video", id: 7, title: "V" }),
    ),
  ).toBe(true);
  expect(m.playMedia).not.toHaveBeenCalled();
  expect(show).not.toHaveBeenCalled();
  expect(store.get(videoExpandedAtom)).toBe(true);
});

it("menu Play does not open Now Playing under a list that starts with a video", async () => {
  const show = vi.fn();
  const { result, store } = renderTvHook(() => useTvPlayback(show));
  m.playMedia.mockImplementationOnce(async () => {
    store.set(currentTrackAtom, mkTrack(7, { itemType: "video" }));
    return true;
  });
  await act(() =>
    result.current.playMedia({ type: "playlist", uuid: "p", title: "P" }),
  );
  expect(show).not.toHaveBeenCalled();
});

it("says synchronously, without a message, whether a track is refused", () => {
  const { result, store } = renderTvHook(() => useTvPlayback(vi.fn()));
  act(() => store.set(allowExplicitAtom, false));
  expect(result.current.refuses(mkTrack(3, { streamReady: false }))).toBe(true);
  expect(result.current.refuses(mkTrack(4, { explicit: true }))).toBe(true);
  expect(result.current.refuses(mkTrack(5))).toBe(false);
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText(/isn't available|content is off/)).toBeNull();
});
