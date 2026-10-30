import { act, screen } from "@testing-library/react";
import { createStore } from "jotai";
import { beforeEach, expect, it, vi } from "vitest";
import { isPlayingAtom } from "../../atoms/playback";
import { TvLyricsPanel } from "./TvLyrics";
import { mockInvoke, renderTv, setupTvTest } from "./tvTestUtils";
import type { TvLyricsData } from "./useTvLyrics";

const pos = vi.hoisted(() => ({ value: 0 }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../lib/playbackPosition", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/playbackPosition")>()),
  getInterpolatedPosition: () => pos.value,
}));

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
