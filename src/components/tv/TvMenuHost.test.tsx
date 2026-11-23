import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TvMenuHostHandle } from "./TvMenuHost";
import { favoriteVideoIdsAtom } from "../../atoms/favorites";
import {
  addedToFolderAtom,
  allFoldersAtom,
  allPlaylistsAtom,
  allFoldersFetchedAtom,
  movedPlaylistsAtom,
} from "../../atoms/playlists";
import type { Playlist } from "../../types";
import { linkMenu, navMenus, type TvMenuSpec } from "./tvMenu";
import { playlistRevision, queuePlaylistEdit } from "./tvPlaylistEdits";
import {
  deferred,
  mkTrack,
  mockInvoke,
  rawFolderItem,
  renderMenuHost,
  setupTvTest,
  signedIn,
  stubLayout,
} from "./tvTestUtils";

setupTvTest();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));
import { invoke } from "@tauri-apps/api/core";
const api = vi.hoisted(() => ({
  getAllPlaylists: vi.fn(
    async (
      _userId: number,
      _offset: number,
    ): Promise<{ items: Playlist[]; totalNumberOfItems?: number }> => ({
      items: [],
    }),
  ),
  getTrackCredits: vi.fn(),
  getPlaylistFolders: vi.fn(),
  getPlaylistDetails: vi.fn(),
}));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()),
  ...api,
}));
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
    opener = document.body.appendChild(
      Object.assign(document.createElement("button"), {
        textContent: "opener",
      }),
    );
    ({ ref } = renderMenuHost());
    opener.focus();
  });
  afterEach(() => {
    restore();
    opener.remove();
  });
  const credits = (set: (r: (s: TvMenuSpec) => void) => void): TvMenuSpec => ({
    title: "M",
    items: [
      {
        label: "Credits",
        submenu: () => new Promise<TvMenuSpec>((r) => set(r)),
      },
    ],
  });

  it("runs an entry with focus back on the element that opened the menu", () => {
    let seen: Element | null = null;
    act(() =>
      ref.current!.open({
        title: "M",
        items: [
          { label: "Go", onSelect: () => void (seen = document.activeElement) },
        ],
      }),
    );
    act(() => fireEvent.click(screen.getByRole("menuitem", { name: "Go" })));
    expect(seen).toBe(opener);
  });
  it("drops a submenu that finishes loading after Back", async () => {
    let resolve!: (s: TvMenuSpec) => void;
    act(() => ref.current!.open(credits((r) => (resolve = r))));
    act(() =>
      fireEvent.click(screen.getByRole("menuitem", { name: "Credits" })),
    );
    act(() => ref.current!.back());
    await act(async () => resolve({ title: "Credits list", items: [] }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it("drops a submenu that finishes after another menu opened", async () => {
    let resolve!: (s: TvMenuSpec) => void;
    act(() => ref.current!.open(credits((r) => (resolve = r))));
    act(() =>
      fireEvent.click(screen.getByRole("menuitem", { name: "Credits" })),
    );
    act(() =>
      ref.current!.open({
        title: "Other",
        items: [{ label: "X", onSelect() {} }],
      }),
    );
    await act(async () => resolve({ title: "Credits list", items: [] }));
    expect(screen.getByRole("menu", { name: "Other" })).toBeTruthy();
    expect(screen.queryByRole("menu", { name: "Credits list" })).toBeNull();
  });
  it("a pending submenu never blocks the menu opened meanwhile", async () => {
    let resolve!: (s: TvMenuSpec) => void;
    const x = vi.fn();
    act(() => ref.current!.open(credits((r) => (resolve = r))));
    act(() =>
      fireEvent.click(screen.getByRole("menuitem", { name: "Credits" })),
    );
    act(() =>
      ref.current!.open({
        title: "Other",
        items: [{ label: "X", onSelect: x }],
      }),
    );
    act(() => fireEvent.click(screen.getByRole("menuitem", { name: "X" })));
    expect(x).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ title: "Credits list", items: [] }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("leaving a submenu focuses the entry that opened it", async () => {
    const sub = { title: "Sub", items: [{ label: "Deep", onSelect() {} }] };
    act(() =>
      ref.current!.open({
        title: "M",
        items: [
          { label: "First", onSelect() {} },
          { label: "More", submenu: () => sub },
        ],
      }),
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("menuitem", { name: "More" })),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Deep" }),
    );
    act(() => ref.current!.back());
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "More" }),
    );
    act(() => ref.current!.back());
    expect(document.activeElement).toBe(opener);
  });
});

