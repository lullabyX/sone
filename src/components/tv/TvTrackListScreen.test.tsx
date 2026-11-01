import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createStore } from "jotai";
import { favoriteTrackIdsAtom, optimisticFavoriteMixesAtom, trackSortPrefsAtom } from "../../atoms/favorites";
import { allowExplicitAtom } from "../../atoms/playback";
import { allPlaylistsAtom } from "../../atoms/playlists";
import type { Playlist, Track } from "../../types";
import TvTrackListScreen from "./TvTrackListScreen";
import { TvScreenContext, type TvNav } from "./TvNavContext";
import { deferred, type Deferred, makeTvNav, mkTrack, mockInvoke, range, renderTv, setupTvTest, signedIn, stubLayout } from "./tvTestUtils";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const api = vi.hoisted(() => ({
  getAlbumPage: vi.fn(),
  getPlaylistDetails: vi.fn(),
  getPlaylistTracksPage: vi.fn(),
  getFavoriteTracks: vi.fn(),
  getMixItems: vi.fn(),
  getArtistTopTracksAll: vi.fn(),
  getPlaylistRecommendations: vi.fn(async () => ({ items: [] as Track[] })),
}));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()),
  ...api,
}));

setupTvTest();

beforeEach(() => {
  for (const m of Object.values(api)) m.mockReset();
  mockInvoke({});
});

const rowButton = (title: string) => screen.getByText(title).closest("button")!;
const rowFor = (title: string) => screen.getByText(title).closest(".tv-track-row") as HTMLElement;
const rowMore = (title: string) => within(rowFor(title)).getByRole("button", { name: "More options" });

const album = (tracks: Track[]) => ({ page: { album: { id: 5, title: "LP", cover: "c" }, tracks } });

const [t1, t2] = [mkTrack(1), mkTrack(2)];

it("plays, shuffles and starts at a row through the album's source", async () => {
  api.getAlbumPage.mockResolvedValue(album([t1, t2]));
  const { nav } = renderTv(<TvTrackListScreen view={{ type: "album", id: 5 }} />);
  await screen.findByText("LP");
  const calls = vi.mocked(nav.playSource).mock;
  fireEvent.click(screen.getByRole("button", { name: "Shuffle" }));
  expect(calls.lastCall![0]).toMatchObject({ meta: { type: "album", id: 5 }, loaded: [t1, t2], albumMode: true });
  expect(calls.lastCall![1]).toEqual({ shuffle: true });
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  expect(calls.lastCall![1]).toBeUndefined();
  fireEvent.click(rowButton("T2"));
  expect(calls.lastCall![1]).toEqual({ startAt: t2 });
  expect(nav.openNowPlaying).not.toHaveBeenCalled();
});

it("groups a multi-disc album and numbers each disc from 1", async () => {
  const v = (id: number, vol?: number) => mkTrack(id, { volumeNumber: vol });
  api.getAlbumPage.mockResolvedValue(album([v(1, 1), v(2, 1), v(3, 2)]));
  renderTv(<TvTrackListScreen view={{ type: "album", id: 5 }} />);
  expect(await screen.findByText("Volume 2")).toBeTruthy();
  expect(screen.getByText("Volume 1")).toBeTruthy();
  const row = rowButton("T3");
  expect(row.closest("[data-tv-index]")!.getAttribute("data-tv-index")).toBe("2");
  expect(within(row).getByText("1")).toBeTruthy();
});

it("a single-disc album has no disc headings", async () => {
  api.getAlbumPage.mockResolvedValue(album([t1, mkTrack(2, { volumeNumber: 1 })]));
  renderTv(<TvTrackListScreen view={{ type: "album", id: 5 }} />);
  await screen.findByText("T2");
  expect(screen.queryByText(/^Volume \d/)).toBeNull();
});

