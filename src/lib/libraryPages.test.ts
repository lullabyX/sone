import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePlaylistFolders } from "../api/tidal";
import { rawFolderItem, rawPlaylistItem } from "../components/tv/tvTestUtils";
import type { PlaylistFolderItem, PlaylistOrFolder } from "../types";
import {
  applyLocalPlaylistEdits,
  fetchLibraryPage,
  filterLibraryItems,
  nextSortOrder,
} from "./libraryPages";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const api = vi.hoisted(() => ({
  getPlaylistFolders: vi.fn(),
  getFavoriteAlbums: vi.fn(),
  getFavoriteArtists: vi.fn(),
  getFavoriteMixes: vi.fn(),
}));

vi.mock("../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tidal")>()),
  ...api,
}));

const norm = (...items: PlaylistFolderItem[]) =>
  normalizePlaylistFolders({
    lastModifiedAt: "",
    items,
    totalNumberOfItems: 0,
    cursor: null,
  }).items;

const ids = (items: PlaylistOrFolder[]) =>
  items.map((e) => (e.kind === "playlist" ? e.data.uuid : e.data.id));

beforeEach(() => {
  for (const m of Object.values(api)) m.mockReset();
});

describe("nextSortOrder", () => {
  it("starts Name ascending, flips a repeated pick, starts others descending", () => {
    expect(nextSortOrder({ order: "DATE", direction: "DESC" }, "NAME")).toEqual(
      { order: "NAME", direction: "ASC" },
    );
    expect(nextSortOrder({ order: "NAME", direction: "ASC" }, "NAME")).toEqual({
      order: "NAME",
      direction: "DESC",
    });
    expect(nextSortOrder({ order: "NAME", direction: "ASC" }, "DATE")).toEqual({
      order: "DATE",
      direction: "DESC",
    });
    expect(nextSortOrder({ order: "DATE", direction: "ASC" }, "DATE")).toEqual({
      order: "DATE",
      direction: "DESC",
    });
  });
});

describe("fetchLibraryPage", () => {
  it("passes folder, sort and cursor and estimates the total", async () => {
    api.getPlaylistFolders.mockResolvedValue({
      items: [rawPlaylistItem("p1")],
      totalNumberOfItems: 9,
      cursor: "n",
    });
    const r = await fetchLibraryPage("playlists", {
      folderId: "f",
      sort: { order: "NAME", direction: "ASC" },
      offset: 50,
      limit: 50,
      cursor: "c",
    });
    expect(api.getPlaylistFolders).toHaveBeenCalledWith(
      "f",
      50,
      50,
      "NAME",
      "ASC",
      undefined,
      "c",
    );
    expect(r).toMatchObject({
      cursor: "n",
      totalNumberOfItems: 52,
      apiTotal: 9,
    });
    expect(ids(r.items)).toEqual(["p1"]);
  });

  it("ignores the cursor on the first page and stops estimating without one", async () => {
    api.getPlaylistFolders.mockResolvedValue({
      items: [rawPlaylistItem("p1"), rawPlaylistItem("p2")],
      totalNumberOfItems: 2,
      cursor: null,
    });
    const r = await fetchLibraryPage("playlists", {
      sort: { order: "DATE_UPDATED", direction: "DESC" },
      offset: 0,
      limit: 50,
      cursor: "stale",
    });
    expect(api.getPlaylistFolders.mock.lastCall).toEqual([
      "root",
      0,
      50,
      "DATE_UPDATED",
      "DESC",
      undefined,
      undefined,
    ]);
    expect(r).toMatchObject({
      cursor: null,
      totalNumberOfItems: 2,
      apiTotal: 2,
    });
  });

  it("does not estimate past an empty page that still has a cursor", async () => {
    api.getPlaylistFolders.mockResolvedValue({
      items: [],
      totalNumberOfItems: 9,
      cursor: "n",
    });
    const r = await fetchLibraryPage("playlists", {
      sort: { order: "NAME", direction: "ASC" },
      offset: 50,
      limit: 50,
      cursor: "c",
    });
    expect(r).toMatchObject({ cursor: "n", totalNumberOfItems: 50 });
  });

  it("returns nothing for favorite albums and artists while signed out", async () => {
    const sort = { order: "DATE", direction: "DESC" };
    for (const type of ["albums", "artists"] as const) {
      const r = await fetchLibraryPage(type, { sort, offset: 0, limit: 50 });
      expect(r).toEqual({
        items: [],
        totalNumberOfItems: 0,
        cursor: null,
        apiTotal: 0,
      });
    }
    expect(api.getFavoriteAlbums).not.toHaveBeenCalled();
    expect(api.getFavoriteArtists).not.toHaveBeenCalled();
  });

  it("passes the user, offset and sort for albums, artists and mixes", async () => {
    const page = { items: [{ id: 1 }], totalNumberOfItems: 7 };
    api.getFavoriteAlbums.mockResolvedValue(page);
    api.getFavoriteArtists.mockResolvedValue(page);
    api.getFavoriteMixes.mockResolvedValue(page);
    const o = {
      userId: 42,
      sort: { order: "ARTIST", direction: "ASC" },
      offset: 50,
      limit: 50,
      cursor: "ignored",
    };
    const expected = {
      items: [{ id: 1 }],
      totalNumberOfItems: 7,
      cursor: null,
      apiTotal: 7,
    };
    expect(await fetchLibraryPage("albums", o)).toEqual(expected);
    expect(await fetchLibraryPage("artists", o)).toEqual(expected);
    expect(await fetchLibraryPage("mixes", o)).toEqual(expected);
    expect(api.getFavoriteAlbums.mock.lastCall).toEqual([
      42,
      50,
      50,
      "ARTIST",
      "ASC",
    ]);
    expect(api.getFavoriteArtists.mock.lastCall).toEqual([
      42,
      50,
      50,
      "ARTIST",
      "ASC",
    ]);
    expect(api.getFavoriteMixes.mock.lastCall).toEqual([
      50,
      50,
      "ARTIST",
      "ASC",
    ]);
  });
});

