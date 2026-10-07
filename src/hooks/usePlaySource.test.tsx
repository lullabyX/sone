import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  renderHook,
  act,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";
import { usePlaySource } from "./usePlaySource";
import { usePlaybackActions } from "./usePlaybackActions";
import { ToastProvider } from "../contexts/ToastContext";
import {
  shuffleAtom,
  queueAtom,
  currentTrackAtom,
  playbackSourceAtom,
  contextSourceAtom,
  allowExplicitAtom,
} from "../atoms/playback";
import type { TrackPage } from "../lib/trackSources";
import type { Track } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve({})),
}));

const mk = (id: number, over: Partial<Track> = {}) =>
  ({ id, title: `T${id}`, duration: 100, ...over }) as unknown as Track;
const range = (from: number, to: number, over: Partial<Track> = {}) =>
  Array.from({ length: to - from + 1 }, (_, i) => mk(from + i, over));
const ids = (ts: Track[]) => ts.map((t) => t.id);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const meta = { type: "playlist", id: "p1", name: "P" };

function setup() {
  const store = createStore();
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>
      <ToastProvider>{children}</ToastProvider>
    </Provider>
  );
  const { result } = renderHook(
    () => ({ play: usePlaySource(), actions: usePlaybackActions() }),
    { wrapper },
  );
  return { store, result };
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("usePlaySource", () => {
  it("plays a complete source in order without fetching", async () => {
    const { store, result } = setup();
    let started = false;
    await act(async () => {
      started = await result.current.play({ meta, loaded: range(1, 5) });
    });
    expect(started).toBe(true);
    expect(store.get(currentTrackAtom)?.id).toBe(1);
    expect(ids(store.get(queueAtom))).toEqual([2, 3, 4, 5]);
    expect(store.get(playbackSourceAtom)?.tracks).toHaveLength(5);
  });

  it("waits for a first batch when only a short preview is loaded (deduped)", async () => {
    const { store, result } = setup();
    const fetchPage = vi.fn(
      async (): Promise<TrackPage> => ({ items: range(1, 50), hasMore: false }),
    );
    await act(async () => {
      await result.current.play({
        meta,
        loaded: range(1, 4),
        nextOffset: 0,
        fetchPage,
        dedupe: true,
      });
    });
    expect(fetchPage).toHaveBeenCalledWith(0);
    expect(store.get(currentTrackAtom)?.id).toBe(1);
    expect(ids(store.get(queueAtom))).toEqual(ids(range(2, 50)));
  });

  it("appends the remaining pages in order in the background", async () => {
    const { store, result } = setup();
    const fetchPage = vi.fn(
      async (offset: number): Promise<TrackPage> =>
        offset === 50
          ? { items: range(51, 100), hasMore: true }
          : { items: range(101, 120), hasMore: false },
    );
    await act(async () => {
      await result.current.play({ meta, loaded: range(1, 50), fetchPage });
    });
    await waitFor(() => expect(store.get(queueAtom)).toHaveLength(119));
    expect(ids(store.get(queueAtom))).toEqual(ids(range(2, 120)));
    expect(store.get(playbackSourceAtom)?.tracks).toHaveLength(120);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("shuffle scatters later pages into the queue and leaves shuffle mode off", async () => {
    const { store, result } = setup();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const page = deferred<TrackPage>();
    await act(async () => {
      await result.current.play(
        { meta, loaded: range(1, 50), fetchPage: () => page.promise },
        { shuffle: true },
      );
    });
    const head = store.get(queueAtom)[0].id;
    await act(async () => {
      page.resolve({ items: range(51, 60), hasMore: false });
    });
    await waitFor(() => expect(store.get(queueAtom)).toHaveLength(59));
    expect(store.get(shuffleAtom)).toBe(false);
    // Math.random() === 0 inserts every appended track right after the head.
    expect(store.get(queueAtom)[0].id).toBe(head);
    expect(store.get(queueAtom)[1].id).toBe(60);
  });

  it("starts at once from a clicked, already-loaded track and does not wrap", async () => {
    const { store, result } = setup();
    const page = deferred<TrackPage>();
    const fetchPage = vi.fn(() => page.promise);
    const loaded = range(1, 4);
    await act(async () => {
      await result.current.play(
        { meta, loaded, nextOffset: 0, fetchPage, dedupe: true },
        { startAt: loaded[2] },
      );
    });
    expect(store.get(currentTrackAtom)?.id).toBe(3);
    expect(ids(store.get(queueAtom))).toEqual([4]);
    await act(async () => {
      page.resolve({ items: range(1, 8), hasMore: false });
    });
    await waitFor(() =>
      expect(ids(store.get(queueAtom))).toEqual([4, 5, 6, 7, 8]),
    );
  });

  it("shuffle mode + click keeps every loaded track", async () => {
    const { store, result } = setup();
    store.set(shuffleAtom, true);
    const page = deferred<TrackPage>();
    const loaded = range(1, 100);
    await act(async () => {
      await result.current.play(
        { meta, loaded, fetchPage: () => page.promise },
        { startAt: loaded[79] },
      );
    });
    expect(store.get(currentTrackAtom)?.id).toBe(80);
    expect(store.get(queueAtom)).toHaveLength(99);
  });

  it("stops when another source replaces the queue", async () => {
    const { store, result } = setup();
    const page = deferred<TrackPage>();
    await act(async () => {
      await result.current.play({
        meta,
        loaded: range(1, 50),
        fetchPage: () => page.promise,
      });
    });
    act(() => {
      result.current.actions.setQueueTracks([]);
    });
    await act(async () => {
      page.resolve({ items: range(51, 60), hasMore: false });
    });
    expect(store.get(queueAtom)).toHaveLength(0);
    expect(store.get(playbackSourceAtom)).toBeNull();
  });

  it("another queue replacement during the wait cancels the press", async () => {
    const { store, result } = setup();
    const page = deferred<TrackPage>();
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.play({
        meta: { type: "artist", id: 7, name: "A" },
        loaded: [],
        fetchPage: () => page.promise,
      });
    });
    act(() => {
      // what a search-result click does
      result.current.actions.setQueueTracks([]);
    });
    await act(async () => {
      page.resolve({ items: range(1, 50), hasMore: false });
      expect(await pending).toBe(false);
    });
    expect(store.get(currentTrackAtom)).toBeNull();
  });

  it("stops fetching the start batch once the queue is replaced", async () => {
    const { result } = setup();
    const first = deferred<TrackPage>();
    const fetchPage = vi.fn(
      (offset: number): Promise<TrackPage> =>
        offset === 0
          ? first.promise
          : Promise.resolve({
              items: range(offset + 1, offset + 10),
              hasMore: true,
            }),
    );
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.play({ meta, loaded: [], fetchPage });
    });
    act(() => {
      result.current.actions.setQueueTracks([]);
    });
    await act(async () => {
      first.resolve({ items: range(1, 10), hasMore: true });
      expect(await pending).toBe(false);
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("keeps loading while a sourced Play-next item plays", async () => {
    const { store, result } = setup();
    const page = deferred<TrackPage>();
    await act(async () => {
      await result.current.play({
        meta,
        loaded: range(1, 50),
        fetchPage: () => page.promise,
      });
    });
    // What playNext does when a manual item with its own source starts.
    act(() => {
      store.set(contextSourceAtom, store.get(playbackSourceAtom));
      store.set(playbackSourceAtom, {
        type: "album",
        id: 5,
        name: "A",
        tracks: [],
      } as never);
    });
    await act(async () => {
      page.resolve({ items: range(51, 60), hasMore: false });
    });
    await waitFor(() => expect(store.get(queueAtom)).toHaveLength(59));
    expect(store.get(contextSourceAtom)?.tracks).toHaveLength(60);
    expect(store.get(playbackSourceAtom)?.tracks).toHaveLength(0);
  });

  it("a newer request supersedes a pending one", async () => {
    const { store, result } = setup();
    const pageA = deferred<TrackPage>();
    const pageB = deferred<TrackPage>();
    let a!: Promise<boolean>;
    let b!: Promise<boolean>;
    act(() => {
      a = result.current.play({
        meta: { type: "artist", id: 1, name: "A" },
        loaded: [],
        fetchPage: () => pageA.promise,
      });
      b = result.current.play({
        meta: { type: "artist", id: 2, name: "B" },
        loaded: [],
        fetchPage: () => pageB.promise,
      });
    });
    await act(async () => {
      pageA.resolve({ items: range(1, 50), hasMore: false });
      expect(await a).toBe(false);
    });
    expect(store.get(currentTrackAtom)).toBeNull();
    await act(async () => {
      pageB.resolve({ items: range(101, 150), hasMore: false });
      expect(await b).toBe(true);
    });
    expect(store.get(currentTrackAtom)?.id).toBe(101);
  });

  it("dedupe sources stop when a page adds nothing new", async () => {
    const { store, result } = setup();
    const fetchPage = vi.fn(
      async (): Promise<TrackPage> => ({ items: range(1, 50), hasMore: true }),
    );
    await act(async () => {
      await result.current.play({
        meta,
        loaded: range(1, 50),
        fetchPage,
        dedupe: true,
      });
    });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(store.get(queueAtom)).toHaveLength(49);
  });

  it("a failed newer press does not stop the current source loading", async () => {
    const { store, result } = setup();
    const page = deferred<TrackPage>();
    await act(async () => {
      await result.current.play({
        meta,
        loaded: range(1, 50),
        fetchPage: () => page.promise,
      });
    });
    store.set(allowExplicitAtom, false);
    let started = true;
    await act(async () => {
      started = await result.current.play({
        meta: { type: "album", id: 9, name: "E" },
        loaded: range(201, 203, { explicit: true }),
      });
    });
    expect(started).toBe(false);
    expect(screen.getByText("No playable tracks")).toBeTruthy();
    await act(async () => {
      page.resolve({ items: range(51, 60), hasMore: false });
    });
    await waitFor(() => expect(store.get(queueAtom)).toHaveLength(59));
    expect(ids(store.get(queueAtom))).toEqual(ids(range(2, 60)));
  });

  it("dedupe + include keeps paging past a page whose new ids are all excluded", async () => {
    const { store, result } = setup();
    const fetchPage = vi.fn(
      async (offset: number): Promise<TrackPage> =>
        offset === 50
          ? { items: range(51, 60), hasMore: true }
          : { items: range(61, 70), hasMore: false },
    );
    await act(async () => {
      await result.current.play({
        meta,
        loaded: range(1, 50),
        fetchPage,
        dedupe: true,
        include: (t) => t.id <= 50 || t.id > 60,
      });
    });
    await waitFor(() => expect(store.get(queueAtom)).toHaveLength(59));
    expect(fetchPage).toHaveBeenCalledWith(60);
    expect(ids(store.get(queueAtom))).toEqual([
      ...ids(range(2, 50)),
      ...ids(range(61, 70)),
    ]);
  });

  it("non-dedupe sources keep repeated entries", async () => {
    const { store, result } = setup();
    await act(async () => {
      await result.current.play({
        meta,
        loaded: [mk(1), mk(2), mk(1), mk(3)],
      });
    });
    expect(ids(store.get(queueAtom))).toEqual([2, 1, 3]);
  });

  it("applies include to loaded tracks and to every page", async () => {
    const { store, result } = setup();
    const fetchPage = vi.fn(
      async (): Promise<TrackPage> => ({
        items: range(51, 60),
        hasMore: false,
      }),
    );
    await act(async () => {
      await result.current.play({
        meta,
        loaded: range(1, 50),
        fetchPage,
        include: (t) => t.id % 2 === 1,
      });
    });
    await waitFor(() => expect(store.get(queueAtom)).toHaveLength(29));
    expect(store.get(queueAtom).every((t) => t.id % 2 === 1)).toBe(true);
    expect(fetchPage).toHaveBeenCalledWith(50);
  });

  it("drops unavailable tracks from appended pages", async () => {
    const { store, result } = setup();
    const fetchPage = vi.fn(
      async (): Promise<TrackPage> => ({
        items: [...range(51, 53, { streamReady: false }), mk(54)],
        hasMore: false,
      }),
    );
    await act(async () => {
      await result.current.play({ meta, loaded: range(1, 50), fetchPage });
    });
    await waitFor(() => expect(store.get(queueAtom)).toHaveLength(50));
    expect(ids(store.get(queueAtom))).not.toContain(51);
  });

  it("fetches past an unplayable first page", async () => {
    const { store, result } = setup();
    store.set(allowExplicitAtom, false);
    const fetchPage = vi.fn(
      async (offset: number): Promise<TrackPage> =>
        offset === 0
          ? { items: range(1, 50, { explicit: true }), hasMore: true }
          : { items: range(51, 60), hasMore: false },
    );
    await act(async () => {
      await result.current.play({ meta, loaded: [], fetchPage });
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(store.get(currentTrackAtom)?.id).toBe(51);
  });

  it("says so when nothing is playable", async () => {
    const { store, result } = setup();
    store.set(allowExplicitAtom, false);
    let started = true;
    await act(async () => {
      started = await result.current.play({
        meta,
        loaded: range(1, 3, { explicit: true }),
      });
    });
    expect(started).toBe(false);
    expect(store.get(currentTrackAtom)).toBeNull();
    expect(screen.getByText("No playable tracks")).toBeTruthy();
  });

  it("keeps what it has when a background page fails", async () => {
    const { store, result } = setup();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchPage = vi.fn(async () => {
      throw new Error("offline");
    });
    await act(async () => {
      await result.current.play({ meta, loaded: range(1, 50), fetchPage });
    });
    await waitFor(() => expect(err).toHaveBeenCalled());
    expect(store.get(queueAtom)).toHaveLength(49);
  });

  it("shows a toast when nothing could be loaded", async () => {
    const { store, result } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let started = true;
    await act(async () => {
      started = await result.current.play({
        meta,
        loaded: [],
        fetchPage: async () => {
          throw new Error("offline");
        },
      });
    });
    expect(started).toBe(false);
    expect(store.get(currentTrackAtom)).toBeNull();
    expect(screen.getByText("Couldn't load tracks")).toBeTruthy();
  });
});