it("track radio plays as radio with its mix type and links the seed artist", async () => {
  api.getMixItems.mockResolvedValue({ mixId: "m", mixType: "TRACK_MIX", title: "T Radio", subtitle: null, image: null, tracks: [mkTrack(1)] });
  const { nav } = renderTv(<TvTrackListScreen view={{ type: "mix", mixId: "m", artist: { id: 7, name: "Seed" } }} />);
  expect(await screen.findByText("Track Radio")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  expect(vi.mocked(nav.playSource).mock.lastCall![0].meta).toMatchObject({ type: "radio", mixType: "TRACK_MIX" });
  fireEvent.click(screen.getByRole("button", { name: /Seed/ }));
  expect(nav.push).toHaveBeenCalledWith({ type: "artist", id: 7, name: "Seed" });
});

it("a track radio without a seed artist links its first track's artist; a mix links none", async () => {
  api.getMixItems.mockResolvedValue({ mixId: "m", mixType: null, title: "T Radio", subtitle: null, image: null, tracks: [mkTrack(1)] });
  const { unmount } = renderTv(<TvTrackListScreen view={{ type: "mix", mixId: "m", mixType: "TRACK_MIX" }} />);
  expect(await screen.findByText("Track Radio")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Go to A1" })).toBeTruthy();
  unmount();
  api.getMixItems.mockResolvedValue({ mixId: "x", mixType: "ARTIST_MIX", title: "A Radio", subtitle: null, image: null, tracks: [mkTrack(1)] });
  const { nav } = renderTv(<TvTrackListScreen view={{ type: "mix", mixId: "x" }} />);
  expect(await screen.findByText("Mix")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Go to A1" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  expect(vi.mocked(nav.playSource).mock.lastCall![0].meta).toMatchObject({ type: "mix", mixType: "ARTIST_MIX" });
});

it("mix meta follows the desktop: the opened card's title and image first, with the subtitle", async () => {
  api.getMixItems.mockResolvedValue({ mixId: "m", mixType: "DISCOVERY_MIX", title: "Fetched", subtitle: "Sub", image: "f.jpg", tracks: [mkTrack(1)] });
  const { nav, unmount } = renderTv(<TvTrackListScreen view={{ type: "mix", mixId: "m", title: "Card", image: "c.jpg" }} />);
  fireEvent.click(await screen.findByRole("button", { name: "Play" }));
  expect(vi.mocked(nav.playSource).mock.lastCall![0].meta).toMatchObject({ type: "mix", name: "Card", image: "c.jpg", subtitle: "Sub" });
  unmount();
  api.getMixItems.mockResolvedValue({ mixId: "r", mixType: "TRACK_MIX", title: null, subtitle: null, image: null, tracks: [mkTrack(1)] });
  const second = renderTv(<TvTrackListScreen view={{ type: "mix", mixId: "r" }} />);
  fireEvent.click(await screen.findByRole("button", { name: "Play" }));
  expect(vi.mocked(second.nav.playSource).mock.lastCall![0].meta).toMatchObject({ type: "radio", name: "Track Radio" });
});

it("saving a mix keeps its type", async () => {
  mockInvoke({ add_favorite_mix: () => undefined });
  api.getMixItems.mockResolvedValue({ mixId: "m", mixType: "TRACK_MIX", title: "T Radio", subtitle: null, image: null, tracks: [mkTrack(1)] });
  const store = signedIn(1);
  renderTv(<TvTrackListScreen view={{ type: "mix", mixId: "m" }} />, { store });
  fireEvent.click(await screen.findByRole("button", { name: "Add to collection" }));
  expect(store.get(optimisticFavoriteMixesAtom)[0]).toMatchObject({ id: "m", mixType: "TRACK_MIX" });
});

it("the top-tracks screen pages and plays as the artist", async () => {
  api.getArtistTopTracksAll.mockResolvedValueOnce({ items: [mkTrack(1), mkTrack(2), mkTrack(1)], hasMore: true });
  const { nav } = renderTv(<TvTrackListScreen view={{ type: "artistTracks", artistId: 9, name: "X" }} />);
  expect(await screen.findByText("X: Top tracks")).toBeTruthy();
  expect(api.getArtistTopTracksAll).toHaveBeenCalledWith(9, 0, 50);
  expect(screen.getByText("Artist")).toBeTruthy();
  expect(screen.getAllByText("T1")).toHaveLength(1);
  expect(screen.queryByText(/\d+ tracks/)).toBeNull();
  const side = document.querySelector("aside")!;
  expect(within(side).queryByRole("button", { name: "Add to collection" })).toBeNull();
  expect(within(side).queryByRole("button", { name: "More options" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  const src = vi.mocked(nav.playSource).mock.lastCall![0];
  expect(src).toMatchObject({ meta: { type: "artist-tracks", id: 9, name: "X" }, dedupe: true, nextOffset: 3, hasMore: true });
  api.getArtistTopTracksAll.mockResolvedValueOnce({ items: [], hasMore: false });
  await src.fetchPage!(3);
  expect(api.getArtistTopTracksAll).toHaveBeenLastCalledWith(9, 3, 50);
});

const shownRows = () => document.querySelectorAll(".tv-track-row[data-tv-index]").length;

it("renders a 300-track album in chunks", async () => {
  api.getAlbumPage.mockResolvedValue(album(range(300).map((i) => mkTrack(i + 1))));
  renderTv(<TvTrackListScreen view={{ type: "album", id: 5 }} />);
  await screen.findByText("T1");
  expect(shownRows()).toBe(60);
  act(() => rowButton("T46").focus());
  expect(shownRows()).toBe(120);
});

it("a later disc's heading shows once its first row is in the window", async () => {
  const tracks = range(100).map((i) => mkTrack(i + 1, { volumeNumber: i < 70 ? 1 : 2 }));
  api.getAlbumPage.mockResolvedValue(album(tracks));
  renderTv(<TvTrackListScreen view={{ type: "album", id: 5 }} />);
  await screen.findByText("Volume 1");
  expect(screen.queryByText("Volume 2")).toBeNull();
  expect(shownRows()).toBe(60);
  act(() => rowButton("T46").focus());
  expect(screen.getByText("Volume 2")).toBeTruthy();
  expect(shownRows()).toBe(100);
});

it("a blocked row has no action menu", async () => {
  api.getAlbumPage.mockResolvedValue(album([t1, mkTrack(2, { explicit: true })]));
  const store = createStore();
  store.set(allowExplicitAtom, false);
  renderTv(<TvTrackListScreen view={{ type: "album", id: 5 }} />, { store });
  await screen.findByText("T2");
  expect(rowButton("T2").hasAttribute("data-tv-has-menu")).toBe(false);
  expect(within(rowFor("T2")).queryByRole("button", { name: "More options" })).toBeNull();
  expect(rowButton("T1").hasAttribute("data-tv-has-menu")).toBe(true);
  expect(rowMore("T1")).toBeTruthy();
});

it("after a removal focus lands on the row that took its place, past a blocked row (guard)", async () => {
  api.getPlaylistDetails.mockResolvedValue({ uuid: "p", title: "P", numberOfTracks: 5, creator: { id: 42 } });
  api.getPlaylistTracksPage.mockResolvedValue({
    items: [mkTrack(1, { explicit: true }), mkTrack(2), mkTrack(3), mkTrack(4), mkTrack(5)],
    totalNumberOfItems: 5,
  });
  mockInvoke({
    remove_track_from_playlist: () => undefined,
    get_playlist_folders: () => ({ items: [], totalNumberOfItems: 0, cursor: null }),
  });
  const store = signedIn(42);
  store.set(allowExplicitAtom, false);
  const { nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store });
  await screen.findByText("T2");
  fireEvent.click(rowMore("T2"));
  await act(() => vi.mocked(nav.trackMenu).mock.lastCall![1]![0].onSelect!());
  await waitFor(() => expect(document.activeElement).toBe(rowButton("T3")));
});

it("My Tracks renders the first page, hides un-liked rows and plays the rest lazily", async () => {
  const [a, b, c] = [mkTrack(1), mkTrack(2), mkTrack(3)];
  api.getFavoriteTracks.mockResolvedValueOnce({ items: [a, b, c], totalNumberOfItems: 250 })
    .mockResolvedValue({ items: [], totalNumberOfItems: 250 });
  const store = signedIn(42); store.set(favoriteTrackIdsAtom, new Set([1, 2, 3]));
  const { nav } = renderTv(<TvTrackListScreen view={{ type: "favorites" }} />, { store });
  await screen.findByText("T3");
  expect(api.getFavoriteTracks).toHaveBeenCalledTimes(1);
  act(() => store.set(favoriteTrackIdsAtom, new Set([1, 2])));
  expect(screen.queryByText("T3")).toBeNull();
  expect(screen.getByText(/249 tracks/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  const src = vi.mocked(nav.playSource).mock.lastCall![0];
  expect(src).toMatchObject({ meta: { type: "favorites", id: "favorites", name: "Loved Tracks" }, nextOffset: 3, hasMore: true });
  expect(src.include!(c)).toBe(false);
  expect(src.dedupe).toBeUndefined();
});

it("a failing second page keeps the rows, marks loading, and offers a retry", async () => {
  const d = deferred<{ items: Track[]; totalNumberOfItems: number }>();
  api.getFavoriteTracks
    .mockResolvedValueOnce({ items: range(30).map((i) => mkTrack(i + 1)), totalNumberOfItems: 250 })
    .mockReturnValueOnce(d.promise);
  const store = signedIn(42);
  store.set(favoriteTrackIdsAtom, new Set(range(31).map((i) => i + 1)));
  const { container } = renderTv(<TvTrackListScreen view={{ type: "favorites" }} />, { store });
  await screen.findByText("T25");
  const root = container.querySelector("[data-tv-scroll-root]")!;
  act(() => rowButton("T25").focus());
  expect(root.hasAttribute("data-tv-loading")).toBe(true);
  await act(async () => d.reject(new Error("x")));
  expect(screen.getByText("T1")).toBeTruthy();
  const again = await screen.findByRole("button", { name: "Try again" });
  expect(root.hasAttribute("data-tv-loading")).toBe(false);
  api.getFavoriteTracks.mockResolvedValueOnce({ items: [mkTrack(31)], totalNumberOfItems: 31 });
  fireEvent.click(again);
  await screen.findByText("T31");
});

it("shows the description and reads a long one in a wide panel", async () => {
  const long = `${"Late-night jazz. ".repeat(8)}\nSecond paragraph.`;
  api.getPlaylistDetails.mockResolvedValue({ uuid: "p", title: "P", numberOfTracks: 1, creator: { id: 42 }, description: long });
  api.getPlaylistTracksPage.mockResolvedValue({ items: [t1], totalNumberOfItems: 1 });
  mockInvoke({ get_playlist_folders: () => ({ items: [], totalNumberOfItems: 0, cursor: null }) });
  const { nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store: signedIn(42) });
  expect(await screen.findByText(/Late-night jazz\./)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "About" }));
  expect(vi.mocked(nav.openMenu).mock.lastCall![0]).toMatchObject({ wide: true, items: [{ multiline: true }, { label: "Second paragraph.", multiline: true }] });
});

it("shows recommendations once the playlist is fully loaded and adds one", async () => {
  api.getPlaylistDetails.mockResolvedValue({ uuid: "p", title: "P", numberOfTracks: 1, creator: { id: 42 } });
  api.getPlaylistTracksPage.mockResolvedValue({ items: [mkTrack(900)], totalNumberOfItems: 1 });
  api.getPlaylistRecommendations.mockResolvedValue({ items: range(12).map((i) => mkTrack(i + 1)) });
  mockInvoke({
    add_track_to_playlist: () => undefined,
    get_playlist_folders: () => ({ items: [], totalNumberOfItems: 0, cursor: null }),
  });
  const { nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store: signedIn(42) });
  expect(await screen.findByText("Recommended tracks")).toBeTruthy();
  expect(screen.queryByText("T11")).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  fireEvent.click(rowButton("T2"));
  expect(vi.mocked(nav.playSource).mock.lastCall![0].meta).toMatchObject({ type: "playlist-recs", id: "p" });
  fireEvent.click(rowMore("T2"));
  await act(async () => {
    await vi.mocked(nav.trackMenu).mock.lastCall![1]!.find((i) => i.label === "Add to this playlist")!.onSelect!();
  });
  expect(invoke).toHaveBeenCalledWith("add_track_to_playlist", { playlistId: "p", trackId: 2 });
  expect(screen.queryByText("T2")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(rowButton("T3")));
});

describe("recommendations", () => {
  const rec = mkTrack(500);
  const addEntry = (nav: TvNav, title: string) => {
    fireEvent.click(rowMore(title));
    return vi.mocked(nav.trackMenu).mock.lastCall![1]?.find((i) => i.label === "Add to this playlist");
  };
  const playlist = (creator: number, tracks: Track[], total = tracks.length) => {
    api.getPlaylistDetails.mockResolvedValue({ uuid: "p", title: "P", numberOfTracks: total, creator: { id: creator } });
    api.getPlaylistTracksPage.mockResolvedValue({ items: tracks, totalNumberOfItems: total });
  };
  beforeEach(() => {
    api.getPlaylistRecommendations.mockResolvedValue({ items: [rec] });
    mockInvoke({
      add_track_to_playlist: () => undefined,
      remove_track_from_playlist: () => undefined,
      get_playlist_folders: () => ({ items: [], totalNumberOfItems: 0, cursor: null }),
    });
  });

  it("are hidden while more of the playlist is still to load", async () => {
    playlist(42, [t1], 250);
    renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store: signedIn(42) });
    await screen.findByText("T1");
    await act(async () => {});
    expect(api.getPlaylistRecommendations).toHaveBeenCalled();
    expect(screen.queryByText("Recommended tracks")).toBeNull();
  });

  it("are hidden under an empty playlist, as on the desktop", async () => {
    playlist(42, []);
    renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store: signedIn(42) });
    await screen.findByText("No tracks here yet.");
    await act(async () => {});
    expect(api.getPlaylistRecommendations).toHaveBeenCalled();
    expect(screen.queryByText("Recommended tracks")).toBeNull();
  });

  it("offer no Add on someone else's playlist", async () => {
    playlist(7, [t1]);
    const { nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store: signedIn(42) });
    await screen.findByText("Recommended tracks");
    expect(addEntry(nav, "T500")).toBeUndefined();
  });

  it("a failed add puts the recommendation back", async () => {
    playlist(42, [t1]);
    mockInvoke({
      add_track_to_playlist: () => {
        throw new Error("x");
      },
      get_playlist_folders: () => ({ items: [], totalNumberOfItems: 0, cursor: null }),
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store: signedIn(42) });
      await screen.findByText("T500");
      await act(async () => {
        await addEntry(nav, "T500")!.onSelect!();
      });
      expect(await screen.findByText("Failed to add track")).toBeTruthy();
      expect(screen.getByText("T500")).toBeTruthy();
      expect(screen.getByText(/\b1 Track\b/)).toBeTruthy();
    } finally {
      quiet.mockRestore();
    }
  });

  it("an add goes out after a removal still in flight, and counts the track", async () => {
    playlist(42, [t1, t2]);
    const removal = deferred<void>();
    mockInvoke({
      add_track_to_playlist: () => undefined,
      remove_track_from_playlist: () => removal.promise,
      get_playlist_folders: () => ({ items: [], totalNumberOfItems: 0, cursor: null }),
    });
    const { nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store: signedIn(42) });
    await screen.findByText("T500");
    fireEvent.click(rowMore("T2"));
    act(() => void vi.mocked(nav.trackMenu).mock.lastCall![1]![0].onSelect!());
    await act(async () => {});
    const adding = addEntry(nav, "T500")!.onSelect!();
    await act(async () => {});
    const sent = () => vi.mocked(invoke).mock.calls.map(([c]) => c).filter((c) => c.endsWith("_playlist"));
    expect(sent()).toEqual(["remove_track_from_playlist"]);
    removal.resolve();
    await act(async () => {
      await adding;
    });
    expect(sent()).toEqual(["remove_track_from_playlist", "add_track_to_playlist"]);
    expect(screen.getByText(/\b2 Tracks\b/)).toBeTruthy();
  });

  it("after adding one, a removal reloads the list first (where the server put the track is not assumed)", async () => {
    playlist(42, [t1, t2]);
    const { nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store: signedIn(42) });
    await screen.findByText("T500");
    await act(async () => {
      await addEntry(nav, "T500")!.onSelect!();
    });
    playlist(42, [t1, t2, rec]);
    fireEvent.click(rowMore("T2"));
    await act(async () => void vi.mocked(nav.trackMenu).mock.lastCall![1]![0].onSelect!());
    expect(vi.mocked(invoke).mock.calls.some(([c]) => c === "remove_track_from_playlist")).toBe(false);
    expect(screen.getByText("This playlist changed — reloading")).toBeTruthy();
    await screen.findByText("T500");
    fireEvent.click(rowMore("T2"));
    await act(async () => void vi.mocked(nav.trackMenu).mock.lastCall![1]![0].onSelect!());
    expect(invoke).toHaveBeenCalledWith("remove_track_from_playlist", { playlistId: "p", index: 1 });
  });

  it("a Refresh that leaves none moves focus to the last row", async () => {
    playlist(42, [t1, t2]);
    api.getPlaylistRecommendations.mockResolvedValueOnce({ items: [rec] }).mockResolvedValue({ items: [] });
    const restore = stubLayout();
    try {
      renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store: signedIn(42) });
      const refresh = await screen.findByRole("button", { name: "Refresh" });
      act(() => refresh.focus());
      await act(async () => {
        fireEvent.click(refresh);
      });
      await waitFor(() => expect(screen.queryByText("Recommended tracks")).toBeNull());
      expect(document.activeElement).toBe(rowButton("T2"));
    } finally {
      restore();
    }
  });
});

