import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

const navigateToAlbum = vi.fn();
const navigateToPlaylist = vi.fn();
const navigateToArtist = vi.fn();
const navigateToMix = vi.fn();
const navigateToFavorites = vi.fn();

vi.mock("../hooks/useNavigation", () => ({
  useNavigation: () => ({
    navigateToAlbum,
    navigateToPlaylist,
    navigateToArtist,
    navigateToMix,
    navigateToFavorites,
  }),
}));

const playFromSource = vi.fn();
vi.mock("../hooks/usePlaybackActions", () => ({
  usePlaybackActions: () => ({ playFromSource }),
}));

const playMedia = vi.fn();
vi.mock("../hooks/useMediaPlay", () => ({
  useMediaPlay: () => playMedia,
}));

vi.mock("../hooks/useFavorites", () => ({
  useFavorites: () => ({
    favoriteVideoIds: new Set(),
    addFavoriteVideo: vi.fn(),
    removeFavoriteVideo: vi.fn(),
    favoriteAlbumIds: new Set(),
    addFavoriteAlbum: vi.fn(),
    removeFavoriteAlbum: vi.fn(),
    followedArtistIds: new Set(),
    followArtist: vi.fn(),
    unfollowArtist: vi.fn(),
    favoritePlaylistUuids: new Set(),
    addFavoritePlaylist: vi.fn(),
    removeFavoritePlaylist: vi.fn(),
    favoriteMixIds: new Set(),
    addFavoriteMix: vi.fn(),
    removeFavoriteMix: vi.fn(),
  }),
}));

const myTracksItem = {
  _itemType: "DEEP_LINK",
  title: "My Tracks",
  id: "tidal://my-collection/tracks",
  url: "tidal://my-collection/tracks",
};

const albumItem = {
  _itemType: "ALBUM",
  id: 111,
  title: "Machine Head",
  cover: "aaaa-bbbb",
  artists: [{ id: 3355, name: "Deep Purple" }],
};

// Spread the real module: ViewAllPage's transitive imports (MediaContextMenu →
// fetchMediaTracks, AddToPlaylistMenu → getAllPlaylists, …) resolve lazily, so
// a partial mock would only explode once one of them is exercised.
// The fixtures above are read at call time inside the mocked fn, not during
// factory evaluation — do not inline them as the factory's return value.
vi.mock("../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tidal")>()),
  getPageSection: vi.fn(() =>
    Promise.resolve({
      sections: [
        { title: "Recently played", items: [albumItem, myTracksItem] },
      ],
    }),
  ),
  getArtistViewAll: vi.fn(() => Promise.resolve({ items: [], hasMore: false })),
}));

import ViewAllPage from "./ViewAllPage";

function renderPage() {
  const store = createStore();
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>{children}</Provider>
  );
  return render(
    <ViewAllPage
      title="Recently played"
      apiPath="home/pages/CONTINUE_LISTEN_TO/view-all"
      onBack={() => {}}
    />,
    { wrapper },
  );
}

describe("ViewAllPage — Loved Tracks shortcut", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("labels the deep-link card 'Loved Tracks'", async () => {
    renderPage();
    await waitFor(() => screen.getByText("Loved Tracks"));
  });

  it("navigates to favorites instead of an album", async () => {
    renderPage();
    await waitFor(() => screen.getByText("Loved Tracks"));
    fireEvent.click(screen.getByText("Loved Tracks"));
    expect(navigateToFavorites).toHaveBeenCalled();
    expect(navigateToAlbum).not.toHaveBeenCalled();
  });

  it("renders no play button on the Loved Tracks card", async () => {
    renderPage();
    await waitFor(() => screen.getByText("Loved Tracks"));
    const card = screen.getByText("Loved Tracks").closest("div.group");
    expect(card?.querySelector("button")).toBeNull();
  });

  it("still routes normal album cards to the album page", async () => {
    renderPage();
    await waitFor(() => screen.getByText("Machine Head"));
    fireEvent.click(screen.getByText("Machine Head"));
    expect(navigateToAlbum).toHaveBeenCalledWith(111, expect.anything());
  });
});
