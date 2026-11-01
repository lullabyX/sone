import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { deletedPlaylistIdsAtom } from "../../atoms/playlists";
import TvListScreen from "./TvListScreen";
import { menuForElement } from "./tvMenu";
import {
  deferred,
  range,
  rawPlaylistItem,
  renderTv,
  setupTvTest,
  signedIn,
} from "./tvTestUtils";

setupTvTest();
const api = vi.hoisted(() => ({
  getFavoriteAlbums: vi.fn(),
  getPlaylistFolders: vi.fn(),
  getFavoriteVideos: vi.fn(),
  getArtistViewAll: vi.fn(),
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
    <TvListScreen title="Albums" source={{ kind: "collection", what: "albums" }} />,
    { store: signedIn(42) },
  );
  await screen.findByText("Album 50");
  expect(api.getFavoriteAlbums).toHaveBeenCalledTimes(1);
  act(() => cardOf("Album 45").focus());
  await waitFor(() =>
    expect(api.getFavoriteAlbums).toHaveBeenLastCalledWith(42, 50, 50, "DATE", "DESC"),
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
    "f1", 0, 50, "DATE_UPDATED", "DESC", undefined, undefined,
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
    <TvListScreen title="X: Albums" source={{ kind: "artist", artistId: 9, apiPath: "v" }} />,
    { store: signedIn(42) },
  );
  await screen.findByText("Loud");
  expect(within(cardOf("Loud")).getByText("E")).toBeTruthy();
  r.unmount();
  api.getFavoriteAlbums.mockResolvedValue({ items: [loud], totalNumberOfItems: 1 });
  renderTv(
    <TvListScreen title="Albums" source={{ kind: "collection", what: "albums" }} />,
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
    <TvListScreen title="Albums" source={{ kind: "collection", what: "albums" }} />,
    { store: signedIn(42) },
  );
  await screen.findByText("Album 50");
  act(() => cardOf("Album 45").focus());
  const again = await screen.findByRole("button", { name: "Try again" });
  act(() => again.focus());
  fireEvent.click(again);
  expect(await screen.findByText("Album 100")).toBeTruthy();
  expect(api.getFavoriteAlbums).toHaveBeenCalledTimes(3);
  expect(api.getFavoriteAlbums).toHaveBeenLastCalledWith(42, 50, 50, "DATE", "DESC");
  expect(document.activeElement).toBe(cardOf("Album 51"));
});

it("a page that adds no cards offers Load more, which fetches the next page", async () => {
  const store = signedIn(42);
  store.set(deletedPlaylistIdsAtom, new Set(["p2"]));
  api.getPlaylistFolders
    .mockResolvedValueOnce({ items: [rawPlaylistItem("p1", "One")], totalNumberOfItems: 3, cursor: "c1" })
    .mockResolvedValueOnce({ items: [rawPlaylistItem("p2", "Two")], totalNumberOfItems: 3, cursor: "c2" })
    .mockResolvedValue({ items: [rawPlaylistItem("p3", "Three")], totalNumberOfItems: 3, cursor: null });
  renderTv(
    <TvListScreen title="Playlists" source={{ kind: "collection", what: "playlists" }} />,
    { store },
  );
  await screen.findByText("One");
  act(() => cardOf("One").focus());
  await waitFor(() => expect(api.getPlaylistFolders).toHaveBeenCalledTimes(2));
  expect(api.getPlaylistFolders).toHaveBeenLastCalledWith("root", 1, 50, "DATE_UPDATED", "DESC", undefined, "c1");
  const more = await screen.findByRole("button", { name: "Load more" });
  expect(screen.queryByText("Two")).toBeNull();
  act(() => more.focus());
  fireEvent.click(more);
  expect(await screen.findByText("Three")).toBeTruthy();
  expect(api.getPlaylistFolders).toHaveBeenLastCalledWith("root", 2, 50, "DATE_UPDATED", "DESC", undefined, "c2");
  expect(document.activeElement).toBe(cardOf("Three"));
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

it("marks the list as loading while a page is in flight", async () => {
  const page2 = deferred<{ items: unknown[]; totalNumberOfItems: number }>();
  api.getFavoriteAlbums
    .mockResolvedValueOnce({ items: albums(1, 50), totalNumberOfItems: 120 })
    .mockReturnValueOnce(page2.promise);
  const { container } = renderTv(
    <TvListScreen title="Albums" source={{ kind: "collection", what: "albums" }} />,
    { store: signedIn(42) },
  );
  await screen.findByText("Album 50");
  expect(container.querySelector("[data-tv-loading]")).toBeNull();
  act(() => cardOf("Album 45").focus());
  await waitFor(() => expect(container.querySelector("[data-tv-loading]")).not.toBeNull());
  expect(screen.getByRole("status", { name: "Loading more" })).toBeTruthy();
  await act(async () => page2.resolve({ items: albums(51, 100), totalNumberOfItems: 120 }));
  await screen.findByText("Album 100");
  expect(container.querySelector("[data-tv-loading]")).toBeNull();
  expect(screen.queryByRole("status", { name: "Loading more" })).toBeNull();
});

it("an artist grid's cards carry no folder", async () => {
  api.getArtistViewAll.mockResolvedValue({ items: [{ id: 7, title: "Loud", cover: "c" }], hasMore: false });
  const { nav } = renderTv(
    <TvListScreen title="X: Albums" source={{ kind: "artist", artistId: 9, apiPath: "v" }} />,
    { store: signedIn(42) },
  );
  await screen.findByText("Loud");
  menuForElement(cardOf("Loud"))!();
  expect(vi.mocked(nav.mediaMenu).mock.lastCall![2]).toBeUndefined();
});