describe("applyLocalPlaylistEdits", () => {
  const noEdits = {
    deletedPlaylistIds: new Set<string>(),
    deletedFolderIds: new Set<string>(),
    movedPlaylists: new Map<string, string>(),
    addedToFolder: new Map<string, PlaylistOrFolder[]>(),
  };

  it("drops deleted and moved entries and prepends added ones", () => {
    const items = [
      ...norm(rawPlaylistItem("p1"), rawPlaylistItem("p2")),
      ...norm(rawFolderItem("f1", "Old"), rawFolderItem("f2", "Keep")),
    ];
    const added = [
      ...norm(rawFolderItem("f9", "New")),
      ...norm(rawPlaylistItem("p3")),
    ];
    const out = applyLocalPlaylistEdits(items, "root", {
      deletedPlaylistIds: new Set(["p1"]),
      deletedFolderIds: new Set(["f1"]),
      movedPlaylists: new Map([["p2", "root"]]),
      addedToFolder: new Map([["root", added]]),
    });
    expect(ids(out)).toEqual(["f9", "p3", "f2"]);
  });

  it("keeps every entry when nothing changes", () => {
    const items = norm(rawPlaylistItem("p1"));
    expect(applyLocalPlaylistEdits(items, "root", noEdits)).toEqual(items);
  });

  it("skips added entries already listed or moved here", () => {
    const items = norm(rawPlaylistItem("p1"));
    const out = applyLocalPlaylistEdits(items, "f", {
      ...noEdits,
      movedPlaylists: new Map([["p4", "f"]]),
      addedToFolder: new Map([
        ["f", norm(rawPlaylistItem("p1"), rawPlaylistItem("p4"))],
      ]),
    });
    expect(ids(out)).toEqual(["p1"]);
  });
});

describe("filterLibraryItems", () => {
  const none = { flattened: [], renamedFolders: new Map<string, string>() };

  it("searches nested playlists and renamed folders", () => {
    const items = [
      ...norm(rawFolderItem("f1", "Old"), rawFolderItem("f2", "Roadless")),
      ...norm(rawPlaylistItem("p1", "One")),
    ];
    const out = filterLibraryItems("playlists", items, " Road ", {
      flattened: norm(
        rawPlaylistItem("p5", "Roadhouse"),
        rawPlaylistItem("p6", "Other"),
      ),
      renamedFolders: new Map([
        ["f1", "Road trip"],
        ["f2", "Elsewhere"],
      ]),
    });
    expect(ids(out)).toEqual(["f1", "p5"]);
  });

  it("returns the items untouched for a blank query", () => {
    const items = [{ id: 1 }];
    expect(filterLibraryItems("albums", items, "  ", none)).toBe(items);
  });

  it("matches each type's fields", () => {
    expect(
      filterLibraryItems(
        "albums",
        [
          { id: 1, title: "Blue", artist: { name: "X" } },
          { id: 2, title: "Red", artist: { name: "Bluey" } },
          { id: 3, title: "Green" },
        ],
        "blue",
        none,
      ).map((i) => i.id),
    ).toEqual([1, 2]);
    expect(
      filterLibraryItems(
        "artists",
        [{ id: 1, name: "Blur" }, { id: 2 }],
        "BLU",
        none,
      ).map((i) => i.id),
    ).toEqual([1]);
    expect(
      filterLibraryItems(
        "mixes",
        [
          { id: "a", title: "Daily", subTitle: "x" },
          { id: "b", title: "Y", subTitle: "daily picks" },
          { id: "c", title: "Z" },
        ],
        "daily",
        none,
      ).map((i) => i.id),
    ).toEqual(["a", "b"]);
  });

  it("matches playlists by description and creator", () => {
    const [p1, p2] = norm(rawPlaylistItem("p1"), rawPlaylistItem("p2"));
    if (p1.kind !== "playlist" || p2.kind !== "playlist") throw new Error();
    p1.data.description = "late night";
    p2.data.creator = { id: 7, name: "Nightowl" } as typeof p2.data.creator;
    const out = filterLibraryItems("playlists", [p1, p2], "night", none);
    expect(ids(out)).toEqual(["p1", "p2"]);
  });
});
