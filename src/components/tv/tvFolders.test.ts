import { createStore } from "jotai";
import { beforeEach, expect, it, vi } from "vitest";
import {
  addedToFolderAtom,
  folderCountAdjustmentsAtom,
  movedPlaylistsAtom,
} from "../../atoms/playlists";
import { fetchAllFolders, recordFolderCreated } from "./tvFolders";
import { rawFolderItem, setupTvTest } from "./tvTestUtils";

setupTvTest();
const api = vi.hoisted(() => ({ getPlaylistFolders: vi.fn() }));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()),
  ...api,
}));
beforeEach(() => {
  for (const m of Object.values(api)) m.mockReset();
});

const page = (names: [string, string][], cursor: string | null) => ({
  items: names.map(([id, name]) => rawFolderItem(id, name)),
  totalNumberOfItems: names.length,
  cursor,
});

it("fetchAllFolders follows cursors, sorts by name and keeps a partial list on error", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  api.getPlaylistFolders
    .mockResolvedValueOnce(page([["b", "B"]], "x"))
    .mockRejectedValueOnce(new Error("down"));
  expect((await fetchAllFolders()).map((f) => f.name)).toEqual(["B"]);
  expect(api.getPlaylistFolders.mock.calls[0]).toEqual([
    "root",
    0,
    50,
    "DATE_UPDATED",
    "DESC",
    undefined,
    undefined,
  ]);
  expect(api.getPlaylistFolders.mock.calls[1][6]).toBe("x");
  expect(error).toHaveBeenCalled();
  error.mockRestore();

  api.getPlaylistFolders
    .mockResolvedValueOnce(page([["b", "B"]], "x"))
    .mockResolvedValueOnce(page([["a", "A"]], null));
  expect((await fetchAllFolders()).map((f) => f.id)).toEqual(["a", "b"]);
});

it("recordFolderCreated shows the new folder and takes the playlist out of its folder", () => {
  const store = createStore();
  recordFolderCreated(store, {
    folderId: "f9",
    name: "Car",
    playlistUuid: "p1",
    sourceFolderId: "f0",
  });
  const root = store.get(addedToFolderAtom).get("root")!;
  expect(root).toHaveLength(1);
  expect(root[0]).toMatchObject({
    kind: "folder",
    data: { id: "f9", name: "Car", totalNumberOfItems: 1 },
  });
  expect(store.get(movedPlaylistsAtom).get("p1")).toBe("f0");
  expect(store.get(folderCountAdjustmentsAtom).get("f0")).toBe(-1);

  recordFolderCreated(store, {
    folderId: "f8",
    name: "Bus",
    playlistUuid: "p2",
  });
  expect(
    store
      .get(addedToFolderAtom)
      .get("root")!
      .map((e) => (e.kind === "folder" ? e.data.id : "")),
  ).toEqual(["f9", "f8"]);
  expect(store.get(movedPlaylistsAtom).has("p2")).toBe(false);
});