it("the page's More options knows its own playlist without the stored list", async () => {
  api.getPlaylistDetails.mockResolvedValue({ uuid: "p", title: "P", numberOfTracks: 1, creator: { id: 42 } });
  api.getPlaylistTracksPage.mockResolvedValue({ items: [t1], totalNumberOfItems: 1 });
  mockInvoke({ get_playlist_folders: () => ({ items: [], totalNumberOfItems: 0, cursor: null }) });
  const { nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store: signedIn(42) });
  await screen.findByText("T1");
  fireEvent.click(screen.getAllByRole("button", { name: "More options" })[0]);
  expect(vi.mocked(nav.mediaMenu).mock.lastCall).toEqual([
    expect.objectContaining({ type: "playlist", uuid: "p" }),
    true,
    { creatorId: 42 },
  ]);
});

it("a paged playlist shows every loaded row, unwindowed", async () => {
  api.getPlaylistDetails.mockResolvedValue({ uuid: "p", title: "P", numberOfTracks: 250, creator: { id: 7 } });
  api.getPlaylistTracksPage.mockResolvedValue({ items: range(100).map((i) => mkTrack(i + 1)), totalNumberOfItems: 250 });
  mockInvoke({ get_playlist_folders: () => ({ items: [], totalNumberOfItems: 0, cursor: null }) });
  renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store: signedIn(42) });
  await screen.findByText("T1");
  expect(document.querySelectorAll(".tv-track-row[data-tv-index]").length).toBe(100);
});

