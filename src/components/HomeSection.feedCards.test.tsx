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

const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const openUrl = vi.fn((_url: string) => Promise.resolve());
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string) => openUrl(url),
}));

const navigateToAlbum = vi.fn();
const navigateToPlaylist = vi.fn();
const navigateToArtist = vi.fn();

vi.mock("../hooks/useNavigation", () => ({
  useNavigation: () => ({
    navigateToAlbum,
    navigateToPlaylist,
    navigateToFavorites: vi.fn(),
    navigateToViewAll: vi.fn(),
    navigateToArtist,
    navigateToMix: vi.fn(),
  }),
}));

vi.mock("../hooks/usePlaybackActions", () => ({
  usePlaybackActions: () => ({ playFromSource: vi.fn() }),
}));

vi.mock("../hooks/useMediaPlay", () => ({
  useMediaPlay: () => vi.fn(),
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

// Shapes from the v2 uploads/editorial feeds after the backend merges `data`
// up: `type` is now the artifact type, `_itemType` keeps MAGAZINE.
const playlistMagazine = {
  _itemType: "MAGAZINE",
  type: "PLAYLIST",
  id: 69421,
  imageURL:
    "https://resources.tidal.com/images/b500253b/30ed/4ae2/9172/51c8eef47188/550x400.jpg",
  artifactId: "72f59143-de09-43ac-9a16-e3d04cbcb067",
  header: "LISTEN",
  shortHeader: "Upload Headliners: The Winners",
  shortSubHeader: "Listen to the 10 tracks that came out on top.",
};

const articleMagazine = {
  _itemType: "MAGAZINE",
  type: "EXTURL",
  id: 69418,
  imageURL:
    "https://resources.tidal.com/images/e854a215/2550/4e77/a360/21d1e31b5beb/550x400.jpg",
  artifactId:
    "https://tidal.com/magazine/article/upload-headliners-annisse/1-97918",
  header: "UPLOAD HEADLINERS",
  shortHeader: "Annisse",
  shortSubHeader: "The pop/R&B vocalist wows with “Constellations”",
};

const albumItem = {
  _itemType: "ALBUM",
  id: 8,
  title: "LOVE ALL SERVE ALL",
  cover: "aaaa-bbbb",
  artists: [{ id: 1, name: "Fujii Kaze" }],
};

function renderSection(section: Record<string, unknown>) {
  const store = createStore();
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>{children}</Provider>
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<HomeSection section={section as any} />, { wrapper });
}

describe("Magazine cards (Featured, Editorial Radar)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  const featured = {
    title: "Featured",
    sectionType: "HORIZONTAL_LIST",
    items: [playlistMagazine, articleMagazine],
    hasMore: false,
  };

  it("renders the image, eyebrow, title and subtitle", async () => {
    renderSection(featured);
    expect(screen.getByText("LISTEN")).toBeTruthy();
    expect(screen.getByText("Upload Headliners: The Winners")).toBeTruthy();
    expect(
      screen.getByText("Listen to the 10 tracks that came out on top."),
    ).toBeTruthy();
    // The promo image loads through the backend image cache.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("get_image_bytes", {
        url: articleMagazine.imageURL,
      }),
    );
  });

  it("opens the playlist a card wraps", () => {
    renderSection(featured);
    fireEvent.click(screen.getByText("Upload Headliners: The Winners"));
    expect(navigateToPlaylist).toHaveBeenCalledWith(
      playlistMagazine.artifactId,
      expect.objectContaining({ title: "Upload Headliners: The Winners" }),
    );
  });

  it("opens an article card in the browser", () => {
    renderSection(featured);
    fireEvent.click(screen.getByText("Annisse"));
    expect(openUrl).toHaveBeenCalledWith(articleMagazine.artifactId);
    expect(navigateToPlaylist).not.toHaveBeenCalled();
  });
});

describe("Because you listened to — context header", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  const section = (header: Record<string, unknown>) => ({
    title: "Because you listened to",
    sectionType: "ALBUM_LIST",
    items: [albumItem],
    hasMore: false,
    header,
  });

  it("shows the source item under the row title", () => {
    renderSection(
      section({
        _itemType: "ALBUM",
        id: 7,
        title: "HELP EVER HURT NEVER",
        cover: "cccc-dddd",
      }),
    );
    expect(screen.getByText("Because you listened to")).toBeTruthy();
    expect(screen.getByText("HELP EVER HURT NEVER")).toBeTruthy();
  });

  it("opens the source album", () => {
    renderSection(
      section({
        _itemType: "ALBUM",
        id: 7,
        title: "HELP EVER HURT NEVER",
        cover: "cccc-dddd",
      }),
    );
    fireEvent.click(screen.getByText("HELP EVER HURT NEVER"));
    expect(navigateToAlbum).toHaveBeenCalledWith(7, expect.anything());
  });

  it("opens a source album even inside a mix row", () => {
    renderSection({
      ...section({
        _itemType: "ALBUM",
        id: 7,
        title: "HELP EVER HURT NEVER",
        cover: "cccc-dddd",
      }),
      sectionType: "MIX_LIST",
    });
    fireEvent.click(screen.getByText("HELP EVER HURT NEVER"));
    expect(navigateToAlbum).toHaveBeenCalledWith(7, expect.anything());
  });

  it("opens a source artist even inside an album row", () => {
    renderSection(
      section({ _itemType: "ARTIST", id: 9, name: "Fujii Kaze", picture: "eeee-ffff" }),
    );
    fireEvent.click(screen.getByText("Fujii Kaze", { selector: "h2" }));
    expect(navigateToArtist).toHaveBeenCalledWith(9, expect.anything());
    expect(navigateToAlbum).not.toHaveBeenCalled();
  });
});
