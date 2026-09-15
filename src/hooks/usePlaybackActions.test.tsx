import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, screen, cleanup } from "@testing-library/react";
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
  manualQueueAtom,
  consecutiveFailCountAtom,
} from "../atoms/playback";
import { getProxyBlockedReason } from "../lib/errorUtils";
import type { Track } from "../types";

// playNext drives the audio backend through invoke(); stub it so play_tidal_track
// resolves and the repeat-all rebuild runs to completion. `playResult` lets a
// single case make play_tidal_track reject without disturbing the others.
let playResult: () => Promise<unknown> = () => Promise.resolve({});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "play_tidal_track") return playResult();
    return Promise.resolve({});
  }),
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

describe("a blocked proxy never enters the skip drain", () => {
  beforeEach(() => {
    localStorage.clear();
    playResult = () => Promise.resolve({});
  });

  /** As Tauri delivers it: SoneError is #[serde(tag="kind", content="message")],
   *  so ProxyBlocked's `message` is an OBJECT carrying `reason`. */
  const proxyBlocked = {
    kind: "ProxyBlocked",
    message: { reason: "proxy port must not be 0" },
  };

  it("leaves the context queue intact instead of skipping through it", async () => {
    const { store, result } = setup();
    store.set(queueAtom, tracks(3));
    playResult = () => Promise.reject(proxyBlocked);

    await act(async () => {
      await result.current.playNext();
    });

    // The failure mode this guards: a blocked proxy refuses every track
    // identically, so classifying it as "unplayable" would walk the whole queue
    // one refusal at a time and leave the user with an empty queue, three
    // "Track unavailable — skipping" toasts, and no explanation.
    expect(store.get(queueAtom).map((t) => t.id)).toEqual([1, 2, 3]);
    expect(store.get(currentTrackAtom)).toBeNull();
    // The skip counter is for tracks that are genuinely gone; a refused
    // connection must not spend it.
    expect(store.get(consecutiveFailCountAtom)).toBe(0);
    // And the user is told why, with the backend's own words — the reason lives
    // in `message.reason`, an object, so a naive read would have shown
    // "[object Object]" or the generic "Playback failed".
    expect(screen.getByText("proxy port must not be 0")).toBeTruthy();
    expect(screen.queryByText(/Track unavailable/)).toBeNull();
  });

  it("leaves the manual queue intact too", async () => {
    const { store, result } = setup();
    store.set(manualQueueAtom, tracks(2));
    store.set(queueAtom, tracks(2));
    playResult = () => Promise.reject(proxyBlocked);

    await act(async () => {
      await result.current.playNext();
    });

    expect(store.get(manualQueueAtom).map((t) => t.id)).toEqual([1, 2]);
    // Bailing out of the manual queue must not fall through into the context
    // queue either — that would drain both.
    expect(store.get(queueAtom).map((t) => t.id)).toEqual([1, 2]);
    expect(store.get(consecutiveFailCountAtom)).toBe(0);
  });

  it("still advances past a genuinely unplayable track", async () => {
    // The complement: this is the behaviour the block guard must not break.
    const { store, result } = setup();
    store.set(queueAtom, tracks(3));
    let calls = 0;
    playResult = () => {
      calls += 1;
      return calls === 1
        ? Promise.reject({ kind: "Api", message: { status: 404, body: "" } })
        : Promise.resolve({});
    };

    await act(async () => {
      await result.current.playNext();
    });

    expect(calls).toBe(2);
    expect(store.get(currentTrackAtom)?.id).toBe(2);
    expect(store.get(queueAtom).map((t) => t.id)).toEqual([3]);
  });
});

describe("repeat-one says why when a track is refused", () => {
  beforeEach(() => {
    // No vitest globals, so @testing-library's auto-cleanup never registers and
    // earlier cases' toasts linger in the document — unmount them explicitly
    // before asserting on what is NOT shown.
    cleanup();
    localStorage.clear();
    playResult = () => Promise.resolve({});
  });

  const proxyBlocked = {
    kind: "ProxyBlocked",
    message: { reason: "high-resolution audio cannot be proxied here" },
  };

  it("does not fail silently when repeat-one hits a blocked proxy", async () => {
    // Precondition: the helper already reads ProxyBlocked's object `message`.
    expect(getProxyBlockedReason(proxyBlocked)).toContain("cannot be proxied");

    const { store, result } = setup();
    store.set(repeatAtom, 2);
    store.set(currentTrackAtom, track({ id: 7, title: "Looped" }));
    playResult = () => Promise.reject(proxyBlocked);

    const seen: string[] = [];
    const onError = (e: Event) =>
      seen.push(String((e as CustomEvent).detail ?? ""));
    window.addEventListener("playback-error", onError);
    try {
      await act(async () => {
        await result.current.playNext();
      });
    } finally {
      window.removeEventListener("playback-error", onError);
    }

    // The real bug: the repeat-one chain ended at `isUnplayableError` with no
    // final `else`, so a refusal produced no toast and no event — the song just
    // stopped and nothing said why.
    expect(seen).toEqual(["high-resolution audio cannot be proxied here"]);
    // Repeat-one replays in place; the refusal must not be mistaken for a dead
    // track, and must not drop the track that is still loaded.
    expect(screen.queryByText(/Track unavailable/)).toBeNull();
    expect(store.get(currentTrackAtom)?.id).toBe(7);
  });
});
