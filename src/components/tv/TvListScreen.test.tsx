import { beforeEach, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import TvListScreen from "./TvListScreen";
import { menuForElement } from "./tvMenu";
import {
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
