import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

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
import { historyAtom, queueAtom } from "../../atoms/playback";
import { tvNowPlayingTabAtom } from "../../atoms/tv";
import type { Lyrics, Track } from "../../types";
import TvNowPlaying from "./TvNowPlaying";
import {
  mkTrack,
  mockInvoke,
  range,
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

const focusTab = (name: string) =>
  fireEvent.focus(screen.getByRole("tab", { name }));
const panel = () => screen.getByRole("tabpanel");
const rows = () =>
  Array.from(panel().querySelectorAll<HTMLElement>(".tv-track-row"));
const rowFor = (title: string) =>
  screen.getByText(title).closest<HTMLElement>(".tv-track-row")!;

describe("TvNowPlaying tabs", () => {
  it("shows the last ten played tracks, most recent first", () => {
    const store = playing(mkTrack(100));
    store.set(
      historyAtom,
      range(12).map((i) => mkTrack(i + 1)),
    );
    renderTv(<TvNowPlaying />, { store });
    focusTab("History");
    expect(
      rows().map((r) => within(r).getByText(/^T\d+$/).textContent),
    ).toEqual(range(10).map((i) => `T${12 - i}`));
  });

  it("plays a history track and keeps the queue", async () => {
    const store = playing(mkTrack(100), [mkTrack(50)]);
    store.set(historyAtom, [mkTrack(11), mkTrack(12)]);
    const queue = store.get(queueAtom);
    renderTv(<TvNowPlaying />, { store });
    focusTab("History");
    fireEvent.click(within(rowFor("T12")).getAllByRole("button")[0]);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "play_tidal_track",
        expect.objectContaining({ trackId: 12 }),
      ),
    );
    expect(store.get(queueAtom)).toBe(queue);
  });

  it("Up next is selected first", () => {
    renderTv(<TvNowPlaying />, { store: playing(mkTrack(100)) });
    expect(
      screen
        .getByRole("tab", { name: "Up next" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("Up next shows how many tracks are queued", () => {
    renderTv(<TvNowPlaying />, {
      store: playing(
        mkTrack(100),
        range(23).map((i) => mkTrack(i + 1)),
      ),
    });
    expect(screen.getByRole("tab", { name: "Up next · 23" })).toBeTruthy();
  });

  it("remembers the last tab for the session", () => {
    const store = playing(mkTrack(100));
    const r = renderTv(<TvNowPlaying />, { store });
    focusTab("History");
    r.unmount();
    renderTv(<TvNowPlaying />, { store });
    expect(
      screen
        .getByRole("tab", { name: "History" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(store.get(tvNowPlayingTabAtom)).toBe("history");
  });
});
