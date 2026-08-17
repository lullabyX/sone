import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

const navigateToAlbum = vi.fn();
const navigateToPlaylist = vi.fn();
const navigateToFavorites = vi.fn();
const navigateToViewAll = vi.fn();
const navigateToArtist = vi.fn();
const navigateToMix = vi.fn();

vi.mock("../hooks/useNavigation", () => ({
  useNavigation: () => ({
    navigateToAlbum,
    navigateToPlaylist,
    navigateToFavorites,
    navigateToViewAll,
    navigateToArtist,
    navigateToMix,
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

import HomeSection from "./HomeSection";

// Shapes copied from a real v2 home feed "Recently played" section
// (moduleId CONTINUE_LISTEN_TO): items arrive unwrapped, carrying _itemType.
const trackItem = {
  _itemType: "TRACK",
  id: 140680560,
  title: "Smoke On The Water",
  duration: 228,
  artists: [{ id: 3355, name: "Deep Purple", main: true }],
  album: {
    id: 140680536,
    title: "Old But Gold 70's",
    cover: "deb458e6-00d7-4b82-9650-82571008f785",
  },
};

const otherTrackItem = {
  _itemType: "TRACK",
  id: 140680561,
  title: "Highway Star",
  duration: 367,
  artists: [{ id: 3355, name: "Deep Purple", main: true }],
  album: {
    id: 140680537,
    title: "Machine Head",
    cover: "9b2f0c1a-1111-2222-3333-44445555aaaa",
  },
};

const albumItem = {
  _itemType: "ALBUM",
  id: 111,
  title: "Machine Head",
  cover: "aaaa-bbbb",
  artists: [{ id: 3355, name: "Deep Purple" }],
  numberOfTracks: 7,
};

const playlistItem = {
  _itemType: "PLAYLIST",
  uuid: "13f9d6c8-58e6-4869-8d9b-000d0ff95f0b",
  title: "Indie Hits",
  squareImage: "e1cf1fae-5763-46e1-a0d7-651b2af21d00",
  creator: { id: 0, type: "TIDAL" },
  numberOfTracks: 51,
};

const myTracksItem = {
  _itemType: "DEEP_LINK",
  title: "My Tracks",
  id: "tidal://my-collection/tracks",
  url: "tidal://my-collection/tracks",
};

// The backend types the row from its FIRST item, so the same row arrives as
// ALBUM_LIST or TRACK_LIST depending on what was played last.
function makeSection(sectionType: string, items: unknown[]) {
  return {
    title: "Recently played",
    sectionType,
    items,
    hasMore: true,
    apiPath: "home/pages/CONTINUE_LISTEN_TO/view-all",
  };
}

function renderSection(
  section: ReturnType<typeof makeSection> = makeSection("ALBUM_LIST", [
    albumItem,
    trackItem,
    playlistItem,
    myTracksItem,
  ]),
) {
  const store = createStore();
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>{children}</Provider>
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<HomeSection section={section as any} />, { wrapper });
}

function rowFor(title: string): HTMLElement {
  const row = screen.getByText(title).closest("div.group");
  if (!row) throw new Error(`no row for ${title}`);
  return row as HTMLElement;
}

describe("Recently played — layout routing", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  // The row is typed TRACK_LIST whenever a track was played most recently.
  // It must still render as the compact grid, or album rows get handed to
  // playFromSource as if they were tracks.
  const trackFirst = makeSection("TRACK_LIST", [
    trackItem,
    albumItem,
    playlistItem,
    myTracksItem,
  ]);

  it("opens the album page when a track-first row's album is clicked", () => {
    renderSection(trackFirst);
    fireEvent.click(rowFor("Machine Head"));
    expect(navigateToAlbum).toHaveBeenCalledWith(111, expect.anything());
    expect(playFromSource).not.toHaveBeenCalled();
  });

  it("opens the playlist page when a track-first row's playlist is clicked", () => {
    renderSection(trackFirst);
    fireEvent.click(rowFor("Indie Hits"));
    expect(navigateToPlaylist).toHaveBeenCalledWith(
      "13f9d6c8-58e6-4869-8d9b-000d0ff95f0b",
      expect.anything(),
    );
    expect(playFromSource).not.toHaveBeenCalled();
  });

  it("shows the Loved Tracks shortcut in a track-first row", () => {
    renderSection(trackFirst);
    fireEvent.click(screen.getByText("Loved Tracks"));
    expect(navigateToFavorites).toHaveBeenCalled();
  });

  // Neither the title match nor the mixed veto applies here, so this row must
  // keep the original TrackListSection behavior.
  const singleTypeTracks = {
    ...makeSection("TRACK_LIST", [trackItem, otherTrackItem]),
    title: "Suggested tracks",
  };

  it("plays from a single-type track row instead of navigating", () => {
    renderSection(singleTypeTracks);
    fireEvent.click(rowFor("Smoke On The Water"));
    expect(playFromSource).toHaveBeenCalledTimes(1);
    expect(playFromSource.mock.calls[0][0]).toBe(trackItem);
    expect(navigateToAlbum).not.toHaveBeenCalled();
  });

  it("opens the album from a single-type track row's title", () => {
    renderSection(singleTypeTracks);
    fireEvent.click(screen.getByText("Highway Star"));
    expect(navigateToAlbum).toHaveBeenCalledWith(140680537, {
      title: "Machine Head",
      cover: "9b2f0c1a-1111-2222-3333-44445555aaaa",
    });
    expect(playFromSource).not.toHaveBeenCalled();
  });
});

describe("Recently played compact grid — navigation", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("opens the track's album page when the track row is clicked", () => {
    renderSection();
    fireEvent.click(rowFor("Smoke On The Water"));
    expect(navigateToAlbum).toHaveBeenCalledWith(140680536, {
      title: "Old But Gold 70's",
      cover: "deb458e6-00d7-4b82-9650-82571008f785",
    });
    expect(playFromSource).not.toHaveBeenCalled();
  });

  it("opens the album page when the track title is clicked", () => {
    renderSection();
    fireEvent.click(screen.getByText("Smoke On The Water"));
    expect(navigateToAlbum).toHaveBeenCalledWith(140680536, {
      title: "Old But Gold 70's",
      cover: "deb458e6-00d7-4b82-9650-82571008f785",
    });
    expect(playFromSource).not.toHaveBeenCalled();
  });

  it("opens the album page when an album row is clicked", () => {
    renderSection();
    fireEvent.click(rowFor("Machine Head"));
    expect(navigateToAlbum).toHaveBeenCalledWith(111, expect.anything());
  });

  it("opens the playlist page when a playlist row is clicked", () => {
    renderSection();
    fireEvent.click(rowFor("Indie Hits"));
    expect(navigateToPlaylist).toHaveBeenCalledWith(
      "13f9d6c8-58e6-4869-8d9b-000d0ff95f0b",
      expect.anything(),
    );
  });

  it("opens favorites when the Loved Tracks shortcut is clicked", () => {
    renderSection();
    fireEvent.click(rowFor("Loved Tracks"));
    expect(navigateToFavorites).toHaveBeenCalled();
  });
});

describe("Recently played compact grid — play button", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  const playButtonFor = (title: string) => {
    const button = rowFor(title).querySelector('button[aria-label^="Play"]');
    if (!button) throw new Error(`no play button for ${title}`);
    return button;
  };

  it("plays the track without navigating", () => {
    renderSection();
    fireEvent.click(playButtonFor("Smoke On The Water"));
    expect(playFromSource).toHaveBeenCalledTimes(1);
    expect(playFromSource.mock.calls[0][0]).toBe(trackItem);
    expect(playFromSource.mock.calls[0][1]).toEqual([trackItem]);
    expect(navigateToAlbum).not.toHaveBeenCalled();
  });

  it("plays the album without navigating", () => {
    renderSection();
    fireEvent.click(playButtonFor("Machine Head"));
    expect(playMedia).toHaveBeenCalledWith(
      expect.objectContaining({ type: "album", id: 111 }),
    );
    expect(navigateToAlbum).not.toHaveBeenCalled();
  });

  it("plays the playlist without navigating", () => {
    renderSection();
    fireEvent.click(playButtonFor("Indie Hits"));
    expect(playMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "playlist",
        uuid: "13f9d6c8-58e6-4869-8d9b-000d0ff95f0b",
      }),
    );
    expect(navigateToPlaylist).not.toHaveBeenCalled();
  });

  it("renders no play button for the Loved Tracks shortcut", () => {
    renderSection();
    expect(
      rowFor("Loved Tracks").querySelector('button[aria-label^="Play"]'),
    ).toBeNull();
  });

  it("plays albums from a track-first row too", () => {
    renderSection(
      makeSection("TRACK_LIST", [
        trackItem,
        albumItem,
        playlistItem,
        myTracksItem,
      ]),
    );
    fireEvent.click(playButtonFor("Machine Head"));
    expect(playMedia).toHaveBeenCalledWith(
      expect.objectContaining({ type: "album", id: 111 }),
    );
  });
});
