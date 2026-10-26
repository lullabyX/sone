import { afterEach, describe, it, expect, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";
import type { PaginatedTracks, Track } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ authTokens: { user_id: 1 } }),
}));

vi.mock("../hooks/useNavigation", () => ({
  useNavigation: () => ({
    navigateToExplore: vi.fn(),
    navigateToExplorePage: vi.fn(),
  }),
}));

const playAllFromSource = vi.fn(
  (_tracks: Track[], _options?: { shuffle?: boolean }) => Promise.resolve(true),
);
const appendToQueue = vi.fn((_tracks: Track[], _options?: unknown) => {});
vi.mock("../hooks/usePlaybackActions", async () => {
  const { useStore } = await import("jotai");
  const { queueEpochAtom } = await import("../atoms/playback");
  return {
    usePlaybackActions: () => {
      const store = useStore();
      return {
        playTrack: vi.fn(),
        playFromSource: vi.fn(),
        // Replacing the queue bumps its epoch; the shared source player only
        // keeps loading pages while the queue is still the one it started.
        playAllFromSource: (
          tracks: Track[],
          options?: { shuffle?: boolean },
        ) => {
          store.set(queueEpochAtom, store.get(queueEpochAtom) + 1);
          // Copy: the player keeps growing the array it passed in.
          return playAllFromSource([...tracks], options);
        },
        appendToQueue,
        togglePlayPause: vi.fn(),
      };
    },
  };
});

vi.mock("../hooks/useFavorites", () => ({
  useFavorites: () => ({
    favoriteVideoIds: new Set(),
    addFavoriteVideo: vi.fn(),
    removeFavoriteVideo: vi.fn(),
  }),
}));

vi.mock("../contexts/ToastContext", () => ({
  useToast: () => ({ showToast: vi.fn() }),
  ToastProvider: ({ children }: PropsWithChildren) => children,
}));

/** The latest `hasMore` and `onLoadMore` FavoritesView handed to its track list. */
let listHasMore: boolean | undefined;
let listLoadMore: (() => void) | undefined;
vi.mock("./TrackList", () => ({
  default: (props: { hasMore?: boolean; onLoadMore?: () => void }) => {
    listHasMore = props.hasMore;
    listLoadMore = props.onLoadMore;
    return null;
  },
}));

// TIDAL's favorites endpoint windows by position over every favorite, then
// drops the unavailable ones from `items` while still counting them in
// totalNumberOfItems. Model that: 235 favorites, a few unavailable mid-list and
// the whole tail (230-234) unavailable.
const TOTAL = 235;
const UNAVAILABLE = new Set([5, 120, 230, 231, 232, 233, 234]);
const AVAILABLE = TOTAL - UNAVAILABLE.size;
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
      if (!UNAVAILABLE.has(p)) {
        items.push({ id: p + 1, title: `Track ${p}`, duration: 200 });
      }
    }
    return Promise.resolve({ items, totalNumberOfItems: TOTAL, offset, limit });
  },
);

vi.mock("../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tidal")>()),
  getFavoriteTracks: (...args: [number, number, number]) =>
    getFavoriteTracks(...args),
  getFavoriteVideos: vi.fn(() => Promise.resolve([])),
}));

import FavoritesView from "./FavoritesView";
import { favoriteTrackIdsAtom } from "../atoms/favorites";

afterEach(() => {
  cleanup();
  getFavoriteTracks.mockClear();
  playAllFromSource.mockClear();
  appendToQueue.mockClear();
  listHasMore = undefined;
  listLoadMore = undefined;
});

function renderView() {
  const store = createStore();
  // Every modelled track is still loved, so Play's filter keeps them all.
  store.set(
    favoriteTrackIdsAtom,
    new Set(Array.from({ length: TOTAL }, (_, p) => p + 1)),
  );
  return render(
    <Provider store={store}>
      <FavoritesView onBack={() => {}} />
    </Provider>,
  );
}

describe("FavoritesView pagination", () => {
  it("advances by the requested window and stops at the total when pages come back short", async () => {
    renderView();
    await waitFor(() => expect(getFavoriteTracks).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listHasMore).toBe(true));

    // Focusing the filter fetches every remaining page in the background.
    fireEvent.focus(screen.getByPlaceholderText(/filter on title/i));

    await waitFor(() => expect(listHasMore).toBe(false));
    const offsets = getFavoriteTracks.mock.calls.map((c) => c[1]);
    expect(offsets).toEqual([0, 100, 200]);
  });

  it("advances by the window on every load-more, not only after the first page", async () => {
    renderView();
    await waitFor(() => expect(getFavoriteTracks).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listHasMore).toBe(true));

    // Two sentinel load-mores in a row: the second offset is the one loadMore
    // itself wrote after a short page (99 tracks for a 100-item window).
    await act(async () => listLoadMore?.());
    await waitFor(() => expect(getFavoriteTracks).toHaveBeenCalledTimes(2));
    await act(async () => listLoadMore?.());

    await waitFor(() => expect(listHasMore).toBe(false));
    const offsets = getFavoriteTracks.mock.calls.map((c) => c[1]);
    expect(offsets).toEqual([0, 100, 200]);
  });

  it("Play pages the rest from the view's window offset and queues each favorite once", async () => {
    renderView();
    await waitFor(() => expect(getFavoriteTracks).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listHasMore).toBe(true));

    // Play hands the loaded window and the view's next offset to the shared
    // source player, which pages the rest with the favorites pager.
    fireEvent.click(screen.getByRole("button", { name: /^play$/i }));

    await waitFor(() => expect(playAllFromSource).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(getFavoriteTracks.mock.calls.map((c) => c[1])).toEqual([
        0, 100, 200,
      ]),
    );
    // Give the background loader the chance to request a page too many.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(getFavoriteTracks).toHaveBeenCalledTimes(3);
    const queued = [
      ...playAllFromSource.mock.calls[0][0],
      ...appendToQueue.mock.calls.flatMap((c) => c[0]),
    ].map((t) => t.id);
    expect(queued).toHaveLength(AVAILABLE);
    expect(new Set(queued).size).toBe(AVAILABLE);
  });
});
