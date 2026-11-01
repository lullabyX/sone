import { act, fireEvent, screen } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TvMenuHostHandle } from "./TvMenuHost";
import {
  addedToFolderAtom,
  allFoldersAtom,
  allFoldersFetchedAtom,
  movedPlaylistsAtom,
} from "../../atoms/playlists";
import { linkMenu, navMenus, type TvMenuSpec } from "./tvMenu";
import {
  mkTrack,
  mockInvoke,
  rawFolderItem,
  renderMenuHost,
  setupTvTest,
  stubLayout,
} from "./tvTestUtils";

setupTvTest();
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
import { invoke } from "@tauri-apps/api/core";
const api = vi.hoisted(() => ({
  getAllPlaylists: vi.fn(async () => ({ items: [] })),
  getTrackCredits: vi.fn(),
  getPlaylistFolders: vi.fn(),
}));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()), ...api }));
beforeEach(() => {
  for (const m of Object.values(api)) m.mockReset();
  api.getAllPlaylists.mockImplementation(async () => ({ items: [] }));
  vi.mocked(invoke).mockImplementation(() => Promise.resolve(undefined));
});

describe("focus and late submenus", () => {
  let ref: RefObject<TvMenuHostHandle | null>;
  let opener: HTMLElement;
  let restore: () => void;
  beforeEach(() => {
    restore = stubLayout();
    opener = document.body.appendChild(Object.assign(document.createElement("button"), { textContent: "opener" }));
    ({ ref } = renderMenuHost());
    opener.focus();
  });
  afterEach(() => { restore(); opener.remove(); });
  const credits = (set: (r: (s: TvMenuSpec) => void) => void): TvMenuSpec =>
    ({ title: "M", items: [{ label: "Credits", submenu: () => new Promise<TvMenuSpec>((r) => set(r)) }] });

  it("runs an entry with focus back on the element that opened the menu", () => {
    let seen: Element | null = null;
    act(() => ref.current!.open({ title: "M", items: [{ label: "Go", onSelect: () => void (seen = document.activeElement) }] }));
    act(() => fireEvent.click(screen.getByRole("menuitem", { name: "Go" })));
    expect(seen).toBe(opener);
  });
  it("drops a submenu that finishes loading after Back", async () => {
    let resolve!: (s: TvMenuSpec) => void;
    act(() => ref.current!.open(credits((r) => (resolve = r))));
    act(() => fireEvent.click(screen.getByRole("menuitem", { name: "Credits" })));
    act(() => ref.current!.back());
    await act(async () => resolve({ title: "Credits list", items: [] }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it("drops a submenu that finishes after another menu opened", async () => {
    let resolve!: (s: TvMenuSpec) => void;
    act(() => ref.current!.open(credits((r) => (resolve = r))));
    act(() => fireEvent.click(screen.getByRole("menuitem", { name: "Credits" })));
    act(() => ref.current!.open({ title: "Other", items: [{ label: "X", onSelect() {} }] }));
    await act(async () => resolve({ title: "Credits list", items: [] }));
    expect(screen.getByRole("menu", { name: "Other" })).toBeTruthy();
    expect(screen.queryByRole("menu", { name: "Credits list" })).toBeNull();
  });
  it("a pending submenu never blocks the menu opened meanwhile", async () => {
    let resolve!: (s: TvMenuSpec) => void;
    const x = vi.fn();
    act(() => ref.current!.open(credits((r) => (resolve = r))));
    act(() => fireEvent.click(screen.getByRole("menuitem", { name: "Credits" })));
    act(() => ref.current!.open({ title: "Other", items: [{ label: "X", onSelect: x }] }));
    act(() => fireEvent.click(screen.getByRole("menuitem", { name: "X" })));
    expect(x).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ title: "Credits list", items: [] }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

it("wraps multiline entries and widens reading panels", () => {
  const { ref } = renderMenuHost();
  act(() => ref.current!.open({ title: "Credits", wide: true, items: [{ label: "Producer: A, B, C", multiline: true }] }));
  const entry = screen.getByRole("menuitem", { name: /Producer/ });
  expect(entry.querySelector(".truncate")).toBeNull();
  expect(entry.querySelector(".whitespace-normal")).not.toBeNull();
  expect(screen.getByRole("menu").className).toContain("w-[40rem]");
});
it("shows credits as wrapping lines in a wide panel", async () => {
  api.getTrackCredits.mockResolvedValue([{ creditType: "Producer", contributors: [{ name: "A" }] }]);
  const { ref } = renderMenuHost();
  const spec = await ref.current!.trackMenu(mkTrack(1)).items.find((i) => i.label === "Credits")!.submenu!();
  expect(spec.wide).toBe(true);
  expect(spec.items[0]).toMatchObject({ label: "Producer: A", multiline: true });
});
it("Track radio opens the mix with its seed artist", async () => {
  const { ref, onNavigate } = renderMenuHost();
  await act(async () => { await ref.current!.trackMenu({ ...mkTrack(1), mixes: { TRACK_MIX: "m" } }).items.find((i) => i.label === "Track radio")!.onSelect!(); });
  expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ type: "mix", mixId: "m", mixType: "TRACK_MIX", artist: { id: 101, name: "A1" } }));
});
it("shows a QR code for a link panel", () => {
  const { ref } = renderMenuHost();
  act(() => ref.current!.open(linkMenu("https://x.io/a", "Read")));
  expect(screen.getByRole("img", { name: "Link code" })).toBeTruthy();
});

describe("Move to folder", () => {
  const playlist = { type: "playlist" as const, uuid: "p1", title: "P" };
  const folders = (...f: [string, string][]) => ({
    items: f.map(([id, name]) => rawFolderItem(id, name)),
    totalNumberOfItems: f.length,
    cursor: null,
  });
  const moveMenu = (spec: TvMenuSpec) =>
    spec.items.find((i) => i.label === "Move to folder")!.submenu!();
  beforeEach(() => {
    mockInvoke({
      move_playlist_to_folder: () => undefined,
      create_playlist_folder: () => ({ id: "f9", name: "Car" }),
    });
  });

  it("moves a playlist into a folder through TvApp's menu wrapper", async () => {
    api.getPlaylistFolders.mockResolvedValue(folders(["f1", "Rock"]));
    const { ref } = renderMenuHost();
    const spec = navMenus(() => ref.current).mediaMenu(playlist, false, { folderId: "f0" });
    const sub = await moveMenu(spec);
    expect(sub.items.map((i) => i.label)).toEqual(["Playlists (top level)", "Rock", "New folder…"]);
    await act(async () => { await sub.items[1].onSelect!(); });
    expect(invoke).toHaveBeenCalledWith("move_playlist_to_folder", { folderId: "f1", playlistTrn: "trn:playlist:p1" });
    expect(await screen.findByText('Moved "P" to "Rock"')).toBeTruthy();
  });
  it("moves a playlist out of its folder to the top level", async () => {
    api.getPlaylistFolders.mockResolvedValue(folders(["f1", "Rock"]));
    const { ref, store } = renderMenuHost();
    const sub = await moveMenu(ref.current!.mediaMenu(playlist, false, { folderId: "f0" }));
    await act(async () => { await sub.items[0].onSelect!(); });
    expect(invoke).toHaveBeenCalledWith("move_playlist_to_folder", { folderId: "root", playlistTrn: "trn:playlist:p1" });
    expect(store.get(movedPlaylistsAtom).get("p1")).toBe("f0");
    expect(await screen.findByText('Moved "P" to Playlists')).toBeTruthy();
  });
  it("a failed move is undone and reported", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockInvoke({ move_playlist_to_folder: () => { throw new Error("no"); } });
    api.getPlaylistFolders.mockResolvedValue(folders(["f1", "Rock"]));
    const { ref, store } = renderMenuHost();
    const sub = await moveMenu(ref.current!.mediaMenu(playlist, false, { folderId: "f0" }));
    await act(async () => { await sub.items[1].onSelect!(); });
    expect(store.get(movedPlaylistsAtom).has("p1")).toBe(false);
    expect(store.get(addedToFolderAtom).get("f1")).toBeUndefined();
    expect(await screen.findByText("Failed to move playlist")).toBeTruthy();
    expect(error.mock.lastCall![0]).toBe("[TvMenuHost] failed to move playlist:");
    error.mockRestore();
  });
  it("a failed folder creation is reported and changes nothing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockInvoke({ create_playlist_folder: () => { throw new Error("no"); } });
    api.getPlaylistFolders.mockResolvedValue(folders(["f1", "Rock"]));
    const { ref, store, onPrompt } = renderMenuHost();
    onPrompt.mockResolvedValueOnce("Car");
    const sub = await moveMenu(ref.current!.mediaMenu(playlist, false, { folderId: "f0" }));
    await act(async () => { await sub.items.find((i) => i.label === "New folder…")!.onSelect!(); });
    expect(store.get(addedToFolderAtom).get("root")).toBeUndefined();
    expect(store.get(movedPlaylistsAtom).has("p1")).toBe(false);
    expect(await screen.findByText("Failed to create folder")).toBeTruthy();
    expect(error.mock.lastCall![0]).toBe("[TvMenuHost] failed to create folder:");
    error.mockRestore();
  });
  it("a new folder is created with the playlist and shown at once", async () => {
    api.getPlaylistFolders.mockResolvedValue(folders(["f1", "Rock"]));
    const { ref, store, onPrompt } = renderMenuHost();
    onPrompt.mockResolvedValueOnce("Car");
    const sub = await moveMenu(ref.current!.mediaMenu(playlist, false, { folderId: "f0" }));
    await act(async () => { await sub.items.find((i) => i.label === "New folder…")!.onSelect!(); });
    expect(onPrompt.mock.lastCall![0]).toEqual({ title: "New folder", confirm: "Create and move" });
    expect(invoke).toHaveBeenCalledWith("create_playlist_folder", { folderId: "root", name: "Car", trns: "trn:playlist:p1" });
    const root = store.get(addedToFolderAtom).get("root")!;
    expect(root.some((e) => e.kind === "folder" && e.data.name === "Car")).toBe(true);
    expect(store.get(movedPlaylistsAtom).get("p1")).toBe("f0");
    expect(await screen.findByText('Moved "P" to "Car"')).toBeTruthy();
  });
  it("no top-level entry outside a folder", async () => {
    api.getPlaylistFolders.mockResolvedValue(folders(["f1", "Rock"]));
    const { ref, store } = renderMenuHost();
    const sub = await moveMenu(ref.current!.mediaMenu(playlist));
    expect(sub.items[0].label).toBe("Rock");
    expect(store.get(allFoldersFetchedAtom)).toBe(true);
    expect(store.get(allFoldersAtom).map((f) => f.id)).toEqual(["f1"]);
  });
  it("lists recent folders first and reuses the loaded folder list", async () => {
    localStorage.setItem("sone.recent-folders.v1", JSON.stringify(["f3", "gone", "f2"]));
    const { ref, store } = renderMenuHost();
    act(() => {
      store.set(allFoldersAtom, folders(["f1", "A"], ["f2", "B"], ["f3", "C"]).items.map((i) => ({
        id: i.trn.replace("trn:folder:", ""), name: i.name, parent: null, addedAt: "", lastModifiedAt: "",
      })));
      store.set(allFoldersFetchedAtom, true);
    });
    const sub = await moveMenu(ref.current!.mediaMenu(playlist));
    expect(sub.items.map((i) => i.label)).toEqual(["C", "B", "A", "New folder…"]);
    expect(api.getPlaylistFolders).not.toHaveBeenCalled();
  });
});