it("wraps multiline entries and widens reading panels", () => {
  const { ref } = renderMenuHost();
  act(() =>
    ref.current!.open({
      title: "Credits",
      wide: true,
      items: [{ label: "Producer: A, B, C", multiline: true }],
    }),
  );
  const entry = screen.getByRole("menuitem", { name: /Producer/ });
  expect(entry.querySelector(".truncate")).toBeNull();
  expect(entry.querySelector(".whitespace-normal")).not.toBeNull();
  expect(screen.getByRole("menu").className).toContain("w-[40rem]");
});
it("shows read-only rows in full, with their dot, detail and note", () => {
  const { ref } = renderMenuHost();
  act(() =>
    ref.current!.open({
      title: "Signal path",
      items: [
        { label: "DECODE", detail: "S24LE · 96 kHz", info: true },
        {
          label: "RESAMPLED",
          detail: "96 kHz → 48 kHz",
          note: "DAC does not accept the source rate",
          tone: "lossy",
          info: true,
        },
        { label: "Nothing to do" },
      ],
    }),
  );
  const decode = screen.getByRole("menuitem", { name: /DECODE/ });
  expect(decode.hasAttribute("aria-disabled")).toBe(false);
  expect(decode.textContent).toContain("S24LE · 96 kHz");
  const resampled = screen.getByRole("menuitem", { name: /RESAMPLED/ });
  expect(resampled.querySelector(".bg-red-400")).not.toBeNull();
  expect(resampled.textContent).toContain(
    "DAC does not accept the source rate",
  );
  expect(
    screen
      .getByRole("menuitem", { name: "Nothing to do" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
});
it("refreshes a polled menu in place while it is shown, and stops once closed", async () => {
  vi.useFakeTimers();
  try {
    const { ref } = renderMenuHost();
    const next = vi.fn(async () => ({
      title: "Signal path",
      items: [
        { label: "MIX · 48 kHz", info: true, path: { kind: "stage" as const } },
      ],
    }));
    act(() =>
      ref.current!.open({
        title: "Signal path",
        poll: { everyMs: 2000, next },
        items: [{ label: "MIX", info: true, path: { kind: "stage" } }],
      }),
    );
    const panel = screen.getByRole("menu");
    expect(document.activeElement).toBe(panel);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(screen.getByText("MIX · 48 kHz")).toBeTruthy();
    expect(screen.getByRole("menu")).toBe(panel);
    expect(document.activeElement).toBe(panel);
    act(() => ref.current!.close());
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(next).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
it("draws the Signal path as read-only rows on a cable, focus on the panel", () => {
  const { ref } = renderMenuHost();
  act(() =>
    ref.current!.open({
      title: "Signal path",
      items: [
        {
          label: "DECODE",
          detail: "S16LE · 44.1 kHz",
          info: true,
          path: { kind: "stage", above: "pristine", below: "lossy" },
        },
        {
          label: "MIX CONVERSION",
          detail: "S16LE/44.1 kHz → S32LE/48 kHz",
          note: "PipeWire resampled the stream",
          tone: "lossy",
          info: true,
          path: { kind: "change", above: "lossy", below: "lossy" },
        },
      ],
    }),
  );
  const menu = screen.getByRole("menu");
  expect(menu.querySelectorAll("[data-tv-focusable]")).toHaveLength(0);
  expect(document.activeElement).toBe(menu);
  const decode = screen.getByText("DECODE").parentElement!;
  expect(decode.querySelector(".border-green-400")).not.toBeNull();
  expect(decode.querySelector(".bg-red-400")).not.toBeNull();
  expect(screen.getByText("MIX CONVERSION").className).toContain(
    "text-red-400",
  );
  // A change is a pill on the cable: its numbers, without the reason.
  const pill = screen.getByText("MIX CONVERSION").parentElement!;
  expect(pill.className).toContain("rounded-full");
  expect(pill.className).toContain("bg-red-400/15");
  expect(pill.textContent).toContain("S16LE/44.1 kHz → S32LE/48 kHz");
  expect(screen.queryByText("PipeWire resampled the stream")).toBeNull();
});
it("shows credits as wrapping lines in a wide panel", async () => {
  api.getTrackCredits.mockResolvedValue([
    { creditType: "Producer", contributors: [{ name: "A" }] },
  ]);
  const { ref } = renderMenuHost();
  const spec = await ref
    .current!.trackMenu(mkTrack(1))
    .items.find((i) => i.label === "Credits")!.submenu!();
  expect(spec.wide).toBe(true);
  expect(spec.items[0]).toMatchObject({
    label: "Producer: A",
    multiline: true,
  });
});
it("Track radio opens the mix with its seed artist", async () => {
  const { ref, onNavigate } = renderMenuHost();
  await act(async () => {
    await ref
      .current!.trackMenu({ ...mkTrack(1), mixes: { TRACK_MIX: "m" } })
      .items.find((i) => i.label === "Track radio")!.onSelect!();
  });
  expect(onNavigate).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "mix",
      mixId: "m",
      mixType: "TRACK_MIX",
      artist: { id: 101, name: "A1" },
    }),
  );
});
it("lists every artist of a multi-artist track", () => {
  const { ref, onNavigate } = renderMenuHost();
  const go = ref
    .current!.trackMenu({
      ...mkTrack(1),
      artists: [
        { id: 1, name: "A" },
        { id: 2, name: "B" },
        { id: 1, name: "A" },
      ],
    })
    .items.find((i) => i.label === "Go to artist")!;
  const sub = go.submenu!() as TvMenuSpec;
  expect(sub.items.map((i) => i.label)).toEqual(["A", "B"]);
  void sub.items[1].onSelect!();
  expect(onNavigate).toHaveBeenCalledWith({ type: "artist", id: 2, name: "B" });
});
it("goes straight to a single artist", () => {
  const { ref, onNavigate } = renderMenuHost();
  const go = ref
    .current!.trackMenu({ ...mkTrack(1), artists: undefined })
    .items.find((i) => i.label === "Go to artist")!;
  expect(go.submenu).toBeUndefined();
  void go.onSelect!();
  expect(onNavigate).toHaveBeenCalledWith({
    type: "artist",
    id: 101,
    name: "A1",
  });
});
it("a video can be added to the collection", async () => {
  mockInvoke({ add_favorite_video: () => undefined });
  const { ref, store } = renderMenuHost();
  const like = ref
    .current!.trackMenu(mkTrack(1, { itemType: "video" }))
    .items.find((i) => i.label === "Add to collection")!;
  await act(async () => {
    await like.onSelect!();
  });
  expect(invoke).toHaveBeenCalledWith("add_favorite_video", {
    userId: 42,
    videoId: 1,
  });
  expect(store.get(favoriteVideoIdsAtom).has(1)).toBe(true);
  expect(
    ref
      .current!.mediaMenu({ type: "video", id: 3, title: "V" })
      .items.some((i) => i.label === "Add to collection"),
  ).toBe(true);
  const remove = ref
    .current!.mediaMenu({ type: "video", id: 1, title: "V" })
    .items.find((i) => i.label === "Remove from collection")!;
  expect(remove.checked).toBe(true);
});
it("a failed video like is undone and reported", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  mockInvoke({
    add_favorite_video: () => {
      throw new Error("no");
    },
  });
  const { ref, store } = renderMenuHost();
  const like = ref
    .current!.mediaMenu({ type: "video", id: 3, title: "V" })
    .items.find((i) => i.label === "Add to collection")!;
  await act(async () => {
    await like.onSelect!();
  });
  expect(store.get(favoriteVideoIdsAtom).has(3)).toBe(false);
  expect(
    await screen.findByText("Couldn't update your collection"),
  ).toBeTruthy();
  error.mockRestore();
});
it("shares tracks, videos and collections as a QR code of their link", async () => {
  const { ref } = renderMenuHost();
  const share = (spec: TvMenuSpec) =>
    spec.items.find((i) => i.label === "Share")!.submenu!();
  const host = ref.current!;
  expect((await share(host.trackMenu(mkTrack(7)))).qr).toBe(
    "https://tidal.com/track/7/u",
  );
  expect(
    (await share(host.trackMenu(mkTrack(8, { itemType: "video" })))).qr,
  ).toBe("https://tidal.com/video/8");
  expect(
    (await share(host.mediaMenu({ type: "album", id: 5, title: "A" }))).qr,
  ).toBe("https://tidal.com/album/5");
  expect(
    (await share(host.mediaMenu({ type: "playlist", uuid: "p1", title: "P" })))
      .qr,
  ).toBe("https://tidal.com/playlist/p1");
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
    const spec = navMenus(() => ref.current).mediaMenu(playlist, false, {
      folderId: "f0",
    });
    const sub = await moveMenu(spec);
    expect(sub.items.map((i) => i.label)).toEqual([
      "Playlists (top level)",
      "Rock",
      "New folder…",
    ]);
    await act(async () => {
      await sub.items[1].onSelect!();
    });
    expect(invoke).toHaveBeenCalledWith("move_playlist_to_folder", {
      folderId: "f1",
      playlistTrn: "trn:playlist:p1",
    });
    expect(await screen.findByText('Moved "P" to "Rock"')).toBeTruthy();
  });
  it("moves a playlist out of its folder to the top level", async () => {
    api.getPlaylistFolders.mockResolvedValue(folders(["f1", "Rock"]));
    const { ref, store } = renderMenuHost();
    const sub = await moveMenu(
      ref.current!.mediaMenu(playlist, false, { folderId: "f0" }),
    );
    await act(async () => {
      await sub.items[0].onSelect!();
    });
    expect(invoke).toHaveBeenCalledWith("move_playlist_to_folder", {
      folderId: "root",
      playlistTrn: "trn:playlist:p1",
    });
    expect(store.get(movedPlaylistsAtom).get("p1")).toBe("f0");
    expect(await screen.findByText('Moved "P" to Playlists')).toBeTruthy();
  });
  it("a failed move is undone and reported", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockInvoke({
      move_playlist_to_folder: () => {
        throw new Error("no");
      },
    });
    api.getPlaylistFolders.mockResolvedValue(folders(["f1", "Rock"]));
    const { ref, store } = renderMenuHost();
    const sub = await moveMenu(
      ref.current!.mediaMenu(playlist, false, { folderId: "f0" }),
    );
    await act(async () => {
      await sub.items[1].onSelect!();
    });
    expect(store.get(movedPlaylistsAtom).has("p1")).toBe(false);
    expect(store.get(addedToFolderAtom).get("f1")).toBeUndefined();
    expect(await screen.findByText("Failed to move playlist")).toBeTruthy();
    expect(error.mock.lastCall![0]).toBe(
      "[TvMenuHost] failed to move playlist:",
    );
    error.mockRestore();
  });
  it("a failed folder creation is reported and changes nothing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mockInvoke({
      create_playlist_folder: () => {
        throw new Error("no");
      },
    });
    api.getPlaylistFolders.mockResolvedValue(folders(["f1", "Rock"]));
    const { ref, store, onPrompt } = renderMenuHost();
    onPrompt.mockResolvedValueOnce("Car");
    const sub = await moveMenu(
      ref.current!.mediaMenu(playlist, false, { folderId: "f0" }),
    );
    await act(async () => {
      await sub.items.find((i) => i.label === "New folder…")!.onSelect!();
    });
    expect(store.get(addedToFolderAtom).get("root")).toBeUndefined();
    expect(store.get(movedPlaylistsAtom).has("p1")).toBe(false);
    expect(await screen.findByText("Failed to create folder")).toBeTruthy();
    expect(error.mock.lastCall![0]).toBe(
      "[TvMenuHost] failed to create folder:",
    );
    error.mockRestore();
  });
  it("a new folder is created with the playlist and shown at once", async () => {
    api.getPlaylistFolders.mockResolvedValue(folders(["f1", "Rock"]));
    const { ref, store, onPrompt } = renderMenuHost();
    onPrompt.mockResolvedValueOnce("Car");
    const sub = await moveMenu(
      ref.current!.mediaMenu(playlist, false, { folderId: "f0" }),
    );
    await act(async () => {
      await sub.items.find((i) => i.label === "New folder…")!.onSelect!();
    });
    expect(onPrompt.mock.lastCall![0]).toEqual({
      title: "New folder",
      confirm: "Create and move",
    });
    expect(invoke).toHaveBeenCalledWith("create_playlist_folder", {
      folderId: "root",
      name: "Car",
      trns: "trn:playlist:p1",
    });
    const root = store.get(addedToFolderAtom).get("root")!;
    expect(root.some((e) => e.kind === "folder" && e.data.name === "Car")).toBe(
      true,
    );
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
    localStorage.setItem(
      "sone.recent-folders.v1",
      JSON.stringify(["f3", "gone", "f2"]),
    );
    const { ref, store } = renderMenuHost();
    act(() => {
      store.set(
        allFoldersAtom,
        folders(["f1", "A"], ["f2", "B"], ["f3", "C"]).items.map((i) => ({
          id: i.trn.replace("trn:folder:", ""),
          name: i.name,
          parent: null,
          addedAt: "",
          lastModifiedAt: "",
        })),
      );
      store.set(allFoldersFetchedAtom, true);
    });
    const sub = await moveMenu(ref.current!.mediaMenu(playlist));
    expect(sub.items.map((i) => i.label)).toEqual([
      "C",
      "B",
      "A",
      "New folder…",
    ]);
    expect(api.getPlaylistFolders).not.toHaveBeenCalled();
  });
});

