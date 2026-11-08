import { beforeEach, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { normalizePlaylistFolders } from "../../api/tidal";
import { albumSortAtom } from "../../atoms/favorites";
import {
  deletedPlaylistIdsAtom,
  renamedFoldersAtom,
} from "../../atoms/playlists";
import TvListScreen from "./TvListScreen";
import type { TvPromptRequest } from "./TvPrompt";
import { menuForElement } from "./tvMenu";
import {
  deferred,
  range,
  rawFolderItem,
  rawPlaylistItem,
  renderTv,
  setupTvTest,
  signedIn,
  stubLayout,
} from "./tvTestUtils";

setupTvTest();
const api = vi.hoisted(() => ({
  getFavoriteAlbums: vi.fn(),
  getPlaylistFolders: vi.fn(),
  getFavoriteVideos: vi.fn(),
  getArtistViewAll: vi.fn(),
  getFlattenedPlaylists: vi.fn(),
}));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()),
  ...api,
}));

beforeEach(() => {
  for (const m of Object.values(api)) m.mockReset();
});

const albums = (from: number, to: number) =>
  range(to - from + 1).map((i) => ({
    id: from + i,
    title: `Album ${from + i}`,
    cover: "c",
  }));
const cardOf = (title: string) => screen.getByText(title).closest("button")!;

it("shows the first page and fetches more only near the end", async () => {
  api.getFavoriteAlbums
    .mockResolvedValueOnce({ items: albums(1, 50), totalNumberOfItems: 120 })
    .mockResolvedValue({ items: albums(51, 100), totalNumberOfItems: 120 });
  renderTv(
    <TvListScreen
      title="Albums"
      source={{ kind: "collection", what: "albums" }}
    />,
    { store: signedIn(42) },
  );
  await screen.findByText("Album 50");
  expect(api.getFavoriteAlbums).toHaveBeenCalledTimes(1);
  act(() => cardOf("Album 45").focus());
  await waitFor(() =>
    expect(api.getFavoriteAlbums).toHaveBeenLastCalledWith(
      42,
      50,
      50,
      "DATE",
      "DESC",
    ),
  );
  expect(await screen.findByText("Album 100")).toBeTruthy();
});

it("a folder list loads that folder and its cards carry it", async () => {
  api.getPlaylistFolders.mockResolvedValue({
    items: [rawPlaylistItem("p1", "One")],
    totalNumberOfItems: 1,
    cursor: null,
  });
  const { nav } = renderTv(
    <TvListScreen
      title="Road"
      source={{ kind: "collection", what: "playlists", folderId: "f1" }}
    />,
    { store: signedIn(42) },
  );
  await screen.findByText("One");
  expect(api.getPlaylistFolders).toHaveBeenCalledWith(
    "f1",
    0,
    50,
    "DATE_UPDATED",
    "DESC",
    undefined,
    undefined,
  );
  menuForElement(cardOf("One"))!();
  expect(vi.mocked(nav.mediaMenu).mock.lastCall).toEqual([
    expect.objectContaining({ type: "playlist", uuid: "p1" }),
    false,
    { folderId: "f1" },
  ]);
});

it("an artist's View all badges explicit cards; a collection list does not", async () => {
  const loud = { id: 7, title: "Loud", cover: "c", explicit: true };
  api.getArtistViewAll.mockResolvedValue({ items: [loud], hasMore: false });
  const r = renderTv(
    <TvListScreen
      title="X: Albums"
      source={{ kind: "artist", artistId: 9, apiPath: "v" }}
    />,
    { store: signedIn(42) },
  );
  await screen.findByText("Loud");
  expect(within(cardOf("Loud")).getByText("E")).toBeTruthy();
  r.unmount();
  api.getFavoriteAlbums.mockResolvedValue({
    items: [loud],
    totalNumberOfItems: 1,
  });
  renderTv(
    <TvListScreen
      title="Albums"
      source={{ kind: "collection", what: "albums" }}
    />,
    { store: signedIn(42) },
  );
  await screen.findByText("Loud");
  expect(within(cardOf("Loud")).queryByText("E")).toBeNull();
});

