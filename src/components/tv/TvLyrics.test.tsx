import {
  act,
  fireEvent,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { createStore } from "jotai";
import { beforeEach, expect, it, vi } from "vitest";
import { getTrackLyrics } from "../../api/tidal";
import { isPlayingAtom } from "../../atoms/playback";
import type { Lyrics } from "../../types";
import { TvLyricsPanel } from "./TvLyrics";
import { mockInvoke, renderTv, setupTvTest } from "./tvTestUtils";
import { useTvLyrics, type TvLyricsData } from "./useTvLyrics";

const pos = vi.hoisted(() => ({ value: 0 }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../lib/playbackPosition", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/playbackPosition")>()),
  getInterpolatedPosition: () => pos.value,
}));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()),
  getTrackLyrics: vi.fn(),
}));
import { invoke } from "@tauri-apps/api/core";

setupTvTest();

beforeEach(() => {
  pos.value = 0;
  mockInvoke({ seek_track: () => undefined });
});

const synced: TvLyricsData = {
  kind: "synced",
  rtl: false,
  lines: [
    { time: 1, text: "One" },
    { time: 5, text: "Two" },
    { time: 9, text: "Three" },
  ],
};

const fakeFrames = () =>
  vi.useFakeTimers({
    toFake: [
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
    ],
  });

it("moves the highlight within a frame", () => {
  fakeFrames();
  const store = createStore();
  store.set(isPlayingAtom, true);
  renderTv(<TvLyricsPanel lyrics={synced} duration={100} />, { store });
  pos.value = 5.01;
  act(() => vi.advanceTimersByTime(20));
  expect(screen.getByText("Two").getAttribute("aria-current")).toBe("true");
});

it("does not run while the screen is hidden", () => {
  fakeFrames();
  const store = createStore();
  store.set(isPlayingAtom, true);
  const { container } = renderTv(
    <TvLyricsPanel lyrics={synced} duration={100} />,
    { store, active: false },
  );
  pos.value = 5.01;
  act(() => vi.advanceTimersByTime(1000));
  expect(container.querySelector("[aria-current]")).toBeNull();
});

it("opens on the current line while paused, then stays idle", () => {
  fakeFrames();
  pos.value = 5.01;
  renderTv(<TvLyricsPanel lyrics={synced} duration={100} />);
  act(() => vi.advanceTimersByTime(20));
  expect(screen.getByText("Two").getAttribute("aria-current")).toBe("true");
  pos.value = 9.5;
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByText("Two").getAttribute("aria-current")).toBe("true");
});

it("re-syncs on a seek while paused", () => {
  renderTv(<TvLyricsPanel lyrics={synced} duration={100} />);
  act(() => {
    window.dispatchEvent(new CustomEvent("playback-seeked", { detail: 9.5 }));
  });
  expect(screen.getByText("Three").getAttribute("aria-current")).toBe("true");
});

it("seeks to the chosen line", async () => {
  renderTv(<TvLyricsPanel lyrics={synced} duration={100} />);
  fireEvent.click(screen.getByText("Two"));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("seek_track", { positionSecs: 5 }),
  );
});

it("entering the lyrics lands on the current line", () => {
  const outside = document.body.appendChild(document.createElement("button"));
  try {
    renderTv(<TvLyricsPanel lyrics={synced} duration={100} />);
    act(() => {
      window.dispatchEvent(new CustomEvent("playback-seeked", { detail: 9.5 }));
    });
    fireEvent.focus(screen.getByText("One"), { relatedTarget: outside });
    expect(document.activeElement).toBe(screen.getByText("Three"));
  } finally {
    outside.remove();
  }
});

it("entering the lyrics before the first line lands on the first line", () => {
  renderTv(<TvLyricsPanel lyrics={synced} duration={100} />);
  fireEvent.focus(screen.getByText("Three"), { relatedTarget: null });
  expect(document.activeElement).toBe(screen.getByText("One"));
});

it("moving between lines keeps the chosen line", () => {
  renderTv(<TvLyricsPanel lyrics={synced} duration={100} />);
  act(() => {
    window.dispatchEvent(new CustomEvent("playback-seeked", { detail: 9.5 }));
  });
  screen.getByText("Three").focus();
  screen.getByText("Two").focus();
  expect(document.activeElement).toBe(screen.getByText("Two"));
});

it("plain lyrics are not focusable", () => {
  const { container } = renderTv(
    <TvLyricsPanel
      lyrics={{ kind: "plain", text: "Hello", rtl: false }}
      duration={100}
    />,
  );
  expect(container.querySelector("[data-tv-focusable]")).toBeNull();
});

it("credits the provider", () => {
  renderTv(
    <TvLyricsPanel
      lyrics={{ ...synced, provider: "Musixmatch" }}
      duration={100}
    />,
  );
  expect(screen.getByText("Lyrics provided by Musixmatch")).toBeTruthy();
});

it("no credit without a provider", () => {
  renderTv(<TvLyricsPanel lyrics={synced} duration={100} />);
  expect(screen.queryByText(/Lyrics provided by/)).toBeNull();
});

it("the hook carries the provider", async () => {
  vi.mocked(getTrackLyrics).mockResolvedValue({
    subtitles: "[00:01.00] One",
    lyricsProvider: "Musixmatch",
  } as Lyrics);
  const { result } = renderHook(() => useTvLyrics(4801));
  await waitFor(() => expect(result.current?.provider).toBe("Musixmatch"));
});
