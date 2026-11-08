import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { AlbumDetail, Paginated, PlaylistFoldersResponse } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ authTokens: { user_id: 1 } }),
}));

vi.mock("../hooks/useNavigation", () => ({
  useNavigation: () => ({
    navigateToPlaylist: vi.fn(),
    navigateToAlbum: vi.fn(),
    navigateToArtist: vi.fn(),
    navigateToMix: vi.fn(),
    navigateToPlaylistFolder: vi.fn(),
  }),
}));

vi.mock("../hooks/useMediaPlay", () => ({
  useMediaPlay: () => vi.fn(),
}));

vi.mock("../hooks/useFavorites", () => ({
  useFavorites: () => ({
    favoriteAlbumIds: new Set(),
    addFavoriteAlbum: vi.fn(),
    removeFavoriteAlbum: vi.fn(),
    favoritePlaylistUuids: new Set(),
    addFavoritePlaylist: vi.fn(),
    removeFavoritePlaylist: vi.fn(),
    followedArtistIds: new Set(),
    followArtist: vi.fn(),
    unfollowArtist: vi.fn(),
    favoriteMixIds: new Set(),
    addFavoriteMix: vi.fn(),
    removeFavoriteMix: vi.fn(),
  }),
}));

/** What LibraryViewAll last offered an in-flight scroll restore. */
let restore: { loadMore?: () => void; hasMore?: boolean } = {};
vi.mock("../hooks/useRestoreLoader", () => ({
  useRestoreLoader: (loadMore: (() => void) | undefined, hasMore: boolean) => {
    restore = { loadMore, hasMore };
  },
}));

vi.mock("./MediaCard", () => ({ default: () => null }));

const MAX_CALLS = 20;

// Favorite albums: windowed by position, with some positions counted in the
// offset and the total but left out of `items` (the shape that made Loved
// Tracks loop, see FavoritesView.pagination.test.tsx). 120 albums, two missing
// mid-list and the whole last window (100-119) missing.
const ALBUM_TOTAL = 120;
const MISSING = new Set([3, 60]);
for (let p = 100; p < ALBUM_TOTAL; p++) MISSING.add(p);

const getFavoriteAlbums = vi.fn(
  (
    _userId: number,
    offset: number,
    limit: number,
  ): Promise<Paginated<AlbumDetail>> => {
    // A paging loop that never advances would otherwise hang the test run.
    if (getFavoriteAlbums.mock.calls.length > MAX_CALLS) {
      return Promise.reject(new Error("paging did not terminate"));
    }
    const items: AlbumDetail[] = [];
    for (let p = offset; p < Math.min(offset + limit, ALBUM_TOTAL); p++) {
      if (!MISSING.has(p)) items.push({ id: p + 1, title: `Album ${p}` });
    }
    return Promise.resolve({
      items,
      totalNumberOfItems: ALBUM_TOTAL,
      offset,
      limit,
    });
  },
);

// Playlists page by cursor; `folderPages` maps the cursor sent to the page
// returned (undefined is the first page).
let folderPages: (cursor: string | undefined) => PlaylistFoldersResponse;
const getPlaylistFolders = vi.fn(
  (
    _folderId: string,
    _offset: number,
    _limit: number,
    _order: string,
    _orderDirection: string,
    _includeOnly: string | undefined,
    cursor: string | undefined,
  ): Promise<PlaylistFoldersResponse> => {
    if (getPlaylistFolders.mock.calls.length > MAX_CALLS) {
      return Promise.reject(new Error("paging did not terminate"));
    }
    return Promise.resolve(folderPages(cursor));
  },
);

function playlistPage(
  from: number,
  count: number,
  cursor: string | null,
): PlaylistFoldersResponse {
  return {
    lastModifiedAt: "",
    totalNumberOfItems: 0,
    cursor,
    items: Array.from({ length: count }, (_, i) => ({
      trn: `trn:playlist:p${from + i}`,
      itemType: "PLAYLIST" as const,
      addedAt: "",
      lastModifiedAt: "",
      name: `Playlist ${from + i}`,
      parent: null,
      data: {
        uuid: `p${from + i}`,
        title: `Playlist ${from + i}`,
        creator: { id: 1, name: null, picture: null, type: "USER" as const },
      } as PlaylistFoldersResponse["items"][number]["data"],
    })),
  };
}

