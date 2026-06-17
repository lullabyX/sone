import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";
import { usePlaybackActions } from "./usePlaybackActions";
import { ToastProvider } from "../contexts/ToastContext";
import { shuffleAtom, queueAtom, originalQueueAtom } from "../atoms/playback";
import type { Track } from "../types";

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
