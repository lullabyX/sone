import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";
import { PageScrollProvider } from "../contexts/PageScrollContext";
import type { Track } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../hooks/useNavigation", () => ({
  useNavigation: () => ({
    navigateToAlbum: vi.fn(),
    navigateToArtist: vi.fn(),
  }),
}));

vi.mock("../hooks/useFavorites", () => ({
  useFavorites: () => ({
    favoriteTrackIds: new Set<number>(),
    addFavoriteTrack: vi.fn(),
    removeFavoriteTrack: vi.fn(),
  }),
}));

vi.mock("../contexts/ToastContext", () => ({
  useToast: () => ({ showToast: vi.fn() }),
  ToastProvider: ({ children }: PropsWithChildren) => children,
}));

import TrackList from "./TrackList";

/** Fires with a well-formed entry so virtual-core's own observer, which reads
 *  entries[0].borderBoxSize, survives being fired alongside TrackList's. */
const observers: Array<() => void> = [];

class StubResizeObserver {
  constructor(private cb: (entries: unknown[], obs: unknown) => void) {
    observers.push(() =>
      this.cb([{ borderBoxSize: [{ inlineSize: 800, blockSize: 480 }] }], this),
    );
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

/** jsdom reports 0 for every box, so the scroller's viewport has to be faked
 *  or the virtualizer computes a zero-height window. */
function fakeViewport(el: HTMLElement, clientHeight: number) {
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(el, "offsetHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  el.getBoundingClientRect = () =>
    ({ top: 0, left: 0, width: 800, height: clientHeight }) as DOMRect;
}

function track(id: number): Track {
  return {
    id,
    title: `Track ${id}`,
    duration: 200,
    artist: { id: 1, name: "Artist" },
    artists: [{ id: 1, name: "Artist" }],
    album: { id: 10, title: "Album", cover: null },
  } as unknown as Track;
}

describe("TrackList virtualization", () => {
  beforeEach(() => {
    observers.length = 0;
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    // No per-row offsetHeight stub: rows are deliberately unmeasured, so jsdom's
    // 0 boxes cannot collapse them. Reinstating measurement breaks this file.
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("windows the rows against the provided scroll element", () => {
    const scroller = document.createElement("div");
    document.body.appendChild(scroller);
    fakeViewport(scroller, 480);

    const tracks = Array.from({ length: 500 }, (_, i) => track(i + 1));
    const store = createStore();

    const { container } = render(
      <Provider store={store}>
        <PageScrollProvider element={scroller}>
          <TrackList tracks={tracks} onPlay={vi.fn()} showCover virtualize />
        </PageScrollProvider>
      </Provider>,
    );

    // 480px of viewport at 60px per row is 8 rows plus overscan 8 — far fewer
    // than 500. Before the context change every row rendered, because the
    // virtualizer measured a height-auto page root as its own viewport.
    const rendered = container.querySelectorAll("[data-index]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(60);

    scroller.remove();
  });

  // Regression: scrollMargin used to be derived from the parent's rect plus the
  // container's scrollTop. The rows it positions — and the scroll overflow they
  // create — feed back into that rect, so each bad value produced a worse one:
  // an initially correct 736 degraded to 503, -1311, -3689 as the user scrolled,
  // translating every row thousands of pixels off-screen. The offset must not
  // depend on how far the container is scrolled.
  it("keeps the list's offset stable as the container scrolls", () => {
    const scroller = document.createElement("div");
    document.body.appendChild(scroller);
    fakeViewport(scroller, 480);

    // jsdom has no layout: give every element a fixed offsetTop and make the
    // scroller the offsetParent, so the chain walk has something real to sum.
    const offsetTop = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetTop",
    );
    const offsetParent = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetParent",
    );
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get: () => 736,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetParent", {
      configurable: true,
      get: () => scroller,
    });

    let scrollTop = 0;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => (scrollTop = v),
    });

    const tracks = Array.from({ length: 500 }, (_, i) => track(i + 1));
    const store = createStore();

    const { container } = render(
      <Provider store={store}>
        <PageScrollProvider element={scroller}>
          <TrackList tracks={tracks} onPlay={vi.fn()} showCover virtualize />
        </PageScrollProvider>
      </Provider>,
    );

    // scrollMargin cancels out of both translateY and the spacer height, so the
    // only way it shows is which rows the window selects. With the list starting
    // 736px down, a container scrolled to 11063 must show rows around
    // (11063 - 736) / 60 = 172, less the 8 overscan.
    act(() => {
      scroller.scrollTop = 11063;
      // virtual-core learns the offset from scroll events, not by polling.
      scroller.dispatchEvent(new Event("scroll"));
      observers.forEach((fire) => fire());
    });

    const firstIdx = Number(
      container.querySelector("[data-index]")!.getAttribute("data-index"),
    );
    expect(firstIdx).toBeGreaterThan(150);
    expect(firstIdx).toBeLessThan(180);

    if (offsetTop)
      Object.defineProperty(HTMLElement.prototype, "offsetTop", offsetTop);
    if (offsetParent)
      Object.defineProperty(
        HTMLElement.prototype,
        "offsetParent",
        offsetParent,
      );
    scroller.remove();
  });

  // The virtualizer scrolls its element to initialOffset when it attaches. The
  // default is 0, so a list mounting after a scroll restore would throw the
  // page back to the top and the recorder would save that 0.
  it("leaves the container's restored offset alone on mount", () => {
    const scroller = document.createElement("div");
    document.body.appendChild(scroller);
    fakeViewport(scroller, 480);
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => 1200,
    });
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo;

    const tracks = Array.from({ length: 500 }, (_, i) => track(i + 1));
    const store = createStore();

    render(
      <Provider store={store}>
        <PageScrollProvider element={scroller}>
          <TrackList tracks={tracks} onPlay={vi.fn()} showCover virtualize />
        </PageScrollProvider>
      </Provider>,
    );

    expect(scrollTo).toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalledWith(
      expect.objectContaining({ top: 0 }),
    );

    scroller.remove();
  });
});
