import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";
import { queueAtom, currentTrackAtom } from "../atoms/playback";
import { ToastProvider } from "../contexts/ToastContext";
import type { PaginatedTracks, Track } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve({})),
}));

// TIDAL's favorites endpoint windows by position over every favorite, then
// drops the unavailable ones from `items` while still counting them in
// totalNumberOfItems. Model that: 450 favorites, two unavailable mid-list, a
// whole window (200-299) unavailable, and the last window (400-449) too, so
// pages come back short and two of them empty while offset < total.
const TOTAL = 450;
const isUnavailable = (p: number) =>
  p === 5 || p === 120 || (p >= 200 && p < 300) || p >= 400;
const AVAILABLE = Array.from({ length: TOTAL }, (_, p) => p).filter(
  (p) => !isUnavailable(p),
);
const MAX_CALLS = 20;

const getFavoriteTracks = vi.fn(
  (
    _userId: number,
    offset: number,
    limit: number,
  ): Promise<PaginatedTracks> => {
    // A paging loop that never advances would otherwise hang the test run.
    if (getFavoriteTracks.mock.calls.length > MAX_CALLS) {
      return Promise.reject(new Error("paging did not terminate"));
    }
    const items: Track[] = [];
    for (let p = offset; p < Math.min(offset + limit, TOTAL); p++) {
      if (!isUnavailable(p)) {
        items.push({ id: p + 1, title: `Track ${p}`, duration: 200 } as Track);
      }
    }
    return Promise.resolve({ items, totalNumberOfItems: TOTAL, offset, limit });
  },
);

vi.mock("../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tidal")>()),
  getFavoriteTracks: (...args: [number, number, number]) =>
    getFavoriteTracks(...args),
}));

import { usePlaySource } from "./usePlaySource";
import { favoriteTracksPager, type TrackPage } from "../lib/trackSources";

const meta = { type: "favorites", id: "favorites", name: "Loved Tracks" };

function setup() {
  const store = createStore();
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>
      <ToastProvider>{children}</ToastProvider>
    </Provider>
  );
  const { result } = renderHook(() => usePlaySource(), { wrapper });
  return { store, play: () => result.current };
}

/** Lets the background loader run any page it would still request. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  getFavoriteTracks.mockClear();
});

describe("usePlaySource over TIDAL's short favorites pages", () => {
  it("queues every available favorite once, across short and empty windows", async () => {
    const { store, play } = setup();
    await act(async () => {
      await play()({
        meta,
        loaded: [],
        fetchPage: favoriteTracksPager(1, "DATE", "DESC"),
      });
    });

    await waitFor(() =>
      expect(getFavoriteTracks.mock.calls.map((c) => c[1])).toEqual([
        0, 100, 200, 300, 400,
      ]),
    );
    await settle();
    expect(getFavoriteTracks).toHaveBeenCalledTimes(5);

    const played = [
      store.get(currentTrackAtom)!.id,
      ...store.get(queueAtom).map((t) => t.id),
    ];
    expect(played).toEqual(AVAILABLE.map((p) => p + 1));
  });

  it("resumes from a view's window offset without re-reading what it loaded", async () => {
    const { store, play } = setup();
    // What FavoritesView hands over after its first page: the 99 tracks of
    // window 0-99 and the next window's offset.
    const firstWindow = AVAILABLE.filter((p) => p < 100).map(
      (p) => ({ id: p + 1, title: `Track ${p}`, duration: 200 }) as Track,
    );
    await act(async () => {
      await play()({
        meta,
        loaded: firstWindow,
        nextOffset: 100,
        hasMore: true,
        fetchPage: favoriteTracksPager(1, "DATE", "DESC"),
      });
    });

    await waitFor(() =>
      expect(getFavoriteTracks.mock.calls.map((c) => c[1])).toEqual([
        100, 200, 300, 400,
      ]),
    );
    await settle();
    const played = [
      store.get(currentTrackAtom)!.id,
      ...store.get(queueAtom).map((t) => t.id),
    ];
    expect(played).toEqual(AVAILABLE.map((p) => p + 1));
  });

  it("stops on an empty page from a pager that advances by the items received", async () => {
    const { store, play } = setup();
    // No nextOffset and a stale hasMore: requesting again would ask for the
    // same offset forever.
    const fetchPage = vi.fn(
      async (): Promise<TrackPage> => ({ items: [], hasMore: true }),
    );
    const loaded = AVAILABLE.slice(0, 60).map(
      (p) => ({ id: p + 1, title: `Track ${p}`, duration: 200 }) as Track,
    );
    await act(async () => {
      await play()({ meta, loaded, fetchPage });
    });
    await settle();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith(60);
    expect(store.get(queueAtom)).toHaveLength(59);
  });
});
