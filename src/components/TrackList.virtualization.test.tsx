import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
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

class StubResizeObserver {
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

const ROW_HEIGHT = 48;

const nativeOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight",
);

describe("TrackList virtualization", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    // The virtualizer re-measures each mounted row from its offsetHeight. jsdom
    // answers 0, which would collapse every row and grow the window to the
    // whole list, so rows report the height the real stylesheet gives them.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => ROW_HEIGHT,
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (nativeOffsetHeight) {
      Object.defineProperty(
        HTMLElement.prototype,
        "offsetHeight",
        nativeOffsetHeight,
      );
    }
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
          <TrackList tracks={tracks} onPlay={vi.fn()} virtualize />
        </PageScrollProvider>
      </Provider>,
    );

    // 480px of viewport at 48px per row is ~10 rows plus overscan 8 — far fewer
    // than 500. Before the context change every row rendered, because the
    // virtualizer measured a height-auto page root as its own viewport.
    const rendered = container.querySelectorAll('[data-track-row="true"]');
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(60);
  });
});
