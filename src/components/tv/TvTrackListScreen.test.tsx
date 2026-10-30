import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createStore } from "jotai";
import { favoriteTrackIdsAtom } from "../../atoms/favorites";
import { allowExplicitAtom } from "../../atoms/playback";
import type { Track } from "../../types";
import TvTrackListScreen from "./TvTrackListScreen";
import { deferred, type Deferred, mkTrack, mockInvoke, range, renderTv, setupTvTest, signedIn } from "./tvTestUtils";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const api = vi.hoisted(() => ({
  getAlbumPage: vi.fn(),
  getPlaylistDetails: vi.fn(),
  getPlaylistTracksPage: vi.fn(),
  getFavoriteTracks: vi.fn(),
  getMixItems: vi.fn(),
}));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()),
  ...api,
}));

setupTvTest();

beforeEach(() => {
  for (const m of Object.values(api)) m.mockReset();
  mockInvoke({});
});

const rowButton = (title: string) => screen.getByText(title).closest("button")!;
const rowFor = (title: string) => screen.getByText(title).closest(".tv-track-row") as HTMLElement;
const rowMore = (title: string) => within(rowFor(title)).getByRole("button", { name: "More options" });

const album = (tracks: Track[]) => ({ page: { album: { id: 5, title: "LP", cover: "c" }, tracks } });

const [t1, t2] = [mkTrack(1), mkTrack(2)];

it("plays, shuffles and starts at a row through the album's source", async () => {
  api.getAlbumPage.mockResolvedValue(album([t1, t2]));
  const { nav } = renderTv(<TvTrackListScreen view={{ type: "album", id: 5 }} />);
  await screen.findByText("LP");
  const calls = vi.mocked(nav.playSource).mock;
  fireEvent.click(screen.getByRole("button", { name: "Shuffle" }));
  expect(calls.lastCall![0]).toMatchObject({ meta: { type: "album", id: 5 }, loaded: [t1, t2], albumMode: true });
  expect(calls.lastCall![1]).toEqual({ shuffle: true });
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  expect(calls.lastCall![1]).toBeUndefined();
  fireEvent.click(rowButton("T2"));
  expect(calls.lastCall![1]).toEqual({ startAt: t2 });
  expect(nav.openNowPlaying).not.toHaveBeenCalled();
});

it("a blocked row has no action menu", async () => {
  api.getAlbumPage.mockResolvedValue(album([t1, mkTrack(2, { explicit: true })]));
  const store = createStore();
  store.set(allowExplicitAtom, false);
  renderTv(<TvTrackListScreen view={{ type: "album", id: 5 }} />, { store });
  await screen.findByText("T2");
  expect(rowButton("T2").hasAttribute("data-tv-has-menu")).toBe(false);
  expect(within(rowFor("T2")).queryByRole("button", { name: "More options" })).toBeNull();
  expect(rowButton("T1").hasAttribute("data-tv-has-menu")).toBe(true);
  expect(rowMore("T1")).toBeTruthy();
});

it("after a removal focus lands on the row that took its place, past a blocked row (guard)", async () => {
  api.getPlaylistDetails.mockResolvedValue({ uuid: "p", title: "P", numberOfTracks: 5, creator: { id: 42 } });
  api.getPlaylistTracksPage.mockResolvedValue({
    items: [mkTrack(1, { explicit: true }), mkTrack(2), mkTrack(3), mkTrack(4), mkTrack(5)],
    totalNumberOfItems: 5,
  });
  mockInvoke({
    remove_track_from_playlist: () => undefined,
    get_playlist_folders: () => ({ items: [], totalNumberOfItems: 0, cursor: null }),
  });
  const store = signedIn(42);
  store.set(allowExplicitAtom, false);
  const { nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store });
  await screen.findByText("T2");
  fireEvent.click(rowMore("T2"));
  await act(() => vi.mocked(nav.trackMenu).mock.lastCall![1]![0].onSelect!());
  await waitFor(() => expect(document.activeElement).toBe(rowButton("T3")));
});

