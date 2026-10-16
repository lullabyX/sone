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
        playTrack: vi.fn(() => Promise.resolve()),
        playFromSource: vi.fn(() => Promise.resolve()),
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
    favoritePlaylistUuids: new Set(),
    addFavoritePlaylist: vi.fn(),
    removeFavoritePlaylist: vi.fn(),
  }),
}));

vi.mock("../hooks/usePlaylists", () => ({
  usePlaylists: () => ({
    userPlaylists: [],
    addTrackToPlaylist: vi.fn(),
    updatePlaylist: vi.fn(),
  }),
}));

vi.mock("../contexts/ToastContext", () => ({
  useToast: () => ({ showToast: vi.fn() }),
  ToastProvider: ({ children }: PropsWithChildren) => children,
}));

/** The latest props PlaylistView handed to its (sortable) track list. */
let listProps: { hasMore?: boolean; onLoadMore?: () => void } = {};
vi.mock("./TrackList", () => ({
  default: (props: {
    sortable?: boolean;
    hasMore?: boolean;
    onLoadMore?: () => void;
  }) => {
    if (props.sortable) listProps = props;
    return null;
  },
}));

// Model a playlist whose pages come back shorter than their window while every
// position still counts toward the offset and the total (the shape that made
// Loved Tracks loop, see FavoritesView.pagination.test.tsx): 250 items, a few
// missing mid-list and the whole last window (200-249) missing.
const TOTAL = 250;
const MISSING = new Set([5, 120]);
for (let p = 200; p < TOTAL; p++) MISSING.add(p);
const AVAILABLE = TOTAL - MISSING.size;
const MAX_CALLS = 20;

const getPlaylistTracksPage = vi.fn(
  (
    _playlistId: string,
    offset: number,
    limit: number,
  ): Promise<PaginatedTracks> => {
    // A paging loop that never advances would otherwise hang the test run.
    if (getPlaylistTracksPage.mock.calls.length > MAX_CALLS) {
      return Promise.reject(new Error("paging did not terminate"));
    }
    const items: Track[] = [];
    for (let p = offset; p < Math.min(offset + limit, TOTAL); p++) {
      if (!MISSING.has(p)) {
        items.push({ id: p + 1, title: `Track ${p}`, duration: 200 });
      }
    }
    return Promise.resolve({ items, totalNumberOfItems: TOTAL, offset, limit });
  },
);

vi.mock("../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tidal")>()),
  getPlaylistTracksPage: (...args: [string, number, number]) =>
    getPlaylistTracksPage(...args),
  getPlaylistRecommendations: vi.fn(() =>
    Promise.resolve({ items: [], totalNumberOfItems: 0, offset: 0, limit: 0 }),
  ),
  getPlaylistDetails: vi.fn(() => Promise.resolve({})),
}));

import PlaylistView from "./PlaylistView";

afterEach(() => {
  cleanup();
  getPlaylistTracksPage.mockClear();
  playAllFromSource.mockClear();
  appendToQueue.mockClear();
  listProps = {};
});

function renderView() {
  const store = createStore();
  return render(
    <Provider store={store}>
      <PlaylistView
        playlistId="pl-1"
        playlistInfo={{ title: "Mix", isUserPlaylist: false }}
        onBack={() => {}}
      />
    </Provider>,
  );
}

const offsets = () => getPlaylistTracksPage.mock.calls.map((c) => c[1]);

async function renderFirstPage() {
  renderView();
  await waitFor(() => expect(getPlaylistTracksPage).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(listProps.hasMore).toBe(true));
}

describe("PlaylistView pagination", () => {
  it("requests the next window after a short page instead of re-reading the last one", async () => {
    await renderFirstPage();

    await act(async () => listProps.onLoadMore?.());

    await waitFor(() => expect(getPlaylistTracksPage).toHaveBeenCalledTimes(2));
    expect(offsets()).toEqual([0, 100]);
    expect(listProps.hasMore).toBe(true);
  });

  it("advances by the window on every load-more, not only after the first page", async () => {
    await renderFirstPage();

    // Two sentinel load-mores in a row: the second offset is the one loadMore
    // itself wrote after a short page (99 items for a 100-item window).
    await act(async () => listProps.onLoadMore?.());
    await waitFor(() => expect(getPlaylistTracksPage).toHaveBeenCalledTimes(2));
    await act(async () => listProps.onLoadMore?.());

    await waitFor(() => expect(listProps.hasMore).toBe(false));
    expect(offsets()).toEqual([0, 100, 200]);
  });

  it("stops at the total when a page comes back empty before it", async () => {
    await renderFirstPage();

    // Focusing the filter fetches every remaining page in the background.
    fireEvent.focus(screen.getByPlaceholderText(/filter playlist/i));

    await waitFor(() => expect(listProps.hasMore).toBe(false));
    expect(offsets()).toEqual([0, 100, 200]);
  });

  // Play hands the loaded window and the view's next offset to the shared
  // source player, which pages the rest with the playlist pager.
  async function queuedAfter(button: RegExp) {
    await renderFirstPage();
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => expect(playAllFromSource).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(offsets()).toEqual([0, 100, 200]));
    // Give the background loader the chance to request a page too many.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(offsets()).toEqual([0, 100, 200]);
    const firstBatch = playAllFromSource.mock.calls[0][0];
    const appended = appendToQueue.mock.calls.flatMap((c) => c[0]);
    return [...firstBatch, ...appended].map((t) => t.id);
  }

  it("queues every available track exactly once when Play pages to the end", async () => {
    const queued = await queuedAfter(/^play$/i);
    expect(queued).toHaveLength(AVAILABLE);
    expect(new Set(queued).size).toBe(AVAILABLE);
  });

  it("lets Shuffle page to the end with every available track once", async () => {
    const queued = await queuedAfter(/shuffle/i);
    expect(playAllFromSource.mock.calls[0][1]).toMatchObject({ shuffle: true });
    expect(queued).toHaveLength(AVAILABLE);
    expect(new Set(queued).size).toBe(AVAILABLE);
  });
});
