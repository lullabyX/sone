import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";
import { usePlaybackActions } from "./usePlaybackActions";
import { ToastProvider } from "../contexts/ToastContext";
import {
  shuffleAtom,
  queueAtom,
  originalQueueAtom,
  historyAtom,
  currentTrackAtom,
  repeatAtom,
  playbackSourceAtom,
  contextSourceAtom,
} from "../atoms/playback";
import type { Track } from "../types";

// playNext drives the audio backend through invoke(); stub it so play_tidal_track
// resolves and the repeat-all rebuild runs to completion.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

const track = (over: Partial<Track> = {}): Track =>
  ({ id: 1, title: "T", duration: 100, ...over }) as unknown as Track;

const tracks = (n: number): Track[] =>
  Array.from({ length: n }, (_, i) => track({ id: i + 1, title: `T${i + 1}` }));

function setup() {
  const store = createStore();
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>
      <ToastProvider>{children}</ToastProvider>
    </Provider>
  );
  const { result } = renderHook(() => usePlaybackActions(), { wrapper });
  return { store, result };
}

describe("setShuffledQueue keys off the current global shuffle state", () => {
  // shuffleAtom/allowExplicitAtom are atomWithStorage; reset jsdom localStorage
  // so each case starts from the atom defaults (shuffle off, explicit allowed).
  beforeEach(() => {
    localStorage.clear();
  });

  it("does NOT enable global shuffle when it was off (detail-page shuffle-play)", () => {
    const { store, result } = setup();
    act(() => {
      result.current.setShuffledQueue(tracks(5));
    });
    expect(store.get(shuffleAtom)).toBe(false);
    expect(store.get(originalQueueAtom)).toBeNull();
    expect(store.get(queueAtom)).toHaveLength(5);
  });

  it("keeps global shuffle on and saves original order when it was already on", () => {
    const { store, result } = setup();
    act(() => {
      store.set(shuffleAtom, true);
      result.current.setShuffledQueue(tracks(5));
    });
    expect(store.get(shuffleAtom)).toBe(true);
    const orig = store.get(originalQueueAtom);
    expect(orig).not.toBeNull();
    expect(orig!.map((t) => t.id)).toEqual([1, 2, 3, 4, 5]);
    expect(store.get(queueAtom)).toHaveLength(5);
  });
});

describe("repeat-all loop keeps play history for source-backed playlists", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // End-of-playlist state for a 4-track [1,2,3,4] playlist: 1-3 in history, 4
  // playing, queue drained. playNext() with repeat-all then loops back.
  function atEndOfPlaylist(store: ReturnType<typeof createStore>) {
    const all = tracks(4);
    store.set(repeatAtom, 1);
    store.set(historyAtom, [all[0], all[1], all[2]]);
    store.set(currentTrackAtom, all[3]);
    store.set(queueAtom, []);
    return all;
  }

  it("preserves history (incl. the just-finished track) when looping a playlist", async () => {
    const { store, result } = setup();
    const all = atEndOfPlaylist(store);
    store.set(playbackSourceAtom, {
      type: "playlist",
      id: "p1",
      name: "P",
      tracks: all,
    } as never);

    await act(async () => {
      await result.current.playNext();
    });

    // History survived the loop, and track 4 carried over via the natural push.
    expect(store.get(historyAtom).map((t) => t.id)).toEqual([1, 2, 3, 4]);
    // Loop restarted at the first track with the rest re-queued.
    expect(store.get(currentTrackAtom)?.id).toBe(1);
    expect(store.get(queueAtom).map((t) => t.id)).toEqual([2, 3, 4]);
  });

  it("still clears history in the no-source fallback (queue rebuilt from history)", async () => {
    const { store, result } = setup();
    atEndOfPlaylist(store);
    store.set(playbackSourceAtom, null);
    store.set(contextSourceAtom, null);

    await act(async () => {
      await result.current.playNext();
    });

    // No source → the queue is rebuilt FROM history, so clearing prevents it
    // from growing on every loop.
    expect(store.get(historyAtom)).toEqual([]);
    expect(store.get(currentTrackAtom)?.id).toBe(1);
    expect(store.get(queueAtom).map((t) => t.id)).toEqual([2, 3, 4]);
  });
});