describe("new playlists and playlist details", () => {
  beforeEach(() => {
    mockInvoke({
      create_playlist: () => ({ uuid: "new", title: "Mix" }),
      add_tracks_to_playlist: ({ trackIds }: { trackIds: number[] }) =>
        trackIds,
      update_playlist: () => ({}),
      get_playlist_folders: () => ({
        items: [],
        totalNumberOfItems: 0,
        cursor: null,
      }),
    });
    // addTrackToPlaylist refreshes the user's playlists afterwards.
    api.getPlaylistFolders.mockResolvedValue({
      items: [],
      totalNumberOfItems: 0,
      cursor: null,
    });
  });
  const created = () =>
    vi.mocked(invoke).mock.calls.filter(([c]) => c === "create_playlist");
  const updated = () =>
    vi.mocked(invoke).mock.calls.filter(([c]) => c === "update_playlist");
  const newPlaylist = async (ref: RefObject<TvMenuHostHandle | null>) => {
    const sub = await ref
      .current!.trackMenu(mkTrack(1))
      .items.find((i) => i.label === "Add to playlist")!.submenu!();
    await act(async () => {
      await sub.items.find((i) => i.label === "New playlist…")!.onSelect!();
    });
  };
  const editDetails = async (menu: TvMenuSpec) =>
    (await menu.items.find((i) => i.label === "Edit details")!
      .submenu!()) as TvMenuSpec;
  const ownStore = () => {
    const store = signedIn(42);
    // Set before mount, so the host's own playlist load skips.
    store.set(allPlaylistsAtom, [
      { uuid: "p", title: "Old", creator: { id: 42 } } as Playlist,
    ]);
    return store;
  };

  it("names a new playlist, then asks private or public", async () => {
    const restore = stubLayout();
    try {
      const { ref, onPrompt } = renderMenuHost();
      onPrompt.mockResolvedValueOnce("Mix");
      await newPlaylist(ref);
      expect(onPrompt.mock.lastCall![0]).toEqual({
        title: "New playlist",
        confirm: "Next",
      });
      expect(screen.getByRole("menu", { name: "New playlist" })).toBeTruthy();
      const items = screen.getAllByRole("menuitem");
      expect(items.map((i) => i.textContent)).toEqual([
        "Private playlist",
        "Public playlist",
      ]);
      await waitFor(() => expect(document.activeElement).toBe(items[0]));
      expect(onPrompt).toHaveBeenCalledTimes(1);
      await act(async () => {
        fireEvent.click(items[1]);
      });
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("create_playlist", {
          title: "Mix",
          description: "",
          accessType: "PUBLIC",
        }),
      );
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("add_tracks_to_playlist", {
          playlistId: "new",
          trackIds: [1],
          onDupes: "SKIP",
        }),
      );
      expect(
        await screen.findByText('Added to new playlist "Mix"'),
      ).toBeTruthy();
    } finally {
      restore();
    }
  });
  it("Private is UNLISTED; a cancelled name or Back creates nothing", async () => {
    const { ref, onPrompt } = renderMenuHost();
    onPrompt.mockResolvedValueOnce("Mix");
    await newPlaylist(ref);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Private playlist" }),
      );
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("create_playlist", {
        title: "Mix",
        description: "",
        accessType: "UNLISTED",
      }),
    );
    vi.mocked(invoke).mockClear();

    onPrompt.mockResolvedValueOnce(null);
    await newPlaylist(ref);
    expect(screen.queryByRole("menu")).toBeNull();

    onPrompt.mockResolvedValueOnce("Mix");
    await newPlaylist(ref);
    expect(screen.getByRole("menu", { name: "New playlist" })).toBeTruthy();
    act(() => ref.current!.back());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(created()).toEqual([]);
  });
  it("own playlists edit their name and description from Edit details", async () => {
    const store = ownStore();
    const { ref, onPrompt } = renderMenuHost({ store });
    api.getPlaylistDetails.mockResolvedValue({
      uuid: "p",
      title: "Old",
      description: "d0",
      accessType: "PUBLIC",
    } as Playlist);
    const menu = ref.current!.mediaMenu(
      { type: "playlist", uuid: "p", title: "Old" },
      true,
    );
    expect(menu.items.some((i) => i.label === "Rename playlist")).toBe(false);
    const sub = await editDetails(menu);
    expect(sub).toMatchObject({ title: "Edit details", subtitle: "Old" });
    expect(sub.items.map((i) => i.label)).toEqual(["Name…", "Description…"]);

    onPrompt.mockResolvedValueOnce("New name");
    await act(async () => {
      await sub.items[0].onSelect!();
    });
    expect(onPrompt.mock.lastCall![0]).toEqual({
      title: "Name",
      initial: "Old",
      confirm: "Save",
    });
    expect(invoke).toHaveBeenCalledWith("update_playlist", {
      playlistId: "p",
      title: "New name",
      description: "d0",
      accessType: "PUBLIC",
    });
    expect(await screen.findByText('Renamed to "New name"')).toBeTruthy();

    onPrompt.mockResolvedValueOnce("For the car");
    await act(async () => {
      await sub.items[1].onSelect!();
    });
    expect(onPrompt.mock.lastCall![0]).toEqual({
      title: "Description",
      initial: "d0",
      confirm: "Save",
      placeholder: "Description",
      allowEmpty: true,
      trim: false,
      multiline: true,
    });
    expect(invoke).toHaveBeenLastCalledWith("update_playlist", {
      playlistId: "p",
      title: "Old",
      description: "For the car",
      accessType: "PUBLIC",
    });
    expect(store.get(allPlaylistsAtom)[0]).toMatchObject({
      title: "New name",
      description: "For the car",
    });
    expect(await screen.findByText("Description saved")).toBeTruthy();
  });
  it("an unchanged or cancelled edit changes nothing; an emptied description is saved", async () => {
    const { ref, onPrompt } = renderMenuHost({ store: ownStore() });
    api.getPlaylistDetails.mockResolvedValue({
      uuid: "p",
      title: "Old",
      description: "d0",
      sharingLevel: "PUBLIC",
    } as Playlist);
    const sub = await editDetails(
      ref.current!.mediaMenu({ type: "playlist", uuid: "p", title: "Old" }),
    );
    for (const answer of ["Old", "", null]) {
      onPrompt.mockResolvedValueOnce(answer);
      await act(async () => {
        await sub.items[0].onSelect!();
      });
    }
    for (const answer of ["d0", null]) {
      onPrompt.mockResolvedValueOnce(answer);
      await act(async () => {
        await sub.items[1].onSelect!();
      });
    }
    expect(updated()).toEqual([]);
    onPrompt.mockResolvedValueOnce("");
    await act(async () => {
      await sub.items[1].onSelect!();
    });
    expect(updated()).toEqual([
      [
        "update_playlist",
        {
          playlistId: "p",
          title: "Old",
          description: "",
          accessType: "PUBLIC",
        },
      ],
    ]);
  });
  it("a description that can't be loaded asks for nothing", async () => {
    const { ref, onPrompt } = renderMenuHost({ store: ownStore() });
    api.getPlaylistDetails.mockRejectedValue(new Error("offline"));
    const sub = await editDetails(
      ref.current!.mediaMenu({ type: "playlist", uuid: "p", title: "Old" }),
    );
    await act(async () => {
      await sub.items[1].onSelect!();
    });
    expect(onPrompt).not.toHaveBeenCalled();
    expect(await screen.findByText("Couldn't load the playlist")).toBeTruthy();
  });
  it("a description with line breaks or edge spaces is left alone when untouched and kept when edited", async () => {
    const { ref, onPrompt } = renderMenuHost({ store: ownStore() });
    const text = " Line one\n\nLine two ";
    api.getPlaylistDetails.mockResolvedValue({
      uuid: "p",
      title: "Old",
      description: text,
      accessType: "UNLISTED",
    } as Playlist);
    const sub = await editDetails(
      ref.current!.mediaMenu({ type: "playlist", uuid: "p", title: "Old" }),
    );
    onPrompt.mockImplementationOnce(async (r) => r.initial!);
    await act(async () => {
      await sub.items[1].onSelect!();
    });
    expect(updated()).toEqual([]);
    onPrompt.mockImplementationOnce(async (r) => `${r.initial!}\nLine three`);
    await act(async () => {
      await sub.items[1].onSelect!();
    });
    expect(updated()).toEqual([
      [
        "update_playlist",
        {
          playlistId: "p",
          title: "Old",
          description: `${text}\nLine three`,
          accessType: "UNLISTED",
        },
      ],
    ]);
  });
  it("a card built before a rename edits the playlist's current name", async () => {
    const store = ownStore();
    const { ref, onPrompt } = renderMenuHost({ store });
    act(() =>
      store.set(allPlaylistsAtom, [
        { uuid: "p", title: "Fresh", creator: { id: 42 } } as Playlist,
      ]),
    );
    api.getPlaylistDetails.mockResolvedValue({
      uuid: "p",
      title: "Fresh",
      description: "d0",
      accessType: "PUBLIC",
    } as Playlist);
    const sub = await editDetails(
      ref.current!.mediaMenu({ type: "playlist", uuid: "p", title: "Stale" }),
    );
    expect(sub.subtitle).toBe("Fresh");
    onPrompt.mockResolvedValueOnce("Fresh");
    await act(async () => {
      await sub.items[0].onSelect!();
    });
    expect(onPrompt.mock.lastCall![0]).toMatchObject({ initial: "Fresh" });
    expect(updated()).toEqual([]);
  });
  it("someone else's playlist has no Edit details", () => {
    const store = signedIn(42);
    store.set(allPlaylistsAtom, [
      { uuid: "p", title: "Theirs", creator: { id: 7 } } as Playlist,
    ]);
    const { ref } = renderMenuHost({ store });
    expect(
      ref
        .current!.mediaMenu({ type: "playlist", uuid: "p", title: "Theirs" })
        .items.some((i) => i.label === "Edit details"),
    ).toBe(false);
  });

  const hasEdit = (menu: TvMenuSpec) =>
    menu.items.some((i) => i.label === "Edit details");
  const pl = (uuid: string, creator: number) =>
    ({ uuid, title: uuid, creator: { id: creator } }) as Playlist;

  it("a new playlist whose track can't be added says it was created", async () => {
    mockInvoke({
      create_playlist: () => ({ uuid: "new", title: "Mix" }),
      add_tracks_to_playlist: () => {
        throw new Error("x");
      },
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { ref, onPrompt } = renderMenuHost();
      onPrompt.mockResolvedValueOnce("Mix");
      await newPlaylist(ref);
      await act(async () => {
        fireEvent.click(
          screen.getByRole("menuitem", { name: "Private playlist" }),
        );
      });
      expect(
        await screen.findByText('Created "Mix" but couldn\'t add the track'),
      ).toBeTruthy();
      expect(screen.queryByText("Couldn't create the playlist")).toBeNull();
    } finally {
      quiet.mockRestore();
    }
  });

  it("finds own playlists past the first 500", async () => {
    api.getAllPlaylists.mockImplementation(
      async (_u: number, offset: number) =>
        offset === 0
          ? { items: [pl("a", 42)], totalNumberOfItems: 700 }
          : { items: [pl("late", 42)], totalNumberOfItems: 700 },
    );
    const { ref, store } = renderMenuHost();
    await waitFor(() => expect(store.get(allPlaylistsAtom)).toHaveLength(2));
    expect(api.getAllPlaylists).toHaveBeenCalledWith(42, 500, 500);
    expect(
      hasEdit(
        ref.current!.mediaMenu({
          type: "playlist",
          uuid: "late",
          title: "late",
        }),
      ),
    ).toBe(true);
  });

  it("a failed playlist load is tried again when a menu next opens", async () => {
    api.getAllPlaylists.mockRejectedValueOnce(new Error("offline"));
    const { ref, store } = renderMenuHost();
    await waitFor(() => expect(api.getAllPlaylists).toHaveBeenCalledTimes(1));
    api.getAllPlaylists.mockResolvedValue({
      items: [pl("p", 42)],
      totalNumberOfItems: 1,
    });
    await act(async () => {});
    expect(
      hasEdit(
        ref.current!.mediaMenu({ type: "playlist", uuid: "p", title: "p" }),
      ),
    ).toBe(false);
    await waitFor(() => expect(store.get(allPlaylistsAtom)).toHaveLength(1));
    expect(api.getAllPlaylists).toHaveBeenCalledTimes(2);
    expect(
      hasEdit(
        ref.current!.mediaMenu({ type: "playlist", uuid: "p", title: "p" }),
      ),
    ).toBe(true);
    ref.current!.mediaMenu({ type: "playlist", uuid: "p", title: "p" });
    expect(api.getAllPlaylists).toHaveBeenCalledTimes(2);
  });

  it("on its own page, a playlist the details say is theirs can be edited without the list", async () => {
    api.getAllPlaylists.mockRejectedValue(new Error("offline"));
    const { ref } = renderMenuHost();
    await act(async () => {});
    const item = { type: "playlist", uuid: "p", title: "p" } as const;
    expect(hasEdit(ref.current!.mediaMenu(item, true, { creatorId: 42 }))).toBe(
      true,
    );
    expect(hasEdit(ref.current!.mediaMenu(item, true, { creatorId: 7 }))).toBe(
      false,
    );
  });

  it("adding to a playlist waits for the writes already going to it", async () => {
    const store = ownStore();
    const { ref } = renderMenuHost({ store });
    const removal = deferred<void>();
    void queuePlaylistEdit("p", () => removal.promise);
    const before = playlistRevision("p");
    const sub = await ref
      .current!.trackMenu(mkTrack(1))
      .items.find((i) => i.label === "Add to playlist")!.submenu!();
    const adding = sub.items.find((i) => i.label === "Old")!.onSelect!();
    await act(async () => {});
    expect(playlistRevision("p")).toBe(before + 1);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([c]) => c === "add_tracks_to_playlist"),
    ).toBe(false);
    removal.resolve();
    await act(async () => {
      await adding;
    });
    expect(invoke).toHaveBeenCalledWith("add_tracks_to_playlist", {
      playlistId: "p",
      trackIds: [1],
      onDupes: "SKIP",
    });
  });

  it("a track already in the playlist is skipped, with Add anyway in a menu", async () => {
    mockInvoke({
      add_tracks_to_playlist: ({ onDupes }: { onDupes: string }) =>
        onDupes === "ADD" ? [1] : [],
      get_playlist_folders: () => ({
        items: [],
        totalNumberOfItems: 0,
        cursor: null,
      }),
    });
    const { ref } = renderMenuHost({ store: ownStore() });
    const sub = await ref
      .current!.trackMenu(mkTrack(1))
      .items.find((i) => i.label === "Add to playlist")!.submenu!();
    await act(async () => {
      await sub.items.find((i) => i.label === "Old")!.onSelect!();
    });
    expect(screen.getByRole("menu", { name: 'Already in "Old"' })).toBeTruthy();
    expect(screen.queryByText('Added to "Old"')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Add anyway" }));
    });
    expect(invoke).toHaveBeenLastCalledWith("add_tracks_to_playlist", {
      playlistId: "p",
      trackIds: [1],
      onDupes: "ADD",
    });
    expect(await screen.findByText('Added to "Old" again')).toBeTruthy();
  });

  it("editing details goes behind the playlist's other writes and leaves its pages' rows current", async () => {
    const { ref, onPrompt } = renderMenuHost({ store: ownStore() });
    api.getPlaylistDetails.mockResolvedValue({
      uuid: "p",
      title: "Old",
      description: "d0",
      accessType: "PUBLIC",
    } as Playlist);
    const sub = await editDetails(
      ref.current!.mediaMenu({ type: "playlist", uuid: "p", title: "Old" }),
    );
    const removal = deferred<void>();
    void queuePlaylistEdit("p", () => removal.promise);
    const before = playlistRevision("p");
    onPrompt.mockResolvedValueOnce("New name");
    const renaming = sub.items[0].onSelect!();
    await act(async () => {});
    expect(updated()).toEqual([]);
    removal.resolve();
    await act(async () => {
      await renaming;
    });
    expect(updated()).toHaveLength(1);
    expect(playlistRevision("p")).toBe(before);
  });

  it("Description… asks at once from the stored description, loading the details only to save", async () => {
    const store = signedIn(42);
    store.set(allPlaylistsAtom, [
      {
        uuid: "p",
        title: "Old",
        description: "d0",
        creator: { id: 42 },
      } as Playlist,
    ]);
    const { ref, onPrompt } = renderMenuHost({ store });
    const details = deferred<Playlist>();
    api.getPlaylistDetails.mockReturnValue(details.promise);
    act(() =>
      ref.current!.open(
        ref.current!.mediaMenu({ type: "playlist", uuid: "p", title: "Old" }),
      ),
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("menuitem", { name: "Edit details" })),
    );
    const answer = deferred<string | null>();
    onPrompt.mockReturnValueOnce(answer.promise);
    // The prompt is asked for in the same click that closes the menu.
    act(() =>
      fireEvent.click(screen.getByRole("menuitem", { name: "Description…" })),
    );
    expect(onPrompt.mock.lastCall![0]).toMatchObject({
      title: "Description",
      initial: "d0",
    });
    expect(api.getPlaylistDetails).not.toHaveBeenCalled();
    await act(async () => answer.resolve("For the car"));
    expect(api.getPlaylistDetails).toHaveBeenCalledWith("p");
    await act(async () =>
      details.resolve({
        uuid: "p",
        title: "Server name",
        description: "d0",
        accessType: "PUBLIC",
      } as Playlist),
    );
    expect(updated()).toEqual([
      [
        "update_playlist",
        {
          playlistId: "p",
          title: "Server name",
          description: "For the car",
          accessType: "PUBLIC",
        },
      ],
    ]);
    expect(store.get(allPlaylistsAtom)[0].description).toBe("For the car");
  });

  it("a description whose details can't be loaded on save is reported", async () => {
    const store = signedIn(42);
    store.set(allPlaylistsAtom, [
      {
        uuid: "p",
        title: "Old",
        description: "",
        creator: { id: 42 },
      } as Playlist,
    ]);
    const { ref, onPrompt } = renderMenuHost({ store });
    api.getPlaylistDetails.mockRejectedValue(new Error("offline"));
    const sub = await editDetails(
      ref.current!.mediaMenu({ type: "playlist", uuid: "p", title: "Old" }),
    );
    onPrompt.mockResolvedValueOnce("New");
    await act(async () => {
      await sub.items[1].onSelect!();
    });
    expect(onPrompt.mock.lastCall![0]).toMatchObject({ initial: "" });
    expect(updated()).toEqual([]);
    expect(
      await screen.findByText("Couldn't save the description"),
    ).toBeTruthy();
  });
});