it("a row of a 300-track album plays the whole album from it", async () => {
  const tracks = range(300).map((i) => mkTrack(i + 1));
  api.getAlbumPage.mockResolvedValue(album(tracks));
  const { nav } = renderTv(<TvTrackListScreen view={{ type: "album", id: 5 }} />);
  await screen.findByText("T5");
  fireEvent.click(rowButton("T5"));
  const [src, opts] = vi.mocked(nav.playSource).mock.lastCall!;
  expect(src.loaded).toHaveLength(300);
  expect(src.loaded).toEqual(tracks);
  expect(opts).toEqual({ startAt: tracks[4] });
});

it("a second-disc row plays the album from that track", async () => {
  const tracks = [mkTrack(1, { volumeNumber: 1 }), mkTrack(2, { volumeNumber: 1 }), mkTrack(3, { volumeNumber: 2 })];
  api.getAlbumPage.mockResolvedValue(album(tracks));
  const { nav } = renderTv(<TvTrackListScreen view={{ type: "album", id: 5 }} />);
  await screen.findByText("Volume 2");
  fireEvent.click(rowButton("T3"));
  const [src, opts] = vi.mocked(nav.playSource).mock.lastCall!;
  expect(src.loaded).toEqual(tracks);
  expect(opts).toEqual({ startAt: tracks[2] });
});