vi.mock("../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tidal")>()),
  getFavoriteAlbums: (...args: [number, number, number]) =>
    getFavoriteAlbums(...args),
  getPlaylistFolders: (
    ...args: [
      string,
      number,
      number,
      string,
      string,
      string | undefined,
      string | undefined,
    ]
  ) => getPlaylistFolders(...args),
  getFlattenedPlaylists: vi.fn(() => Promise.resolve([])),
}));

import LibraryViewAll from "./LibraryViewAll";

class StubIntersectionObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  getFavoriteAlbums.mockClear();
  getPlaylistFolders.mockClear();
  restore = {};
});

function renderView(libraryType: "albums" | "playlists") {
  const store = createStore();
  return render(
    <Provider store={store}>
      <LibraryViewAll libraryType={libraryType} />
    </Provider>,
  );
}

describe("LibraryViewAll pagination (offset endpoints)", () => {
  const albumOffsets = () => getFavoriteAlbums.mock.calls.map((c) => c[1]);

  async function renderFirstPage() {
    renderView("albums");
    await waitFor(() => expect(getFavoriteAlbums).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(restore.hasMore).toBe(true));
  }

  it("requests the next window after a short page instead of re-reading the last one", async () => {
    await renderFirstPage();

    await act(async () => restore.loadMore?.());

    await waitFor(() => expect(getFavoriteAlbums).toHaveBeenCalledTimes(2));
    expect(albumOffsets()).toEqual([0, 50]);
    expect(restore.hasMore).toBe(true);
  });

  it("advances by the window on every load-more, not only after the first page", async () => {
    await renderFirstPage();

    // Two load-mores in a row: the second offset is the one loadMore itself
    // wrote after a short page (49 albums for a 50-item window).
    await act(async () => restore.loadMore?.());
    await waitFor(() => expect(getFavoriteAlbums).toHaveBeenCalledTimes(2));
    await act(async () => restore.loadMore?.());

    await waitFor(() => expect(restore.hasMore).toBe(false));
    expect(albumOffsets()).toEqual([0, 50, 100]);
  });

  it("fetches every page and stops at the total when a page comes back empty before it", async () => {
    await renderFirstPage();

    // Focusing the filter fetches every remaining page in the background.
    fireEvent.focus(screen.getByPlaceholderText(/filter by title/i));

    await waitFor(() => expect(restore.hasMore).toBe(false));
    expect(albumOffsets()).toEqual([0, 50, 100]);
  });
});

describe("LibraryViewAll pagination (playlists, cursor)", () => {
  const cursorsSent = () => getPlaylistFolders.mock.calls.map((c) => c[6]);

  it("keeps following the cursor across short pages until it runs out", async () => {
    folderPages = (cursor) =>
      cursor === undefined
        ? playlistPage(0, 30, "c1")
        : cursor === "c1"
          ? playlistPage(30, 30, "c2")
          : playlistPage(60, 10, null);
    renderView("playlists");
    await waitFor(() => expect(restore.hasMore).toBe(true));

    fireEvent.focus(screen.getByPlaceholderText(/filter by title/i));

    await waitFor(() => expect(restore.hasMore).toBe(false));
    expect(cursorsSent()).toEqual([undefined, "c1", "c2"]);
  });

  it("stops when the cursor stops moving", async () => {
    folderPages = (cursor) =>
      cursor === undefined
        ? playlistPage(0, 50, "c1")
        : playlistPage(50, 50, "c1");
    renderView("playlists");
    await waitFor(() => expect(restore.hasMore).toBe(true));

    fireEvent.focus(screen.getByPlaceholderText(/filter by title/i));

    await waitFor(() => expect(restore.hasMore).toBe(false));
    expect(cursorsSent()).toEqual([undefined, "c1"]);
  });
});
