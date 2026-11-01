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
  getMixItems: vi.fn(),
  getTrackCredits: vi.fn(),
}));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()),
  ...api,
}));

import { invoke } from "@tauri-apps/api/core";
import type { MixPageResult } from "../../api/tidal";
import {
  allowExplicitAtom,
  currentTrackAtom,
  historyAtom,
  manualQueueAtom,
  playbackSourceAtom,
  queueAtom,
} from "../../atoms/playback";
import { tvNowPlayingTabAtom } from "../../atoms/tv";
import type { Credit, Lyrics, Track } from "../../types";
import TvNowPlaying from "./TvNowPlaying";
import type { TvNav } from "./TvNavContext";
import {
  deferred,
  mkTrack,
  mockInvoke,
  range,
  renderTv,
  setupTvTest,
  stubLayout,
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

  it("an unavailable history row toasts and plays nothing", async () => {
    const store = playing(mkTrack(100));
    store.set(historyAtom, [mkTrack(11, { streamReady: false })]);
    renderTv(<TvNowPlaying />, { store });
    focusTab("History");
    fireEvent.click(within(rowFor("T11")).getAllByRole("button")[0]);
    expect(await screen.findByText("This track isn't available")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith(
      "play_tidal_track",
      expect.anything(),
    );
  });

  it("a blocked history row toasts and plays nothing", async () => {
    const store = playing(mkTrack(100));
    store.set(historyAtom, [mkTrack(12, { explicit: true })]);
    store.set(allowExplicitAtom, false);
    renderTv(<TvNowPlaying />, { store });
    focusTab("History");
    fireEvent.click(within(rowFor("T12")).getAllByRole("button")[0]);
    expect(
      await screen.findByText(
        "Explicit content is off — turn it on in Settings › Content",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("Explicit content is turned off in Settings"),
    ).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith(
      "play_tidal_track",
      expect.anything(),
    );
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

describe("TvNowPlaying suggested tracks", () => {
  const withMix = () =>
    playing(mkTrack(1, { mixes: { TRACK_MIX: "m1" } }), [mkTrack(50)]);

  it("lists the track mix and plays a track without changing the queue", async () => {
    api.getMixItems.mockResolvedValue({
      tracks: [mkTrack(21), mkTrack(22)],
    } as MixPageResult);
    const store = withMix();
    const queue = store.get(queueAtom);
    renderTv(<TvNowPlaying />, { store });
    focusTab("Suggested");
    await screen.findByText("T21");
    expect(api.getMixItems).toHaveBeenCalledWith("m1");
    fireEvent.click(within(rowFor("T21")).getAllByRole("button")[0]);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "play_tidal_track",
        expect.objectContaining({ trackId: 21 }),
      ),
    );
    expect(store.get(queueAtom)).toBe(queue);
  });

  it("says when there are no suggestions", async () => {
    api.getMixItems.mockResolvedValue({
      tracks: [] as Track[],
    } as MixPageResult);
    renderTv(<TvNowPlaying />, { store: withMix() });
    focusTab("Suggested");
    expect(
      await screen.findByText("No suggested tracks available for this track"),
    ).toBeTruthy();
  });

  it("is not offered while a video plays", () => {
    renderTv(<TvNowPlaying />, {
      store: playing(mkTrack(9, { itemType: "video" })),
    });
    expect(screen.queryByRole("tab", { name: "Suggested" })).toBeNull();
  });
});

describe("TvNowPlaying credits", () => {
  const showCredits = async (credits: Credit[]) => {
    api.getTrackCredits.mockResolvedValue(credits);
    const r = renderTv(<TvNowPlaying />, { store: playing() });
    focusTab("Credits");
    return r;
  };

  it("opens the only credited artist of a role", async () => {
    const { nav } = await showCredits([
      {
        creditType: "Producer",
        contributors: [{ name: "A", id: 9 }, { name: "B" }],
      },
    ]);
    await screen.findByText("Producer");
    expect(screen.getByText("A, B")).toBeTruthy();
    expect(api.getTrackCredits).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: /Producer/ }));
    expect(nav.push).toHaveBeenCalledWith({ type: "artist", id: 9, name: "A" });
  });

  it("offers a menu of the credited artists of a role", async () => {
    const { nav } = await showCredits([
      {
        creditType: "Producer",
        contributors: [
          { name: "A", id: 9 },
          { name: "B" },
          { name: "C", id: 10 },
        ],
      },
    ]);
    await screen.findByText("Producer");
    fireEvent.click(screen.getByRole("button", { name: /Producer/ }));
    const spec = vi.mocked(nav.openMenu).mock.calls[0][0];
    expect(spec.title).toBe("Producer");
    expect(labels(spec.items)).toEqual(["A", "C"]);
    void spec.items[1].onSelect!();
    expect(nav.push).toHaveBeenCalledWith({
      type: "artist",
      id: 10,
      name: "C",
    });
  });

  it("leaves a role without artist pages as plain text", async () => {
    await showCredits([{ creditType: "Mixer", contributors: [{ name: "M" }] }]);
    const row = (await screen.findByText("Mixer")).closest<HTMLElement>(
      "[data-tv-focusable]",
    )!;
    expect(row.tabIndex).toBe(0);
    expect(row.getAttribute("role")).toBeNull();
    expect(screen.queryByRole("button", { name: /Mixer/ })).toBeNull();
  });

  it("says when there are no credits", async () => {
    await showCredits([]);
    expect(
      await screen.findByText("No credits available for this track"),
    ).toBeTruthy();
  });

  it("is not offered while a video plays", () => {
    renderTv(<TvNowPlaying />, {
      store: playing(mkTrack(9, { itemType: "video" })),
    });
    expect(screen.queryByRole("tab", { name: "Credits" })).toBeNull();
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

describe("TvNowPlaying refused rows", () => {
  const nextFrames = () =>
    act(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
  const pressKeepsFocus = async (title: string) => {
    const button = within(rowFor(title)).getAllByRole("button")[0];
    button.focus();
    fireEvent.click(button);
    expect(await screen.findByText("This track isn't available")).toBeTruthy();
    await nextFrames();
    expect(document.activeElement).toBe(button);
  };

  it("an unavailable Up next row keeps focus", async () => {
    const restore = stubLayout();
    try {
      renderTv(<TvNowPlaying />, {
        store: playing(mkTrack(100), [mkTrack(8, { streamReady: false })]),
      });
      await pressKeepsFocus("T8");
    } finally {
      restore();
    }
  });

  it("an unavailable History row keeps focus", async () => {
    const restore = stubLayout();
    try {
      const store = playing(mkTrack(100));
      store.set(historyAtom, [mkTrack(11, { streamReady: false })]);
      renderTv(<TvNowPlaying />, { store });
      focusTab("History");
      await pressKeepsFocus("T11");
    } finally {
      restore();
    }
  });

  it("an unavailable Suggested row keeps focus", async () => {
    const restore = stubLayout();
    try {
      api.getMixItems.mockResolvedValue({
        tracks: [mkTrack(21, { streamReady: false })],
      } as MixPageResult);
      renderTv(<TvNowPlaying />, {
        store: playing(mkTrack(1, { mixes: { TRACK_MIX: "m1" } })),
      });
      focusTab("Suggested");
      await screen.findByText("T21");
      await pressKeepsFocus("T21");
    } finally {
      restore();
    }
  });

  it("an available row still hands focus to the player", async () => {
    const restore = stubLayout();
    try {
      const store = playing(mkTrack(100));
      store.set(historyAtom, [mkTrack(11)]);
      renderTv(<TvNowPlaying />, { store });
      focusTab("History");
      const button = within(rowFor("T11")).getAllByRole("button")[0];
      button.focus();
      fireEvent.click(button);
      await nextFrames();
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /^(Play|Pause)$/ }),
      );
    } finally {
      restore();
    }
  });
});

describe("TvNowPlaying panels on a track change", () => {
  const inPanel = () =>
    document.activeElement !== document.body &&
    panel().contains(document.activeElement);
  const withLayout = async (run: () => Promise<void>) => {
    const restore = stubLayout();
    try {
      await run();
    } finally {
      restore();
    }
  };

  it("Credits keeps the last credits and focus until the next ones arrive", () =>
    withLayout(async () => {
      api.getTrackCredits.mockResolvedValueOnce([
        { creditType: "Producer", contributors: [{ name: "P" }] },
        { creditType: "Mixer", contributors: [{ name: "M" }] },
      ]);
      const { store } = renderTv(<TvNowPlaying />, { store: playing() });
      focusTab("Credits");
      const mixer = (await screen.findByText("Mixer")).closest<HTMLElement>(
        "[data-tv-focusable]",
      )!;
      act(() => mixer.focus());
      const next = deferred<Credit[]>();
      api.getTrackCredits.mockReturnValueOnce(next.promise);
      act(() => store.set(currentTrackAtom, mkTrack(2)));
      await act(async () => {});
      expect(document.activeElement).toBe(mixer);
      await act(async () =>
        next.resolve([
          { creditType: "Composer", contributors: [{ name: "C" }] },
        ]),
      );
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByText("Composer").closest("[data-tv-focusable]"),
        ),
      );
    }));

  it("Suggested keeps the last tracks and focus until the next ones arrive", () =>
    withLayout(async () => {
      api.getMixItems.mockResolvedValueOnce({
        tracks: [mkTrack(21), mkTrack(22)],
      } as MixPageResult);
      const { store } = renderTv(<TvNowPlaying />, {
        store: playing(mkTrack(1, { mixes: { TRACK_MIX: "m1" } })),
      });
      focusTab("Suggested");
      await screen.findByText("T22");
      const t22 = within(rowFor("T22")).getAllByRole("button")[0];
      act(() => t22.focus());
      const next = deferred<MixPageResult>();
      api.getMixItems.mockReturnValueOnce(next.promise);
      act(() =>
        store.set(currentTrackAtom, mkTrack(2, { mixes: { TRACK_MIX: "m2" } })),
      );
      await act(async () => {});
      expect(document.activeElement).toBe(t22);
      await act(async () =>
        next.resolve({ tracks: [mkTrack(31)] } as MixPageResult),
      );
      await waitFor(() =>
        expect(document.activeElement).toBe(
          within(rowFor("T31")).getAllByRole("button")[0],
        ),
      );
      expect(inPanel()).toBe(true);
    }));

  it("a video taking a track's place moves focus from its tabs to Up next", () =>
    withLayout(async () => {
      api.getMixItems.mockResolvedValue({
        tracks: [] as Track[],
      } as MixPageResult);
      const { store } = renderTv(<TvNowPlaying />, { store: playing() });
      const suggested = screen.getByRole("tab", { name: "Suggested" });
      act(() => suggested.focus());
      act(() => store.set(currentTrackAtom, mkTrack(9, { itemType: "video" })));
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("tab", { name: "Up next" }),
        ),
      );
    }));
});