it("shows an edited name and description at once", async () => {
  api.getPlaylistDetails.mockResolvedValue({ uuid: "p", title: "P", numberOfTracks: 1, creator: { id: 42 }, description: "d0" });
  api.getPlaylistTracksPage.mockResolvedValue({ items: [t1], totalNumberOfItems: 1 });
  mockInvoke({ get_playlist_folders: () => ({ items: [], totalNumberOfItems: 0, cursor: null }) });
  const { store, nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store: signedIn(42) });
  await screen.findByText("T1");
  expect(screen.getByText("d0")).toBeTruthy();
  act(() => store.set(allPlaylistsAtom, [{ uuid: "p", title: "Renamed", description: "Road trip", creator: { id: 42 } } as Playlist]));
  expect(screen.getByText("Renamed")).toBeTruthy();
  expect(screen.getByText("Road trip")).toBeTruthy();
  // The page's own More options comes first, before the rows'.
  fireEvent.click(screen.getAllByRole("button", { name: "More options" })[0]);
  expect(vi.mocked(nav.mediaMenu).mock.lastCall![0]).toMatchObject({ type: "playlist", uuid: "p", title: "Renamed" });
  act(() => store.set(allPlaylistsAtom, [{ uuid: "p", title: "Renamed", description: "", creator: { id: 42 } } as Playlist]));
  expect(screen.queryByText("Road trip")).toBeNull();
  expect(screen.queryByText("d0")).toBeNull();
});

it("freshly loaded details replace the stored name and description", async () => {
  api.getPlaylistDetails.mockResolvedValue({ uuid: "p", title: "P", numberOfTracks: 1, creator: { id: 42 }, description: "Line one\nLine two" });
  api.getPlaylistTracksPage.mockResolvedValue({ items: [t1], totalNumberOfItems: 1 });
  mockInvoke({ get_playlist_folders: () => ({ items: [], totalNumberOfItems: 0, cursor: null }) });
  const store = signedIn(42);
  const other = { uuid: "q", title: "Q", description: "q0", creator: { id: 42 } } as Playlist;
  store.set(allPlaylistsAtom, [{ uuid: "p", title: "Old", description: "old", creator: { id: 42 }, numberOfTracks: 1 } as Playlist, other]);
  renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store });
  await screen.findByText("T1");
  expect(screen.getByRole("heading", { name: "P" })).toBeTruthy();
  expect(screen.getByText(/Line one/)).toBeTruthy();
  expect(screen.queryByText("Old")).toBeNull();
  expect(store.get(allPlaylistsAtom)).toEqual([
    { uuid: "p", title: "P", description: "Line one\nLine two", creator: { id: 42 }, numberOfTracks: 1 },
    other,
  ]);
  expect(store.get(allPlaylistsAtom)[1]).toBe(other);
});

it("a playlist missing from the stored list adds no entry", async () => {
  api.getPlaylistDetails.mockResolvedValue({ uuid: "p", title: "P", numberOfTracks: 1, creator: { id: 7 } });
  api.getPlaylistTracksPage.mockResolvedValue({ items: [t1], totalNumberOfItems: 1 });
  mockInvoke({ get_playlist_folders: () => ({ items: [], totalNumberOfItems: 0, cursor: null }) });
  const store = signedIn(42);
  const list = [{ uuid: "q", title: "Q", creator: { id: 42 } } as Playlist];
  store.set(allPlaylistsAtom, list);
  renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store });
  await screen.findByText("T1");
  expect(store.get(allPlaylistsAtom)).toBe(list);
});