it("Try again after a failed page re-fetches it and focuses the first new card", async () => {
  api.getFavoriteAlbums
    .mockResolvedValueOnce({ items: albums(1, 50), totalNumberOfItems: 120 })
    .mockRejectedValueOnce(new Error("down"))
    .mockResolvedValue({ items: albums(51, 100), totalNumberOfItems: 120 });
  renderTv(
    <TvListScreen
      title="Albums"
      source={{ kind: "collection", what: "albums" }}
    />,
    { store: signedIn(42) },
  );
  await screen.findByText("Album 50");
  act(() => cardOf("Album 45").focus());
  const again = await screen.findByRole("button", { name: "Try again" });
  act(() => again.focus());
  fireEvent.click(again);
  expect(await screen.findByText("Album 100")).toBeTruthy();
  expect(api.getFavoriteAlbums).toHaveBeenCalledTimes(3);
  expect(api.getFavoriteAlbums).toHaveBeenLastCalledWith(
    42,
    50,
    50,
    "DATE",
    "DESC",
  );
  expect(document.activeElement).toBe(cardOf("Album 51"));
});

it("a page that adds no cards offers Load more, which fetches the next page", async () => {
  const store = signedIn(42);
  store.set(deletedPlaylistIdsAtom, new Set(["p2"]));
  api.getPlaylistFolders
    .mockResolvedValueOnce({
      items: [rawPlaylistItem("p1", "One")],
      totalNumberOfItems: 3,
      cursor: "c1",
    })
    .mockResolvedValueOnce({
      items: [rawPlaylistItem("p2", "Two")],
      totalNumberOfItems: 3,
      cursor: "c2",
    })
    .mockResolvedValue({
      items: [rawPlaylistItem("p3", "Three")],
      totalNumberOfItems: 3,
      cursor: null,
    });
  renderTv(
    <TvListScreen
      title="Playlists"
      source={{ kind: "collection", what: "playlists" }}
    />,
    { store },
  );
  await screen.findByText("One");
  act(() => cardOf("One").focus());
  await waitFor(() => expect(api.getPlaylistFolders).toHaveBeenCalledTimes(2));
  expect(api.getPlaylistFolders).toHaveBeenLastCalledWith(
    "root",
    1,
    50,
    "DATE_UPDATED",
    "DESC",
    undefined,
    "c1",
  );
  const more = await screen.findByRole("button", { name: "Load more" });
  expect(screen.queryByText("Two")).toBeNull();
  act(() => more.focus());
  fireEvent.click(more);
  expect(await screen.findByText("Three")).toBeTruthy();
  expect(api.getPlaylistFolders).toHaveBeenLastCalledWith(
    "root",
    2,
    50,
    "DATE_UPDATED",
    "DESC",
    undefined,
    "c2",
  );
  expect(document.activeElement).toBe(cardOf("Three"));
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

it("marks the list as loading while a page is in flight", async () => {
  const page2 = deferred<{ items: unknown[]; totalNumberOfItems: number }>();
  api.getFavoriteAlbums
    .mockResolvedValueOnce({ items: albums(1, 50), totalNumberOfItems: 120 })
    .mockReturnValueOnce(page2.promise);
  const { container } = renderTv(
    <TvListScreen
      title="Albums"
      source={{ kind: "collection", what: "albums" }}
    />,
    { store: signedIn(42) },
  );
  await screen.findByText("Album 50");
  expect(container.querySelector("[data-tv-loading]")).toBeNull();
  act(() => cardOf("Album 45").focus());
  await waitFor(() =>
    expect(container.querySelector("[data-tv-loading]")).not.toBeNull(),
  );
  expect(screen.getByRole("status", { name: "Loading more" })).toBeTruthy();
  await act(async () =>
    page2.resolve({ items: albums(51, 100), totalNumberOfItems: 120 }),
  );
  await screen.findByText("Album 100");
  expect(container.querySelector("[data-tv-loading]")).toBeNull();
  expect(screen.queryByRole("status", { name: "Loading more" })).toBeNull();
});

it("an artist grid's cards carry no folder", async () => {
  api.getArtistViewAll.mockResolvedValue({
    items: [{ id: 7, title: "Loud", cover: "c" }],
    hasMore: false,
  });
  const { nav } = renderTv(
    <TvListScreen
      title="X: Albums"
      source={{ kind: "artist", artistId: 9, apiPath: "v" }}
    />,
    { store: signedIn(42) },
  );
  await screen.findByText("Loud");
  menuForElement(cardOf("Loud"))!();
  expect(vi.mocked(nav.mediaMenu).mock.lastCall![2]).toBeUndefined();
});

const albumsScreen = (
  prompt?: (r: TvPromptRequest) => Promise<string | null>,
) =>
  renderTv(
    <TvListScreen
      title="Albums"
      source={{ kind: "collection", what: "albums" }}
    />,
    { store: signedIn(42), nav: prompt ? { prompt } : undefined },
  );
const cardCount = (container: HTMLElement) =>
  container.querySelectorAll("[data-tv-index]").length;

it("sorts with the shared preference, keeping focus on Sort while it reloads", async () => {
  api.getFavoriteAlbums.mockResolvedValue({
    items: albums(1, 3),
    totalNumberOfItems: 3,
  });
  const { nav, store } = albumsScreen();
  await screen.findByText("Album 1");
  const sort = screen.getByRole("button", { name: "Sort: Date added" });
  act(() => sort.focus());
  fireEvent.click(sort);
  const spec = vi.mocked(nav.openMenu).mock.lastCall![0];
  expect(spec.items.find((i) => i.checked)!.label).toBe("Date added");
  await act(async () => {
    await spec.items.find((i) => i.label === "Name")!.onSelect!();
  });
  await waitFor(() => expect(api.getFavoriteAlbums).toHaveBeenCalledTimes(2));
  expect(api.getFavoriteAlbums).toHaveBeenLastCalledWith(
    42,
    0,
    50,
    "NAME",
    "ASC",
  );
  expect(store.get(albumSortAtom)).toEqual({ order: "NAME", direction: "ASC" });
  await screen.findByText("Album 1");
  expect(document.activeElement).toBe(sort);
  expect(sort.getAttribute("aria-label")).toBe("Sort: Name");
});

it("filters after loading everything", async () => {
  api.getFavoriteAlbums
    .mockResolvedValueOnce({
      items: albums(1, 50).map((a) =>
        a.id === 7 ? { ...a, title: "Rock 7" } : a,
      ),
      totalNumberOfItems: 60,
    })
    .mockResolvedValueOnce({ items: albums(51, 60), totalNumberOfItems: 60 });
  const prompt = vi.fn<(r: TvPromptRequest) => Promise<string | null>>(
    async () => "rock",
  );
  const { container } = albumsScreen(prompt);
  await screen.findByText("Album 1");
  fireEvent.click(screen.getByRole("button", { name: "Filter" }));
  expect(prompt.mock.lastCall![0]).toMatchObject({
    title: "Filter",
    initial: "",
    confirm: "Filter",
    allowEmpty: true,
  });
  expect(await screen.findByText(/Filter: “rock”/)).toBeTruthy();
  await waitFor(() => expect(api.getFavoriteAlbums).toHaveBeenCalledTimes(2));
  expect(api.getFavoriteAlbums).toHaveBeenLastCalledWith(
    42,
    50,
    50,
    "DATE",
    "DESC",
  );
  await waitFor(() =>
    expect(container.querySelector("[data-tv-loading]")).toBeNull(),
  );
  expect(screen.getByText("Rock 7")).toBeTruthy();
  expect(cardCount(container)).toBe(1);
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();

  prompt.mockResolvedValueOnce(null);
  fireEvent.click(screen.getByRole("button", { name: "Filter" }));
  expect(prompt.mock.lastCall![0].initial).toBe("rock");
  await act(async () => {});
  expect(screen.getByText(/Filter: “rock”/)).toBeTruthy();
  expect(cardCount(container)).toBe(1);

  const clear = screen.getByRole("button", { name: "Clear" });
  act(() => clear.focus());
  fireEvent.click(clear);
  expect(screen.getByText("Album 1")).toBeTruthy();
  expect(cardCount(container)).toBe(60);
  expect(screen.queryByText(/Filter: /)).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Filter" }),
  );
  expect(api.getFavoriteAlbums).toHaveBeenCalledTimes(2);
});

it("a filter whose pages fail to load offers Try again, which loads the rest", async () => {
  api.getFavoriteAlbums
    .mockResolvedValueOnce({ items: albums(1, 50), totalNumberOfItems: 120 })
    .mockRejectedValueOnce(new Error("down"))
    .mockResolvedValueOnce({ items: albums(51, 100), totalNumberOfItems: 120 })
    .mockResolvedValueOnce({
      items: albums(101, 120),
      totalNumberOfItems: 120,
    });
  const { container } = albumsScreen(async () => "album 11");
  await screen.findByText("Album 1");
  fireEvent.click(screen.getByRole("button", { name: "Filter" }));
  const again = await screen.findByRole("button", { name: "Try again" });
  expect(cardCount(container)).toBe(1);
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  act(() => again.focus());
  fireEvent.click(again);
  expect(await screen.findByText("Album 119")).toBeTruthy();
  await waitFor(() =>
    expect(container.querySelector("[data-tv-loading]")).toBeNull(),
  );
  expect(api.getFavoriteAlbums).toHaveBeenCalledTimes(4);
  expect(api.getFavoriteAlbums).toHaveBeenLastCalledWith(
    42,
    100,
    50,
    "DATE",
    "DESC",
  );
  expect(cardCount(container)).toBe(11);
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(document.activeElement?.hasAttribute("data-tv-index")).toBe(true);
});

it("a playlist filter also searches playlists inside folders, fetched once", async () => {
  const store = signedIn(42);
  store.set(renamedFoldersAtom, new Map([["f1", "Highway"]]));
  api.getPlaylistFolders.mockResolvedValue({
    items: [rawPlaylistItem("p1", "Morning"), rawFolderItem("f1", "Road")],
    totalNumberOfItems: 2,
    cursor: null,
  });
  api.getFlattenedPlaylists.mockResolvedValue(
    normalizePlaylistFolders({
      lastModifiedAt: "",
      items: [
        rawPlaylistItem("p1", "Morning"),
        rawPlaylistItem("p9", "Road trip"),
      ],
      totalNumberOfItems: 2,
      cursor: null,
    }).items,
  );
  const prompt = vi.fn<(r: TvPromptRequest) => Promise<string | null>>(
    async () => "road",
  );
  const { container } = renderTv(
    <TvListScreen
      title="Playlists"
      source={{ kind: "collection", what: "playlists" }}
    />,
    { store, nav: { prompt } },
  );
  await screen.findByText("Morning");
  fireEvent.click(screen.getByRole("button", { name: "Filter" }));
  expect(await screen.findByText("Road trip")).toBeTruthy();
  expect(cardCount(container)).toBe(1);
  prompt.mockResolvedValueOnce("high");
  fireEvent.click(screen.getByRole("button", { name: "Filter" }));
  expect(await screen.findByText(/Filter: “high”/)).toBeTruthy();
  expect(screen.getByText("Highway")).toBeTruthy();
  expect(cardCount(container)).toBe(1);
  expect(api.getFlattenedPlaylists).toHaveBeenCalledTimes(1);
});

it("videos and artist grids have no sort or filter", async () => {
  api.getFavoriteVideos.mockResolvedValue([]);
  const r = renderTv(
    <TvListScreen
      title="Videos"
      source={{ kind: "collection", what: "videos" }}
    />,
    { store: signedIn(42) },
  );
  await screen.findByText("Nothing here yet.");
  expect(screen.queryByRole("button", { name: /^Sort/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Filter" })).toBeNull();
  r.unmount();
  api.getArtistViewAll.mockResolvedValue({
    items: [{ id: 7, title: "Loud", cover: "c" }],
    hasMore: false,
  });
  renderTv(
    <TvListScreen
      title="X: Albums"
      source={{ kind: "artist", artistId: 9, apiPath: "v" }}
    />,
    { store: signedIn(42) },
  );
  await screen.findByText("Loud");
  expect(screen.queryByRole("button", { name: /^Sort/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Filter" })).toBeNull();
});

it("a collection list opens on its first card, and a re-sort keeps focus on Sort", async () => {
  const restore = stubLayout();
  try {
    api.getFavoriteAlbums.mockResolvedValue({
      items: albums(1, 3),
      totalNumberOfItems: 3,
    });
    const { nav } = albumsScreen();
    await screen.findByText("Album 1");
    await waitFor(() => expect(document.activeElement).toBe(cardOf("Album 1")));
    const sort = screen.getByRole("button", { name: "Sort: Date added" });
    act(() => sort.focus());
    fireEvent.click(sort);
    await act(async () => {
      await vi.mocked(nav.openMenu).mock.lastCall![0].items[1].onSelect!();
    });
    await waitFor(() => expect(api.getFavoriteAlbums).toHaveBeenCalledTimes(2));
    await screen.findByText("Album 1");
    await act(
      () => new Promise((r) => requestAnimationFrame(() => r(undefined))),
    );
    expect(document.activeElement).toBe(sort);
  } finally {
    restore();
  }
});