it("My Tracks renders the first page, hides un-liked rows and plays the rest lazily", async () => {
  const [a, b, c] = [mkTrack(1), mkTrack(2), mkTrack(3)];
  api.getFavoriteTracks.mockResolvedValueOnce({ items: [a, b, c], totalNumberOfItems: 250 })
    .mockResolvedValue({ items: [], totalNumberOfItems: 250 });
  const store = signedIn(42); store.set(favoriteTrackIdsAtom, new Set([1, 2, 3]));
  const { nav } = renderTv(<TvTrackListScreen view={{ type: "favorites" }} />, { store });
  await screen.findByText("T3");
  expect(api.getFavoriteTracks).toHaveBeenCalledTimes(1);
  act(() => store.set(favoriteTrackIdsAtom, new Set([1, 2])));
  expect(screen.queryByText("T3")).toBeNull();
  expect(screen.getByText(/249 tracks/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  const src = vi.mocked(nav.playSource).mock.lastCall![0];
  expect(src).toMatchObject({ meta: { type: "favorites", id: "favorites", name: "Loved Tracks" }, nextOffset: 3, hasMore: true });
  expect(src.include!(c)).toBe(false);
});

it("a failing second page keeps the rows, marks loading, and offers a retry", async () => {
  const d = deferred<{ items: Track[]; totalNumberOfItems: number }>();
  api.getFavoriteTracks
    .mockResolvedValueOnce({ items: range(30).map((i) => mkTrack(i + 1)), totalNumberOfItems: 250 })
    .mockReturnValueOnce(d.promise);
  const store = signedIn(42);
  store.set(favoriteTrackIdsAtom, new Set(range(31).map((i) => i + 1)));
  const { container } = renderTv(<TvTrackListScreen view={{ type: "favorites" }} />, { store });
  await screen.findByText("T25");
  const root = container.querySelector("[data-tv-scroll-root]")!;
  act(() => rowButton("T25").focus());
  expect(root.hasAttribute("data-tv-loading")).toBe(true);
  await act(async () => d.reject(new Error("x")));
  expect(screen.getByText("T1")).toBeTruthy();
  const again = await screen.findByRole("button", { name: "Try again" });
  expect(root.hasAttribute("data-tv-loading")).toBe(false);
  api.getFavoriteTracks.mockResolvedValueOnce({ items: [mkTrack(31)], totalNumberOfItems: 31 });
  fireEvent.click(again);
  await screen.findByText("T31");
});

describe("playlist removals", () => {
  const [a, b, c] = [mkTrack(1), mkTrack(2), mkTrack(3)];
  let pending: Deferred<void>[];
  let store: ReturnType<typeof signedIn>;
  const removeCalls = () =>
    vi.mocked(invoke).mock.calls.filter(([c]) => c === "remove_track_from_playlist").map(([, x]) => x);

  beforeEach(() => {
    api.getPlaylistDetails.mockResolvedValue({ uuid: "p", title: "P", numberOfTracks: 3, creator: { id: 42 } });
    api.getPlaylistTracksPage.mockResolvedValue({ items: [a, b, c], totalNumberOfItems: 3 });
    store = signedIn(42);
    pending = [];
    mockInvoke({
      remove_track_from_playlist: () => {
        const d = deferred<void>();
        pending.push(d);
        return d.promise;
      },
      get_playlist_folders: () => ({ items: [], totalNumberOfItems: 0, cursor: null }),
    });
  });

  it("two quick removals remove the right tracks, in order", async () => {
    const { nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store });
    await screen.findByText("T2");
    const removeEntry = (title: string) => {
      fireEvent.click(rowMore(title));
      return vi.mocked(nav.trackMenu).mock.lastCall![1]![0];
    };
    const [rb, rc] = [removeEntry("T2"), removeEntry("T3")];
    act(() => {
      void rb.onSelect!();
      void rc.onSelect!();
    });
    expect(screen.queryByText("T2")).toBeNull();
    expect(screen.queryByText("T3")).toBeNull();
    expect(screen.getByText(/\b1 Track\b/)).toBeTruthy();
    await act(async () => {});
    expect(removeCalls()).toEqual([{ playlistId: "p", index: 1 }]);
    await act(async () => pending[0].resolve());
    expect(removeCalls()).toEqual([
      { playlistId: "p", index: 1 },
      { playlistId: "p", index: 1 },
    ]);
  });

  it("a failed removal drops the queued ones and reloads the list from the server", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store });
      await screen.findByText("T2");
      const removeEntry = (title: string) => {
        fireEvent.click(rowMore(title));
        return vi.mocked(nav.trackMenu).mock.lastCall![1]![0];
      };
      const [rb, rc] = [removeEntry("T2"), removeEntry("T3")];
      act(() => {
        void rb.onSelect!();
        void rc.onSelect!();
      });
      await act(async () => {});
      // The server's list after the failed request (it did go through).
      api.getPlaylistDetails.mockResolvedValue({ uuid: "p", title: "P", numberOfTracks: 2, creator: { id: 42 } });
      api.getPlaylistTracksPage.mockResolvedValue({ items: [a, c], totalNumberOfItems: 2 });
      await act(async () => pending[0].reject(new Error("x")));
      await screen.findByText("T3");
      expect(screen.queryByText("T2")).toBeNull();
      expect(screen.getByText(/\b2 Tracks\b/)).toBeTruthy();
      expect(api.getPlaylistTracksPage).toHaveBeenCalledTimes(2);
      await screen.findByText("Failed to remove track");
      await act(async () => {});
      expect(removeCalls()).toEqual([{ playlistId: "p", index: 1 }]);
    } finally {
      quiet.mockRestore();
    }
  });

  it("no further page loads while a removal is in flight", async () => {
    const tracks = range(30).map((i) => mkTrack(i + 1));
    api.getPlaylistTracksPage.mockResolvedValue({ items: tracks, totalNumberOfItems: 250 });
    const { nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store });
    await screen.findByText("T25");
    fireEvent.click(rowMore("T2"));
    act(() => {
      void vi.mocked(nav.trackMenu).mock.lastCall![1]![0].onSelect!();
    });
    act(() => rowButton("T25").focus());
    expect(api.getPlaylistTracksPage).toHaveBeenCalledTimes(1);
    await act(async () => {});
    await act(async () => pending[0].resolve());
    act(() => rowButton("T26").focus());
    await waitFor(() => expect(api.getPlaylistTracksPage).toHaveBeenCalledTimes(2));
  });
});
