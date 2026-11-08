import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";

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
  isPlayingAtom,
  playbackSourceAtom,
  volumeAtom,
} from "../../atoms/playback";
import { tvLyricsAtom } from "../../atoms/tv";
import { videoCoversAtom } from "../../atoms/ui";
import { currentVideoAtom } from "../../atoms/video";
import type { Lyrics, TidalVideo, Track } from "../../types";
import TvNowPlaying from "./TvNowPlaying";
import {
  deferred,
  mkTrack,
  mockInvoke,
  renderTv,
  setupTvTest,
  stubLayout,
  withQueue,
} from "./tvTestUtils";

setupTvTest();

beforeEach(() => {
  for (const m of Object.values(api)) m.mockReset();
  vi.mocked(getInterpolatedPosition).mockReturnValue(0);
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

  it("updates the bar twice a second, gliding between samples", () => {
    vi.useFakeTimers();
    const store = playing();
    store.set(isPlayingAtom, true);
    renderTv(<TvNowPlaying />, { store });
    const slider = screen.getByRole("slider", { name: "Seek" });
    vi.mocked(getInterpolatedPosition).mockReturnValue(61);
    act(() => vi.advanceTimersByTime(250));
    expect(slider.getAttribute("aria-valuenow")).toBe("0");
    act(() => vi.advanceTimersByTime(250));
    expect(slider.getAttribute("aria-valuenow")).toBe("61");
    expect(screen.getByText("1:01")).toBeTruthy();
    for (const el of slider.querySelectorAll<HTMLElement>("div"))
      expect(el.style.transition).toMatch(/ 500ms linear$/);
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

describe("TvNowPlaying source", () => {
  it("opens the source from Now Playing", () => {
    const store = playing();
    store.set(playbackSourceAtom, {
      type: "album",
      id: 5,
      name: "Blue",
      tracks: [],
    });
    const { nav } = renderTv(<TvNowPlaying />, { store });
    fireEvent.click(screen.getByRole("button", { name: "Playing from Blue" }));
    expect(nav.push).toHaveBeenCalledWith({
      type: "album",
      id: 5,
      title: "Blue",
    });
  });

  it("shows a non-navigable source as text", () => {
    const store = playing();
    store.set(playbackSourceAtom, {
      type: "tv-row",
      id: "x",
      name: "Row",
      tracks: [],
    });
    renderTv(<TvNowPlaying />, { store });
    expect(screen.getByText("Playing from Row")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Playing from/ })).toBeNull();
  });
});

describe("TvNowPlaying artists", () => {
  it("opens a single artist straight away", () => {
    const store = playing(
      mkTrack(1, { artists: [{ id: 4, name: "Solo" }] } as Partial<Track>),
    );
    const { nav } = renderTv(<TvNowPlaying />, { store });
    fireEvent.click(screen.getByRole("button", { name: "Artist" }));
    expect(nav.push).toHaveBeenCalledWith({
      type: "artist",
      id: 4,
      name: "Solo",
    });
  });

  it("lists several artists to pick from", () => {
    const store = playing(
      mkTrack(1, {
        artists: [
          { id: 4, name: "A" },
          { id: 5, name: "B" },
        ],
      } as Partial<Track>),
    );
    const { nav } = renderTv(<TvNowPlaying />, { store });
    fireEvent.click(screen.getByRole("button", { name: "Artists" }));
    expect(nav.push).not.toHaveBeenCalled();
    const menu = vi.mocked(nav.openMenu).mock.lastCall![0];
    expect(menu.items.map((i) => i.label)).toEqual(["A", "B"]);
    void menu.items[1].onSelect!();
    expect(nav.push).toHaveBeenCalledWith({ type: "artist", id: 5, name: "B" });
  });
});

describe("TvNowPlaying animated cover", () => {
  const motion = () =>
    playing(
      mkTrack(1, {
        album: { id: 3, title: "Al", cover: "c", videoCover: "11-22" },
      }),
    );
  const video = (c: HTMLElement) =>
    c.querySelector('video[src$="/1280x1280.mp4"]');

  it("plays the motion cover", () => {
    const { container } = renderTv(<TvNowPlaying />, { store: motion() });
    expect(video(container)).not.toBeNull();
  });

  it("shows the still cover when animated covers are off", () => {
    const store = motion();
    store.set(videoCoversAtom, false);
    const { container } = renderTv(<TvNowPlaying />, { store });
    expect(container.querySelector("video")).toBeNull();
  });

  it("shows the still cover while Now Playing is closed", () => {
    const { container } = renderTv(<TvNowPlaying />, {
      store: motion(),
      active: false,
    });
    expect(container.querySelector("video")).toBeNull();
  });
});

describe("TvNowPlaying close video", () => {
  it("closes the video and keeps focus on a control", async () => {
    const restore = stubLayout();
    const store = playing(mkTrack(9, { itemType: "video" }));
    store.set(currentVideoAtom, {
      id: 9,
      title: "V",
      duration: 100,
    } as TidalVideo);
    renderTv(<TvNowPlaying />, { store });
    const play = () => screen.getByRole("button", { name: "Play" });
    // Let the screen's initial focus land first, so it cannot be what
    // refocuses Play after the close.
    await waitFor(() => expect(document.activeElement).toBe(play()));
    const close = screen.getByRole("button", { name: "Close video" });
    close.focus();
    fireEvent.click(close);
    expect(store.get(currentVideoAtom)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(play()));
    restore();
  });

  it("no Close video without a current video", () => {
    renderTv(<TvNowPlaying />, { store: playing() });
    expect(screen.queryByRole("button", { name: "Close video" })).toBeNull();
  });
});

describe("TvNowPlaying track change", () => {
  const synced = (...lines: string[]) =>
    ({
      subtitles: lines.map((l, i) => `[00:0${i + 1}.00]${l}`).join("\n"),
      isRightToLeft: false,
    }) as Lyrics;
  const plain = { subtitles: "", lyrics: "words", isRightToLeft: false };
  const none = { subtitles: "", isRightToLeft: false } as Lyrics;
  const inLyrics = () =>
    !!(document.activeElement as HTMLElement).closest(".tv-lyrics");
  const play = () => screen.getByRole("button", { name: /^(Play|Pause)$/ });

  const start = async (lyricsOn: boolean) => {
    const restore = stubLayout();
    const store = playing();
    store.set(tvLyricsAtom, lyricsOn);
    api.getTrackLyrics.mockResolvedValueOnce(synced("one", "two", "three"));
    renderTv(<TvNowPlaying />, { store });
    await waitFor(() => expect(document.activeElement).toBe(play()));
    return { store, restore };
  };

  it("keeps the lyrics and focus on them until the next ones arrive", async () => {
    const { store, restore } = await start(true);
    try {
      act(() => screen.getByRole("button", { name: "two" }).focus());
      expect(inLyrics()).toBe(true);
      const next = deferred<Lyrics>();
      api.getTrackLyrics.mockReturnValueOnce(next.promise);
      act(() => store.set(currentTrackAtom, mkTrack(2)));
      await act(async () => {});
      expect(inLyrics()).toBe(true);
      await act(async () => next.resolve(plain as Lyrics));
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Show cover" }),
        ),
      );
      api.getTrackLyrics.mockResolvedValueOnce(none);
      act(() => store.set(currentTrackAtom, mkTrack(3)));
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Show cover" })).toBeNull(),
      );
      await waitFor(() => expect(document.activeElement).toBe(play()));
    } finally {
      restore();
    }
  });

  it("holds the last lyrics on their line while the next ones load", async () => {
    const { store, restore } = await start(true);
    const at = vi.mocked(getInterpolatedPosition);
    try {
      act(() => store.set(isPlayingAtom, true));
      at.mockReturnValue(2.5);
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: "two" })
            .getAttribute("aria-current"),
        ).toBe("true"),
      );
      const next = deferred<Lyrics>();
      api.getTrackLyrics.mockReturnValueOnce(next.promise);
      at.mockReturnValue(0);
      act(() => store.set(currentTrackAtom, mkTrack(2)));
      await act(() => new Promise((r) => setTimeout(r, 100)));
      expect(
        screen
          .getByRole("button", { name: "two" })
          .getAttribute("aria-current"),
      ).toBe("true");
    } finally {
      at.mockReturnValue(0);
      restore();
    }
  });

  it("keeps the Lyrics button until the next track turns out to have none", async () => {
    const { store, restore } = await start(false);
    try {
      const lyricsButton = await screen.findByRole("button", {
        name: "Show lyrics",
      });
      act(() => lyricsButton.focus());
      const next = deferred<Lyrics>();
      api.getTrackLyrics.mockReturnValueOnce(next.promise);
      act(() => store.set(currentTrackAtom, mkTrack(2)));
      await act(async () => {});
      expect(document.activeElement).toBe(lyricsButton);
      await act(async () => next.resolve(none));
      await waitFor(() => expect(document.activeElement).toBe(play()));
    } finally {
      restore();
    }
  });

  it("a video in place of a track keeps focus on a control", async () => {
    const { store, restore } = await start(false);
    try {
      act(() => screen.getByRole("button", { name: "Album" }).focus());
      act(() => store.set(currentTrackAtom, mkTrack(9, { itemType: "video" })));
      await waitFor(() => expect(document.activeElement).toBe(play()));
    } finally {
      restore();
    }
  });
});
