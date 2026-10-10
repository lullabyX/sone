import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import LovedTracksBanner from "./LovedTracksBanner";
import { drawerOpenAtom } from "../atoms/ui";
import { currentTrackAtom } from "../atoms/playback";
import type { Track } from "../types";

const track = { id: 1, title: "Song", duration: 100 } as unknown as Track;

type Entry = { isIntersecting: boolean };
let observers: Array<{
  cb: (entries: Entry[]) => void;
  targets: Element[];
  disconnected: boolean;
}> = [];

beforeEach(() => {
  observers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      rec;
      constructor(cb: (entries: Entry[]) => void) {
        this.rec = { cb, targets: [] as Element[], disconnected: false };
        observers.push(this.rec);
      }
      observe(el: Element) {
        this.rec.targets.push(el);
      }
      disconnect() {
        this.rec.disconnected = true;
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderBanner({ playing = true } = {}) {
  const store = createStore();
  if (playing) store.set(currentTrackAtom, track);
  const view = render(
    <Provider store={store}>
      <LovedTracksBanner />
    </Provider>,
  );
  const root = view.container.firstElementChild as HTMLElement;
  return { store, root, ...view };
}

const paused = (el: HTMLElement) =>
  el.classList.contains("loved-banner-paused");

describe("LovedTracksBanner", () => {
  it("animates while on screen and uncovered", () => {
    const { root } = renderBanner();
    expect(root.querySelectorAll(".loved-blob")).toHaveLength(3);
    expect(paused(root)).toBe(false);
  });

  it("pauses while scrolled out of view and resumes when it comes back", () => {
    const { root } = renderBanner();
    expect(observers).toHaveLength(1);
    expect(observers[0].targets).toEqual([root]);

    act(() => observers[0].cb([{ isIntersecting: false }]));
    expect(paused(root)).toBe(true);

    act(() => observers[0].cb([{ isIntersecting: true }]));
    expect(paused(root)).toBe(false);
  });

  it("pauses while the Now Playing drawer covers it", () => {
    const { root, store } = renderBanner();
    act(() => store.set(drawerOpenAtom, true));
    expect(paused(root)).toBe(true);

    act(() => store.set(drawerOpenAtom, false));
    expect(paused(root)).toBe(false);
  });

  it("keeps animating when the drawer flag is set but nothing is playing", () => {
    // NowPlayingDrawer renders nothing without a current track, yet the
    // player bar's Lyrics and Queue buttons still set the flag.
    const { root, store } = renderBanner({ playing: false });
    act(() => store.set(drawerOpenAtom, true));
    expect(paused(root)).toBe(false);

    act(() => store.set(currentTrackAtom, track));
    expect(paused(root)).toBe(true);
  });

  it("stays paused until both the drawer is closed and the banner is visible", () => {
    const { root, store } = renderBanner();
    act(() => {
      store.set(drawerOpenAtom, true);
      observers[0].cb([{ isIntersecting: false }]);
    });
    act(() => store.set(drawerOpenAtom, false));
    expect(paused(root)).toBe(true);
    act(() => observers[0].cb([{ isIntersecting: true }]));
    expect(paused(root)).toBe(false);
  });

  it("stops observing on unmount", () => {
    const { unmount } = renderBanner();
    unmount();
    expect(observers[0].disconnected).toBe(true);
  });
});