describe("Add to playlist", () => {
  const own = (...titles: string[]) =>
    titles.map(
      (t) =>
        ({ uuid: t.toLowerCase(), title: t, creator: { id: 42 } }) as Playlist,
    );
  const recentKey = "sone.recent-playlists.v1";
  beforeEach(() => {
    mockInvoke({
      create_playlist: () => ({ uuid: "new", title: "Mix" }),
      add_tracks_to_playlist: ({ trackIds }: { trackIds: number[] }) =>
        trackIds,
      get_playlist_folders: () => ({
        items: [],
        totalNumberOfItems: 0,
        cursor: null,
      }),
    });
    api.getPlaylistFolders.mockResolvedValue({
      items: [],
      totalNumberOfItems: 0,
      cursor: null,
    });
  });
  const storeWith = (playlists: Playlist[]) => {
    const store = signedIn(42);
    store.set(allPlaylistsAtom, playlists);
    return store;
  };
  const addMenu = async (ref: RefObject<TvMenuHostHandle | null>) =>
    (await ref
      .current!.trackMenu(mkTrack(1))
      .items.find((i) => i.label === "Add to playlist")!
      .submenu!()) as TvMenuSpec;
  const labels = (menu: TvMenuSpec) => menu.items.map((i) => i.label);

  it("lists the playlists last added to first, here or on the desktop", async () => {
    localStorage.setItem(recentKey, JSON.stringify(["c", "gone", "a"]));
    const { ref } = renderMenuHost({ store: storeWith(own("A", "B", "C")) });
    const menu = await addMenu(ref);
    expect(labels(menu)).toEqual(["New playlist…", "Search…", "C", "A", "B"]);
    await act(async () => {
      await menu.items.find((i) => i.label === "B")!.onSelect!();
    });
    expect(JSON.parse(localStorage.getItem(recentKey)!)).toEqual([
      "b",
      "c",
      "gone",
      "a",
    ]);
    expect(labels(await addMenu(ref)).slice(2)).toEqual(["B", "C", "A"]);
  });

  it("a new playlist becomes the most recent", async () => {
    const { ref, onPrompt } = renderMenuHost({ store: storeWith(own("A")) });
    onPrompt.mockResolvedValueOnce("Mix");
    const menu = await addMenu(ref);
    await act(async () => {
      await menu.items.find((i) => i.label === "New playlist…")!.onSelect!();
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Private playlist" }),
      );
    });
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(recentKey)!)).toEqual(["new"]),
    );
  });

  it("no Search without playlists", async () => {
    const { ref } = renderMenuHost({ store: storeWith([]) });
    expect(labels(await addMenu(ref))).toEqual([
      "New playlist…",
      "You have no playlists yet",
    ]);
  });

  it("Search… asks over the menu and lists the matching playlists; Back returns to the list", async () => {
    const restore = stubLayout();
    try {
      const { ref, onPrompt } = renderMenuHost({
        store: storeWith(own("Road trip", "Rock", "Jazz")),
      });
      act(() => ref.current!.open(ref.current!.trackMenu(mkTrack(1))));
      await act(async () =>
        fireEvent.click(
          screen.getByRole("menuitem", { name: "Add to playlist" }),
        ),
      );
      const answer = deferred<string | null>();
      onPrompt.mockReturnValueOnce(answer.promise);
      await act(async () =>
        fireEvent.click(screen.getByRole("menuitem", { name: "Search…" })),
      );
      expect(onPrompt.mock.lastCall![0]).toMatchObject({
        title: "Search playlists",
        confirm: "Search",
      });
      // Still there under the prompt.
      expect(
        screen.getByRole("menu", { name: "Add to playlist" }),
      ).toBeTruthy();
      await act(async () => answer.resolve("RO"));
      expect(
        screen.getByRole("menu", { name: 'Playlists matching "RO"' }),
      ).toBeTruthy();
      const found = screen.getAllByRole("menuitem");
      expect(found.map((i) => i.textContent)).toEqual(["Road trip", "Rock"]);
      expect(document.activeElement).toBe(found[0]);
      act(() => ref.current!.back());
      expect(document.activeElement).toBe(
        screen.getByRole("menuitem", { name: "Search…" }),
      );

      onPrompt.mockResolvedValueOnce("nothing");
      await act(async () =>
        fireEvent.click(screen.getByRole("menuitem", { name: "Search…" })),
      );
      expect(screen.getByRole("menuitem").textContent).toBe(
        'No playlists match "nothing"',
      );
      act(() => ref.current!.back());

      onPrompt.mockResolvedValueOnce(null);
      await act(async () =>
        fireEvent.click(screen.getByRole("menuitem", { name: "Search…" })),
      );
      expect(
        screen.getByRole("menu", { name: "Add to playlist" }),
      ).toBeTruthy();

      onPrompt.mockResolvedValueOnce("jazz");
      await act(async () =>
        fireEvent.click(screen.getByRole("menuitem", { name: "Search…" })),
      );
      await act(async () =>
        fireEvent.click(screen.getByRole("menuitem", { name: "Jazz" })),
      );
      expect(invoke).toHaveBeenCalledWith("add_tracks_to_playlist", {
        playlistId: "jazz",
        trackIds: [1],
        onDupes: "SKIP",
      });
      expect(await screen.findByText('Added to "Jazz"')).toBeTruthy();
    } finally {
      restore();
    }
  });
});
