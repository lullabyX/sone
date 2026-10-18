import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/tidal", () => ({
  getArtistTopTracksAll: vi.fn(),
  getPlaylistTracksPage: vi.fn(),
  getFavoriteTracks: vi.fn(),
  getFavoriteVideos: vi.fn(),
  getAlbumPage: vi.fn(),
  getMixItems: vi.fn(),
}));

import * as api from "../api/tidal";
import {
  artistTopTracksPager,
  playlistTracksPager,
  favoriteTracksPager,
  favoriteVideosPager,
  playableFromMedia,
  ARTIST_TRACKS_PAGE_SIZE,
  PLAYLIST_PAGE_SIZE,
  FAVORITE_TRACKS_PAGE_SIZE,
  FAVORITE_VIDEOS_PAGE_SIZE,
} from "./trackSources";
import type { PlayableSource, TrackPage } from "./trackSources";
import type { Track } from "../types";

const t = (id: number) => ({ id, title: `T${id}` }) as unknown as Track;

beforeEach(() => vi.clearAllMocks());

describe("pagers", () => {
  it("artist pager requests fixed-size pages and passes hasMore through", async () => {
    vi.mocked(api.getArtistTopTracksAll).mockResolvedValue({
      items: [t(1)],
      hasMore: true,
    });
    const page: TrackPage = await artistTopTracksPager(7)(50);
    expect(api.getArtistTopTracksAll).toHaveBeenCalledWith(
      7,
      50,
      ARTIST_TRACKS_PAGE_SIZE,
    );
    expect(page).toEqual({ items: [t(1)], hasMore: true });
  });

  it("playlist pager forwards sort and derives hasMore from the total", async () => {
    vi.mocked(api.getPlaylistTracksPage).mockResolvedValue({
      items: [t(1), t(2)],
      totalNumberOfItems: 102,
    } as never);
    const page = await playlistTracksPager("p", "TITLE", "ASC")(100);
    expect(api.getPlaylistTracksPage).toHaveBeenCalledWith(
      "p",
      100,
      PLAYLIST_PAGE_SIZE,
      "TITLE",
      "ASC",
    );
    expect(page.hasMore).toBe(false);
  });

  it("favorites pager derives hasMore from the total", async () => {
    vi.mocked(api.getFavoriteTracks).mockResolvedValue({
      items: [t(1)],
      totalNumberOfItems: 5,
    } as never);
    const page = await favoriteTracksPager(3, "DATE", "DESC")(0);
    expect(api.getFavoriteTracks).toHaveBeenCalledWith(
      3,
      0,
      FAVORITE_TRACKS_PAGE_SIZE,
      "DATE",
      "DESC",
    );
    expect(page.hasMore).toBe(true);
  });

  it("video pager maps videos to tracks; a short page ends it", async () => {
    vi.mocked(api.getFavoriteVideos).mockResolvedValue([
      { id: 9, title: "V" } as never,
    ]);
    const page = await favoriteVideosPager(3)(0);
    expect(api.getFavoriteVideos).toHaveBeenCalledWith(
      3,
      0,
      FAVORITE_VIDEOS_PAGE_SIZE,
    );
    expect(page.items[0].id).toBe(9);
    expect(page.hasMore).toBe(false);
  });
});

describe("playableFromMedia", () => {
  it("album is complete and album-mode", async () => {
    vi.mocked(api.getAlbumPage).mockResolvedValue({
      page: { tracks: [t(1), t(2)] },
    } as never);
    const src: PlayableSource | null = await playableFromMedia({
      type: "album",
      id: 5,
      title: "A",
      cover: "c",
    } as never);
    expect(src?.meta).toMatchObject({
      type: "album",
      id: 5,
      name: "A",
      image: "c",
    });
    expect(src?.loaded).toHaveLength(2);
    expect(src?.fetchPage).toBeUndefined();
    expect(src?.albumMode).toBe(true);
  });

  it("playlist pages without dedupe; artist pages with dedupe and no image", async () => {
    const pl = await playableFromMedia({
      type: "playlist",
      uuid: "u",
      title: "P",
    } as never);
    expect(pl?.meta).toMatchObject({ type: "playlist", id: "u", name: "P" });
    expect(pl?.loaded).toEqual([]);
    expect(pl?.fetchPage).toBeTypeOf("function");
    expect(pl?.dedupe).toBeFalsy();

    const ar = await playableFromMedia({
      type: "artist",
      id: 7,
      name: "X",
      picture: "pic",
    } as never);
    expect(ar?.meta).toEqual({ type: "artist", id: 7, name: "X" });
    expect(ar?.fetchPage).toBeTypeOf("function");
    expect(ar?.dedupe).toBe(true);
  });

  it("mix is complete", async () => {
    vi.mocked(api.getMixItems).mockResolvedValue({
      tracks: [t(1)],
      mixType: "DISCOVERY_MIX",
    } as never);
    const src = await playableFromMedia({
      type: "mix",
      mixId: "m",
      title: "M",
    } as never);
    expect(src?.meta).toMatchObject({ type: "mix", id: "m", name: "M" });
    expect(src?.loaded).toHaveLength(1);
    expect(src?.fetchPage).toBeUndefined();
  });

  it("video returns null (callers play videos directly)", async () => {
    expect(
      await playableFromMedia({ type: "video", id: 1 } as never),
    ).toBeNull();
  });
});