describe("playlist removals", () => {
  const [a, b, c] = [mkTrack(1), mkTrack(2), mkTrack(3)];
  let pending: Deferred<void>[];
  let store: ReturnType<typeof signedIn>;
  const removeCalls = () =>
    vi.mocked(invoke).mock.calls.filter(([c]) => c === "remove_track_from_playlist").map(([, x]) => x);

  beforeEach(() => {
    api.getPlaylistDetails.mockResolvedValue({ uuid: "p", title: "P", numberOfTracks: 3, creator: { id: 42 } });
    api.getPlaylistTracksPage.mockResolvedValue({ items: [a, b, c], totalNumberOfItems: 3 });
    store = signedIn(42);
    pending = [];
    mockInvoke({
      remove_track_from_playlist: () => {
        const d = deferred<void>();
        pending.push(d);
        return d.promise;
      },
      get_playlist_folders: () => ({ items: [], totalNumberOfItems: 0, cursor: null }),
    });
  });

  it("two quick removals remove the right tracks, in order", async () => {
    const { nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store });
    await screen.findByText("T2");
    const removeEntry = (title: string) => {
      fireEvent.click(rowMore(title));
      return vi.mocked(nav.trackMenu).mock.lastCall![1]![0];
    };
    const [rb, rc] = [removeEntry("T2"), removeEntry("T3")];
    act(() => {
      void rb.onSelect!();
      void rc.onSelect!();
    });
    expect(screen.queryByText("T2")).toBeNull();
    expect(screen.queryByText("T3")).toBeNull();
    expect(screen.getByText(/\b1 Track\b/)).toBeTruthy();
    await act(async () => {});
    expect(removeCalls()).toEqual([{ playlistId: "p", index: 1 }]);
    await act(async () => pending[0].resolve());
    expect(removeCalls()).toEqual([
      { playlistId: "p", index: 1 },
      { playlistId: "p", index: 1 },
    ]);
  });

  it("a failed removal drops the queued ones and reloads the list from the server", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store });
      await screen.findByText("T2");
      const removeEntry = (title: string) => {
        fireEvent.click(rowMore(title));
        return vi.mocked(nav.trackMenu).mock.lastCall![1]![0];
      };
      const [rb, rc] = [removeEntry("T2"), removeEntry("T3")];
      act(() => {
        void rb.onSelect!();
        void rc.onSelect!();
      });
      await act(async () => {});
      // The server's list after the failed request (it did go through).
      api.getPlaylistDetails.mockResolvedValue({ uuid: "p", title: "P", numberOfTracks: 2, creator: { id: 42 } });
      api.getPlaylistTracksPage.mockResolvedValue({ items: [a, c], totalNumberOfItems: 2 });
      await act(async () => pending[0].reject(new Error("x")));
      await screen.findByText("T3");
      expect(screen.queryByText("T2")).toBeNull();
      expect(screen.getByText(/\b2 Tracks\b/)).toBeTruthy();
      expect(api.getPlaylistTracksPage).toHaveBeenCalledTimes(2);
      await screen.findByText("Failed to remove track");
      await act(async () => {});
      expect(removeCalls()).toEqual([{ playlistId: "p", index: 1 }]);
    } finally {
      quiet.mockRestore();
    }
  });

  it("no re-sort while a removal is in flight", async () => {
    const { nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store });
    await screen.findByText("T2");
    fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
    const sortMenu = vi.mocked(nav.openMenu).mock.lastCall![0];
    fireEvent.click(rowMore("T2"));
    act(() => {
      void vi.mocked(nav.trackMenu).mock.lastCall![1]![0].onSelect!();
    });
    await act(async () => {
      await sortMenu.items.find((i) => i.label === "Title")!.onSelect!();
    });
    expect(store.get(trackSortPrefsAtom)).toEqual({});
    expect(screen.getAllByText("Wait for removals to finish")).toHaveLength(1);
    const sortMenus = () => vi.mocked(nav.openMenu).mock.calls.filter(([m]) => m.title === "Sort by").length;
    fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
    expect(sortMenus()).toBe(1);
    expect(screen.getAllByText("Wait for removals to finish")).toHaveLength(2);
    await act(async () => {});
    expect(api.getPlaylistTracksPage).toHaveBeenCalledTimes(1);
    await act(async () => pending[0].resolve());
    fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
    expect(sortMenus()).toBe(2);
  });

  describe("never sends a position read from an outdated list", () => {
    const d = mkTrack(4);
    const view = { type: "playlist", uuid: "p" } as const;
    // Two pages of the same playlist, as when "Playing from" opened it again.
    function TwoCopies({ firstActive }: { firstActive: boolean }) {
      return (
        <>
          <TvScreenContext.Provider value={{ active: firstActive, element: () => null }}>
            <div data-testid="copy1">
              <TvTrackListScreen view={view} />
            </div>
          </TvScreenContext.Provider>
          <TvScreenContext.Provider value={{ active: !firstActive, element: () => null }}>
            <div data-testid="copy2">
              <TvTrackListScreen view={view} />
            </div>
          </TvScreenContext.Provider>
        </>
      );
    }
    const removeIn = (nav: TvNav, copy: string, title: string) => {
      fireEvent.click(within(within(screen.getByTestId(copy)).getByText(title).closest(".tv-track-row") as HTMLElement)
        .getByRole("button", { name: "More options" }));
      return vi.mocked(nav.trackMenu).mock.lastCall![1]![0];
    };
    const serverHas = (tracks: Track[]) => {
      api.getPlaylistDetails.mockResolvedValue({ uuid: "p", title: "P", numberOfTracks: tracks.length, creator: { id: 42 } });
      api.getPlaylistTracksPage.mockResolvedValue({ items: tracks, totalNumberOfItems: tracks.length });
    };
    const loads = () => api.getPlaylistTracksPage.mock.calls.length;

    beforeEach(() => serverHas([a, b, c, d]));

    it("a removal on one copy makes the other reload instead of removing (two copies via Playing from)", async () => {
      const { nav, rerender } = renderTv(<TwoCopies firstActive={false} />, { store });
      await waitFor(() => expect(within(screen.getByTestId("copy1")).getByText("T3")).toBeTruthy());
      await waitFor(() => expect(within(screen.getByTestId("copy2")).getByText("T3")).toBeTruthy());
      const staleRemoveC = removeIn(nav, "copy1", "T3");
      act(() => void removeIn(nav, "copy2", "T2").onSelect!());
      await act(async () => {});
      serverHas([a, c, d]);
      await act(async () => pending[0].resolve());
      expect(removeCalls()).toEqual([{ playlistId: "p", index: 1 }]);
      const before = loads();
      // Copy 1 still lists T2, so T3 is at 2 there: on the server that is T4.
      await act(async () => void staleRemoveC.onSelect!());
      expect(removeCalls()).toEqual([{ playlistId: "p", index: 1 }]);
      expect(screen.getByText("This playlist changed — reloading")).toBeTruthy();
      await waitFor(() => expect(within(screen.getByTestId("copy1")).queryByText("T2")).toBeNull());
      expect(loads()).toBe(before + 1);
      // Now in step with the server, it removes the right track.
      act(() => void removeIn(nav, "copy1", "T3").onSelect!());
      await act(async () => {});
      expect(removeCalls()).toEqual([
        { playlistId: "p", index: 1 },
        { playlistId: "p", index: 1 },
      ]);
      rerender(<TwoCopies firstActive={false} />);
    });

    it("a copy that comes back on top after the other changed the list reloads", async () => {
      const { nav, rerender } = renderTv(<TwoCopies firstActive={false} />, { store });
      await waitFor(() => expect(within(screen.getByTestId("copy1")).getByText("T3")).toBeTruthy());
      await waitFor(() => expect(within(screen.getByTestId("copy2")).getByText("T3")).toBeTruthy());
      act(() => void removeIn(nav, "copy2", "T2").onSelect!());
      await act(async () => {});
      serverHas([a, c, d]);
      await act(async () => pending[0].resolve());
      const before = loads();
      rerender(<TwoCopies firstActive />);
      expect(screen.getByText("This playlist changed — reloading")).toBeTruthy();
      await waitFor(() => expect(within(screen.getByTestId("copy1")).queryByText("T2")).toBeNull());
      expect(loads()).toBe(before + 1);
    });

    it("reopening a playlist left with removals queued waits for them before loading", async () => {
      const { nav, unmount } = renderTv(<TvTrackListScreen view={view} />, { store });
      await screen.findByText("T2");
      const [rb, rc] = [rowMore("T2"), rowMore("T3")].map((m) => {
        fireEvent.click(m);
        return vi.mocked(nav.trackMenu).mock.lastCall![1]![0];
      });
      act(() => {
        void rb.onSelect!();
        void rc.onSelect!();
      });
      await act(async () => {});
      unmount();
      serverHas([a, d]);
      renderTv(<TvTrackListScreen view={view} />, { store, nav });
      await act(async () => {});
      expect(loads()).toBe(1);
      expect(document.querySelector(".animate-spin")).toBeTruthy();
      await act(async () => pending[0].resolve());
      expect(loads()).toBe(1);
      await act(async () => pending[1].resolve());
      await screen.findByText("T4");
      expect(loads()).toBe(2);
      expect(screen.queryByText("T3")).toBeNull();
      fireEvent.click(rowMore("T4"));
      act(() => void vi.mocked(nav.trackMenu).mock.lastCall![1]![0].onSelect!());
      await act(async () => {});
      expect(removeCalls()).toEqual([
        { playlistId: "p", index: 1 },
        { playlistId: "p", index: 1 },
        { playlistId: "p", index: 1 },
      ]);
    });

    it("no copy re-sorts or reloads while another copy's removal is in flight", async () => {
      const { nav } = renderTv(<TwoCopies firstActive={false} />, { store });
      await waitFor(() => expect(within(screen.getByTestId("copy1")).getByText("T3")).toBeTruthy());
      await waitFor(() => expect(within(screen.getByTestId("copy2")).getByText("T3")).toBeTruthy());
      const sortButton = within(screen.getByTestId("copy2")).getByRole("button", { name: /Sort/ });
      fireEvent.click(sortButton);
      const sortMenu = vi.mocked(nav.openMenu).mock.lastCall![0];
      act(() => void removeIn(nav, "copy1", "T2").onSelect!());
      await act(async () => {});
      await act(async () => {
        await sortMenu.items.find((i) => i.label === "Title")!.onSelect!();
      });
      expect(store.get(trackSortPrefsAtom)).toEqual({});
      fireEvent.click(sortButton);
      expect(vi.mocked(nav.openMenu).mock.calls.filter(([m]) => m.title === "Sort by")).toHaveLength(1);
      expect(screen.getAllByText("Wait for removals to finish")).toHaveLength(2);
      // A sort change that does go through (from elsewhere) loads once the
      // removal has landed, not before.
      const before = loads();
      act(() => store.set(trackSortPrefsAtom, { p: { order: "NAME", direction: "ASC" } }));
      act(() => store.set(trackSortPrefsAtom, {}));
      await act(async () => {});
      expect(loads()).toBe(before);
      serverHas([a, c, d]);
      await act(async () => pending[0].resolve());
      await waitFor(() => expect(within(screen.getByTestId("copy2")).queryByText("T2")).toBeNull());
      act(() => void removeIn(nav, "copy2", "T4").onSelect!());
      await act(async () => {});
      expect(removeCalls()).toEqual([
        { playlistId: "p", index: 1 },
        { playlistId: "p", index: 2 },
      ]);
    });
  });

  it("no further page loads while a removal is in flight", async () => {
    const tracks = range(30).map((i) => mkTrack(i + 1));
    api.getPlaylistTracksPage.mockResolvedValue({ items: tracks, totalNumberOfItems: 250 });
    const { nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store });
    await screen.findByText("T25");
    fireEvent.click(rowMore("T2"));
    act(() => {
      void vi.mocked(nav.trackMenu).mock.lastCall![1]![0].onSelect!();
    });
    act(() => rowButton("T25").focus());
    expect(api.getPlaylistTracksPage).toHaveBeenCalledTimes(1);
    await act(async () => {});
    await act(async () => pending[0].resolve());
    act(() => rowButton("T26").focus());
    await waitFor(() => expect(api.getPlaylistTracksPage).toHaveBeenCalledTimes(2));
  });
});

