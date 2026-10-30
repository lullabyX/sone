import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

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
import {
  historyAtom,
  manualQueueAtom,
  playbackSourceAtom,
  queueAtom,
} from "../../atoms/playback";
import { tvNowPlayingTabAtom } from "../../atoms/tv";
import type { Lyrics, Track } from "../../types";
import TvNowPlaying from "./TvNowPlaying";
import type { TvNav } from "./TvNavContext";
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
const menuOf = (nav: TvNav, title: string) => {
  fireEvent.click(
    within(rowFor(title)).getByRole("button", { name: "More options" }),
  );
  const calls = vi.mocked(nav.openMenu).mock.calls;
  return calls[calls.length - 1][0].items;
};
const labels = (items: { label: string }[]) => items.map((i) => i.label);

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

describe("TvNowPlaying queue actions", () => {
  it("removes the chosen track even if the queue shifted while the menu was open", () => {
    const store = playing(mkTrack(100), [mkTrack(1), mkTrack(2), mkTrack(3)]);
    const [, b, c] = store.get(queueAtom);
    const { nav } = renderTv(<TvNowPlaying />, { store });
    const items = menuOf(nav, "T2");
    act(() => store.set(queueAtom, [b, c]));
    act(
      () =>
        void items.find((i) => i.label === "Remove from queue")!.onSelect!(),
    );
    expect(store.get(queueAtom).map((t) => t._qid)).toEqual([c._qid]);
  });

  it("moves a track up and keeps focus on it", async () => {
    const store = playing(mkTrack(100), [mkTrack(1), mkTrack(2), mkTrack(3)]);
    const [a, b, c] = store.get(queueAtom);
    const { nav } = renderTv(<TvNowPlaying />, { store });
    act(
      () =>
        void menuOf(nav, "T2").find((i) => i.label === "Move up")!.onSelect!(),
    );
    expect(store.get(queueAtom).map((t) => t._qid)).toEqual([
      b._qid,
      a._qid,
      c._qid,
    ]);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        rowFor("T2").querySelector("[data-tv-focusable]"),
      ),
    );
  });

  it("moves a context track to the top of the manual queue", () => {
    const store = playing(mkTrack(100), [mkTrack(1), mkTrack(2), mkTrack(3)]);
    const [a, b, c] = store.get(queueAtom);
    store.set(manualQueueAtom, [a]);
    store.set(queueAtom, [b, c]);
    const { nav } = renderTv(<TvNowPlaying />, { store });
    act(
      () =>
        void menuOf(nav, "T3").find((i) => i.label === "Move to top")!
          .onSelect!(),
    );
    expect(store.get(manualQueueAtom).map((t) => t._qid)).toEqual([
      c._qid,
      a._qid,
    ]);
    expect(store.get(queueAtom).map((t) => t._qid)).toEqual([b._qid]);
  });

  it("offers no Move up on the first row", () => {
    const store = playing(mkTrack(100), [mkTrack(1), mkTrack(2), mkTrack(3)]);
    const { nav } = renderTv(<TvNowPlaying />, { store });
    const first = labels(menuOf(nav, "T1"));
    expect(first).not.toContain("Move up");
    expect(first).not.toContain("Move to top");
    expect(first).toContain("Move down");
    expect(labels(menuOf(nav, "T3"))).not.toContain("Move down");
  });

  it("focuses the row that took a removed track's place", async () => {
    const store = playing(mkTrack(100), [mkTrack(1), mkTrack(2), mkTrack(3)]);
    const { nav } = renderTv(<TvNowPlaying />, { store });
    act(
      () =>
        void menuOf(nav, "T2").find((i) => i.label === "Remove from queue")!
          .onSelect!(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        rowFor("T3").querySelector("[data-tv-focusable]"),
      ),
    );
    act(
      () =>
        void menuOf(nav, "T3").find((i) => i.label === "Remove from queue")!
          .onSelect!(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        rowFor("T1").querySelector("[data-tv-focusable]"),
      ),
    );
  });

  it("plays the chosen queue track even if the queue shifted", async () => {
    const store = playing(mkTrack(100), [mkTrack(1), mkTrack(2), mkTrack(3)]);
    const [, b, c] = store.get(queueAtom);
    renderTv(<TvNowPlaying />, { store });
    const t3 = within(rowFor("T3")).getAllByRole("button")[0];
    act(() => store.set(queueAtom, [b, c]));
    fireEvent.click(t3);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "play_tidal_track",
        expect.objectContaining({ trackId: 3 }),
      ),
    );
    expect(store.get(queueAtom).map((t) => t._qid)).toEqual([b._qid]);
  });
});

describe("TvNowPlaying queue", () => {
  it("renders the queue in chunks and grows near the end", () => {
    renderTv(<TvNowPlaying />, {
      store: playing(
        mkTrack(500),
        range(100).map((i) => mkTrack(i + 1)),
      ),
    });
    expect(rows()).toHaveLength(40);
    act(() =>
      rows()[20].querySelector<HTMLElement>("[data-tv-focusable]")!.focus(),
    );
    expect(rows()).toHaveLength(80);
  });

  it("grows when a row's More options button takes focus", () => {
    renderTv(<TvNowPlaying />, {
      store: playing(
        mkTrack(500),
        range(100).map((i) => mkTrack(i + 1)),
      ),
    });
    expect(rows()).toHaveLength(40);
    act(() =>
      within(rows()[25]).getByRole("button", { name: "More options" }).focus(),
    );
    expect(rows()).toHaveLength(80);
  });

  it("labels the parts of the queue", () => {
    const store = playing(mkTrack(500), [mkTrack(1), mkTrack(2)]);
    store.set(manualQueueAtom, [mkTrack(60, { _qid: "m" })]);
    store.set(playbackSourceAtom, {
      type: "album",
      id: 5,
      name: "Blue Album",
      tracks: [],
    });
    renderTv(<TvNowPlaying />, { store });
    expect(screen.getByText("Next in queue")).toBeTruthy();
    expect(screen.getByText("Next up from Blue Album")).toBeTruthy();
  });

  it("keeps focus on a track moved down past the last shown row", async () => {
    const store = playing(
      mkTrack(500),
      range(100).map((i) => mkTrack(i + 1)),
    );
    const { nav } = renderTv(<TvNowPlaying />, { store });
    act(
      () =>
        void menuOf(nav, "T40").find((i) => i.label === "Move down")!
          .onSelect!(),
    );
    expect(store.get(queueAtom)[40].id).toBe(40);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        rowFor("T40").querySelector("[data-tv-focusable]"),
      ),
    );
  });
});
