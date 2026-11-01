import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  albumSortAtom,
  artistSortAtom,
  mixSortAtom,
  playlistSortAtom,
} from "../../atoms/favorites";
import { deletedPlaylistIdsAtom, renamedFoldersAtom } from "../../atoms/playlists";
import TvCollection from "./TvCollection";
import {
  rawFolderItem,
  rawPlaylistItem,
  renderTv,
  setupTvTest,
  signedIn,
} from "./tvTestUtils";

setupTvTest();
const api = vi.hoisted(() => ({
  getPlaylistFolders: vi.fn(),
  getAllPlaylists: vi.fn(),
  getFavoriteAlbums: vi.fn(),
  getFavoriteArtists: vi.fn(),
  getFavoriteMixes: vi.fn(),
  getFavoriteVideos: vi.fn(),
}));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()),
  ...api,
}));

beforeEach(() => {
  for (const m of Object.values(api)) m.mockReset();
  const none = { items: [], totalNumberOfItems: 0 };
  api.getPlaylistFolders.mockResolvedValue({ items: [], totalNumberOfItems: 0, cursor: null });
  api.getAllPlaylists.mockResolvedValue(none);
  api.getFavoriteAlbums.mockResolvedValue(none);
  api.getFavoriteArtists.mockResolvedValue(none);
  api.getFavoriteMixes.mockResolvedValue(none);
  api.getFavoriteVideos.mockResolvedValue([]);
});

const playlistsRow = () =>
  screen.getByRole("heading", { name: "Playlists" }).closest("section")!;

it("lists folders and liked playlists from the collection folders", async () => {
  api.getPlaylistFolders.mockResolvedValue({ items: [rawFolderItem("f1", "Road"), rawPlaylistItem("p9", "Liked one", 5)], totalNumberOfItems: 2, cursor: null });
  const { nav } = renderTv(<TvCollection />, { store: signedIn(42) });
  expect(await screen.findByText("Liked one")).toBeTruthy();
  expect(api.getAllPlaylists).not.toHaveBeenCalled();
  expect(within(playlistsRow()).getAllByRole("button").map((b) => b.textContent)).toEqual([
    "My TracksYour favorite tracks",
    "Road0 playlists",
    expect.stringContaining("Liked one"),
  ]);
  fireEvent.click(screen.getByText("Road").closest("button")!);
  expect(vi.mocked(nav.run).mock.lastCall![0]).toEqual({ kind: "open", view: { type: "list", title: "Road", source: { kind: "collection", what: "playlists", folderId: "f1" } } });
});

it("applies local playlist edits to the playlists row", async () => {
  api.getPlaylistFolders.mockResolvedValue({ items: [rawFolderItem("f1", "Road", 2), rawPlaylistItem("p1", "Gone"), rawPlaylistItem("p2", "Kept")], totalNumberOfItems: 3, cursor: null });
  const store = signedIn(42);
  store.set(deletedPlaylistIdsAtom, new Set(["p1"]));
  store.set(renamedFoldersAtom, new Map([["f1", "Road trips"]]));
  renderTv(<TvCollection />, { store });
  expect(await screen.findByText("Kept")).toBeTruthy();
  expect(screen.queryByText("Gone")).toBeNull();
  expect(screen.getByText("Road trips")).toBeTruthy();
});

it("rows use the saved sorts", async () => {
  const store = signedIn(42);
  store.set(albumSortAtom, { order: "NAME", direction: "ASC" });
  store.set(artistSortAtom, { order: "NAME", direction: "DESC" });
  store.set(mixSortAtom, { order: "DATE", direction: "ASC" });
  store.set(playlistSortAtom, { order: "NAME", direction: "ASC" });
  renderTv(<TvCollection />, { store });
  expect(await screen.findByText("My Tracks")).toBeTruthy();
  expect(api.getFavoriteAlbums.mock.lastCall).toEqual([42, 0, 50, "NAME", "ASC"]);
  expect(api.getFavoriteArtists.mock.lastCall).toEqual([42, 0, 50, "NAME", "DESC"]);
  expect(api.getFavoriteMixes.mock.lastCall).toEqual([0, 50, "DATE", "ASC"]);
  expect(api.getPlaylistFolders.mock.lastCall!.slice(0, 5)).toEqual(["root", 0, 50, "NAME", "ASC"]);
  expect(api.getFavoriteAlbums).toHaveBeenCalledTimes(1);
});

it("offers View all when the playlists page has a cursor", async () => {
  api.getPlaylistFolders.mockResolvedValue({ items: [rawPlaylistItem("p1", "One")], totalNumberOfItems: 1, cursor: "next" });
  const { nav } = renderTv(<TvCollection />, { store: signedIn(42) });
  await screen.findByText("One");
  fireEvent.click(within(playlistsRow()).getByText("View all").closest("button")!);
  expect(vi.mocked(nav.run).mock.lastCall![0]).toEqual({ kind: "open", view: { type: "list", title: "Playlists", source: { kind: "collection", what: "playlists" } } });
});