describe("sorting", () => {
  beforeEach(() => {
    api.getPlaylistDetails.mockResolvedValue({ uuid: "p", title: "P", numberOfTracks: 2, creator: { id: 42 } });
    api.getPlaylistTracksPage.mockResolvedValue({ items: [t1, t2], totalNumberOfItems: 2 });
    mockInvoke({ get_playlist_folders: () => ({ items: [], totalNumberOfItems: 0, cursor: null }) });
  });

  it("sorting a playlist refetches in that order and hides Remove", async () => {
    const { nav, store } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store: signedIn(42) });
    await screen.findByText("T1");
    fireEvent.click(rowMore("T1"));
    expect(vi.mocked(nav.trackMenu).mock.lastCall![1]!.map((i) => i.label)).toEqual(["Remove from this playlist"]);
    fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
    const spec = vi.mocked(nav.openMenu).mock.lastCall![0];
    expect(spec.items.map((i) => i.label)).toContain("Date added");
    await act(async () => {
      await spec.items.find((i) => i.label === "Title")!.onSelect!();
    });
    await waitFor(() => expect(api.getPlaylistTracksPage).toHaveBeenLastCalledWith("p", 0, 100, "NAME", "ASC"));
    expect(store.get(trackSortPrefsAtom).p).toEqual({ order: "NAME", direction: "ASC" });
    fireEvent.click(rowMore("T1"));
    expect(vi.mocked(nav.trackMenu).mock.lastCall![1] ?? []).toEqual([]);
    expect(screen.getByRole("button", { name: /Sort/ }).textContent).toContain("Title");
  });

  it("a saved sort is used for the first fetch", async () => {
    const store = signedIn(42);
    store.set(trackSortPrefsAtom, { p: { order: "ARTIST", direction: "DESC" } });
    renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store });
    await screen.findByText("T1");
    expect(api.getPlaylistTracksPage).toHaveBeenCalledTimes(1);
    expect(api.getPlaylistTracksPage).toHaveBeenLastCalledWith("p", 0, 100, "ARTIST", "DESC");
  });

  it("back to playlist order offers Remove again", async () => {
    const store = signedIn(42);
    store.set(trackSortPrefsAtom, { p: { order: "ARTIST", direction: "DESC" } });
    const { nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store });
    await screen.findByText("T1");
    fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
    const spec = vi.mocked(nav.openMenu).mock.lastCall![0];
    await act(async () => {
      await spec.items.find((i) => i.label === "Playlist order")!.onSelect!();
    });
    await waitFor(() => expect(api.getPlaylistTracksPage).toHaveBeenCalledTimes(2));
    expect(store.get(trackSortPrefsAtom)).toEqual({});
    await waitFor(() => {
      fireEvent.click(rowMore("T1"));
      expect(vi.mocked(nav.trackMenu).mock.lastCall![1]!.map((i) => i.label)).toEqual(["Remove from this playlist"]);
    });
  });

  it("Remove stays hidden until the list is back in playlist order", async () => {
    const store = signedIn(42);
    store.set(trackSortPrefsAtom, { p: { order: "ARTIST", direction: "DESC" } });
    const { nav } = renderTv(<TvTrackListScreen view={{ type: "playlist", uuid: "p" }} />, { store });
    await screen.findByText("T1");
    const d = deferred<{ items: Track[]; totalNumberOfItems: number }>();
    api.getPlaylistTracksPage.mockReturnValueOnce(d.promise);
    fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
    await act(async () => {
      await vi.mocked(nav.openMenu).mock.lastCall![0].items.find((i) => i.label === "Playlist order")!.onSelect!();
    });
    await waitFor(() => expect(api.getPlaylistTracksPage).toHaveBeenCalledTimes(2));
    fireEvent.click(rowMore("T1"));
    expect(vi.mocked(nav.trackMenu).mock.lastCall![1] ?? []).toEqual([]);
    await act(async () => d.resolve({ items: [t1, t2], totalNumberOfItems: 2 }));
    fireEvent.click(rowMore("T1"));
    expect(vi.mocked(nav.trackMenu).mock.lastCall![1]!.map((i) => i.label)).toEqual(["Remove from this playlist"]);
  });

  it("My Tracks uses its saved sort for the first page and the pager, and newest first stores no key", async () => {
    api.getFavoriteTracks.mockResolvedValue({ items: [t1, t2], totalNumberOfItems: 250 });
    const store = signedIn(42);
    store.set(favoriteTrackIdsAtom, new Set([1, 2]));
    store.set(trackSortPrefsAtom, { __favorites__: { order: "DATE", direction: "ASC" } });
    const { nav } = renderTv(<TvTrackListScreen view={{ type: "favorites" }} />, { store });
    await screen.findByText("T2");
    expect(api.getFavoriteTracks).toHaveBeenCalledTimes(1);
    expect(api.getFavoriteTracks).toHaveBeenLastCalledWith(42, 0, 100, "DATE", "ASC");
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await vi.mocked(nav.playSource).mock.lastCall![0].fetchPage!(2);
    expect(api.getFavoriteTracks).toHaveBeenLastCalledWith(42, 2, 100, "DATE", "ASC");
    fireEvent.click(screen.getByRole("button", { name: /Sort/ }));
    const spec = vi.mocked(nav.openMenu).mock.lastCall![0];
    expect(spec.items.map((i) => i.label)).not.toContain("Playlist order");
    await act(async () => {
      await spec.items.find((i) => i.label === "Date added")!.onSelect!();
    });
    expect(store.get(trackSortPrefsAtom)).toEqual({});
    await waitFor(() => expect(api.getFavoriteTracks).toHaveBeenLastCalledWith(42, 0, 100, "DATE", "DESC"));
  });
});