describe("TvNowPlaying emptied queue", () => {
  const upNextTab = () => screen.getByRole("tab", { name: /^Up next/ });
  const nextFrames = () =>
    act(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );

  it("Clear queue leaves focus on the Up next tab", async () => {
    const restore = stubLayout();
    try {
      const store = playing(mkTrack(100), [mkTrack(1), mkTrack(2)]);
      const { nav } = renderTv(<TvNowPlaying />, { store });
      const items = menuOf(nav, "T1");
      act(() => within(rowFor("T1")).getAllByRole("button")[0].focus());
      act(() => void items.find((i) => i.label === "Clear queue")!.onSelect!());
      await nextFrames();
      expect(document.activeElement).toBe(upNextTab());
    } finally {
      restore();
    }
  });

  it("removing the last Up next row leaves focus on the Up next tab", async () => {
    const restore = stubLayout();
    try {
      const store = playing(mkTrack(100), [mkTrack(1)]);
      const { nav } = renderTv(<TvNowPlaying />, { store });
      const items = menuOf(nav, "T1");
      act(() => within(rowFor("T1")).getAllByRole("button")[0].focus());
      act(
        () =>
          void items.find((i) => i.label === "Remove from queue")!.onSelect!(),
      );
      await nextFrames();
      expect(document.activeElement).toBe(upNextTab());
    } finally {
      restore();
    }
  });
});
