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

/** Records every observe() so a test can tell re-arming from a single arm. */
const observed: Element[] = [];
let liveObservers = 0;

class RecordingIntersectionObserver {
  constructor() {
    liveObservers++;
  }
  observe(el: Element) {
    observed.push(el);
  }
  disconnect() {
    liveObservers--;
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}

class StubResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
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

/** The virtualizer only windows against a real scroll container; the app always
 *  supplies one through context. */
let scroller: HTMLElement;

function renderList(tracks: Track[], onLoadMore: () => void) {
  const store = createStore();
  return render(
    <Provider store={store}>
      <PageScrollProvider element={scroller}>
        <TrackList
          tracks={tracks}
          onPlay={vi.fn()}
          onLoadMore={onLoadMore}
          hasMore
          virtualize
        />
      </PageScrollProvider>
    </Provider>,
  );
}

describe("TrackList pagination sentinel", () => {
  beforeEach(() => {
    observed.length = 0;
    liveObservers = 0;
    scroller = document.createElement("div");
    document.body.appendChild(scroller);
    vi.stubGlobal("IntersectionObserver", RecordingIntersectionObserver);
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
  });

  afterEach(() => {
    cleanup();
    scroller.remove();
    vi.unstubAllGlobals();
  });

  // Regression: a restored scroll offset can park the viewport at max scroll with
  // the sentinel already inside it. IntersectionObserver only reports threshold
  // crossings, so unless growth re-arms the observer, no further page ever loads
  // and the user cannot create a crossing by scrolling down — they are already
  // at the bottom.
  it("re-arms the sentinel observer when the track count grows", () => {
    const onLoadMore = vi.fn();
    const { rerender } = renderList([track(1), track(2)], onLoadMore);

    const armsAfterMount = observed.length;
    expect(armsAfterMount).toBeGreaterThan(0);

    const store = createStore();
    rerender(
      <Provider store={store}>
        <PageScrollProvider element={scroller}>
          <TrackList
            tracks={[track(1), track(2), track(3), track(4)]}
            onPlay={vi.fn()}
            onLoadMore={onLoadMore}
            hasMore
            virtualize
          />
        </PageScrollProvider>
      </Provider>,
    );

    expect(observed.length).toBeGreaterThan(armsAfterMount);
  });

  it("leaves no observer connected after unmount", () => {
    const { unmount } = renderList([track(1)], vi.fn());
    unmount();
    expect(liveObservers).toBe(0);
  });
});