describe("filtering My Tracks", () => {
  it("filters My Tracks after loading every page", async () => {
    api.getFavoriteTracks
      .mockResolvedValueOnce({ items: [mkTrack(1, { title: "Blue" }), mkTrack(2)], totalNumberOfItems: 3 })
      .mockResolvedValueOnce({
        items: [mkTrack(3, { album: { id: 9, title: "Kind of Blue", cover: "c" } })],
        totalNumberOfItems: 3,
      });
    const store = signedIn(42);
    store.set(favoriteTrackIdsAtom, new Set([1, 2, 3]));
    const nav = makeTvNav({ prompt: vi.fn(async () => "blue") });
    renderTv(<TvTrackListScreen view={{ type: "favorites" }} />, { store, nav });
    await screen.findByText("T2");
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    await screen.findByText(/Filter: “blue”/);
    expect(vi.mocked(nav.prompt).mock.lastCall![0]).toEqual({
      title: "Filter My Tracks",
      initial: "",
      confirm: "Filter",
      allowEmpty: true,
      placeholder: "Title, artist or album",
    });
    await screen.findByText("T3");
    expect(api.getFavoriteTracks).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Blue")).toBeTruthy();
    expect(screen.queryByText("T2")).toBeNull();
    expect(rowButton("T3").textContent).toMatch(/^3/);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("T2")).toBeTruthy();
    expect(screen.queryByText(/Filter: “/)).toBeNull();
  });

  it("a page that adds no visible rows leaves a Load more button", async () => {
    api.getFavoriteTracks
      .mockResolvedValueOnce({ items: [mkTrack(1)], totalNumberOfItems: 3 })
      .mockResolvedValueOnce({ items: [mkTrack(2)], totalNumberOfItems: 3 })
      .mockResolvedValueOnce({ items: [mkTrack(3)], totalNumberOfItems: 3 });
    const store = signedIn(42);
    store.set(favoriteTrackIdsAtom, new Set([1, 3]));
    renderTv(<TvTrackListScreen view={{ type: "favorites" }} />, { store });
    await screen.findByText("T1");
    act(() => rowButton("T1").focus());
    await waitFor(() => expect(api.getFavoriteTracks).toHaveBeenCalledTimes(2));
    const more = await screen.findByRole("button", { name: "Load more" });
    act(() => more.focus());
    fireEvent.click(more);
    await screen.findByText("T3");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(rowButton("T3")));
  });

  it("an empty first page with more to come offers Load more, not the empty text", async () => {
    api.getFavoriteTracks
      .mockResolvedValueOnce({ items: [mkTrack(1)], totalNumberOfItems: 2 })
      .mockResolvedValueOnce({ items: [mkTrack(2)], totalNumberOfItems: 2 });
    const store = signedIn(42);
    store.set(favoriteTrackIdsAtom, new Set([2]));
    renderTv(<TvTrackListScreen view={{ type: "favorites" }} />, { store });
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(screen.queryByText("No tracks here yet.")).toBeNull();
    await screen.findByText("T2");
    act(() => store.set(favoriteTrackIdsAtom, new Set()));
    expect(screen.getByText("No tracks here yet.")).toBeTruthy();
  });
});
