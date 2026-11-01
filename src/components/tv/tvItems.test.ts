import { describe, expect, it } from "vitest";
import {
  entryState,
  feedEntries,
  groupByVolume,
  libraryEntries,
  sectionEntries,
  topHitEntries,
  viewForSource,
} from "./tvItems";
import { mkTrack } from "./tvTestUtils";
import type { DirectHitItem, PlaylistOrFolder } from "../../types";

const track = (id: number) => ({
  id,
  title: `Track ${id}`,
  duration: 200,
  artist: { id: 1, name: "Artist" },
  album: { id: 9, title: "Album", cover: "c0ffee" },
});

describe("sectionEntries", () => {
  it("maps tracks to play actions and collects them for the queue", () => {
    const { entries, tracks } = sectionEntries(
      [track(1), track(2)],
      "TRACK_LIST",
    );
    expect(entries.map((e) => e.action.kind)).toEqual([
      "playTrack",
      "playTrack",
    ]);
    expect(tracks.map((t) => t.id)).toEqual([1, 2]);
  });

  it("opens albums, playlists, mixes and artists", () => {
    const { entries } = sectionEntries([
      { id: 5, title: "An Album", cover: "abc", artist: { name: "X" } },
      { uuid: "pl-1", title: "A Playlist", squareImage: "def" },
      { id: "mix-1", title: "A Mix", mixType: "DISCOVERY_MIX" },
      { id: 7, name: "An Artist", picture: "ghi" },
    ]);
    expect(entries.map((e) => e.action)).toMatchObject([
      { kind: "open", view: { type: "album", id: 5 } },
      { kind: "open", view: { type: "playlist", uuid: "pl-1" } },
      { kind: "open", view: { type: "mix", mixId: "mix-1" } },
      { kind: "open", view: { type: "artist", id: 7 } },
    ]);
    expect(entries[3].round).toBe(true);
  });

  it("routes featured promotions by artifact type", () => {
    const { entries } = sectionEntries(
      [
        { artifactId: "pl-9", type: "PLAYLIST", shortHeader: "Promo" },
        { artifactId: "42", type: "ALBUM", shortHeader: "Promo album" },
      ],
      "MULTIPLE_TOP_PROMOTIONS",
    );
    expect(entries.map((e) => e.action)).toMatchObject([
      { kind: "open", view: { type: "playlist", uuid: "pl-9" } },
      { kind: "open", view: { type: "album", id: 42 } },
    ]);
  });

  it("routes magazine cards to albums, artists and videos", () => {
    const { entries } = sectionEntries(
      [
        {
          _itemType: "MAGAZINE",
          type: "ALBUM",
          artifactId: "42",
          shortHeader: "Album story",
          imageURL: "https://img/a.jpg",
        },
        {
          _itemType: "MAGAZINE",
          type: "ARTIST",
          artifactId: "7",
          shortHeader: "Artist story",
        },
        {
          _itemType: "MAGAZINE",
          type: "VIDEO",
          artifactId: "5",
          shortHeader: "Clip",
        },
        {
          type: "MAGAZINE",
          data: { type: "PLAYLIST", artifactId: "p", shortHeader: "H" },
        },
      ],
      "HORIZONTAL_LIST",
    );
    expect(entries.map((e) => e.action)).toMatchObject([
      { kind: "open", view: { type: "album", id: 42 } },
      { kind: "open", view: { type: "artist", id: 7 } },
      { kind: "playVideo" },
      { kind: "open", view: { type: "playlist", uuid: "p", title: "H" } },
    ]);
    expect(entries[0].image).toBe("https://img/a.jpg");
  });

  it("turns an external-link promo into a link panel action", () => {
    expect(
      sectionEntries(
        [
          {
            _itemType: "MAGAZINE",
            type: "EXTURL",
            artifactId: "https://x.io/a",
            shortHeader: "Read",
          },
        ],
        "HORIZONTAL_LIST",
      ).entries[0].action,
    ).toEqual({ kind: "showLink", url: "https://x.io/a", title: "Read" });
  });

  it("drops duplicates and items with nowhere to go", () => {
    const { entries } = sectionEntries(
      [track(1), track(1), null, {}],
      "TRACK_LIST",
    );
    expect(entries).toHaveLength(1);
  });

  it("sends the My Tracks shortcut to the favorites screen", () => {
    const { entries } = sectionEntries([
      { id: "tidal://my-collection/tracks", title: "My Tracks" },
    ]);
    expect(entries[0].action).toEqual({
      kind: "open",
      view: { type: "favorites" },
    });
  });

  it("turns Explore links into page views", () => {
    const { entries } = sectionEntries(
      [{ title: "Jazz", apiPath: "pages/genre_jazz" }],
      "PAGE_LINKS_CLOUD",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].icon).toBe("link");
    expect(entries[0].action).toEqual({
      kind: "open",
      view: { type: "page", title: "Jazz", apiPath: "pages/genre_jazz" },
    });
  });
});

describe("feedEntries", () => {
  it("keeps albums and mixes and drops unknown kinds", () => {
    const entries = feedEntries([
      {
        kind: "album",
        activityType: "NEW_ALBUM",
        occurredAt: "2026-10-01T00:00:00Z",
        seen: false,
        item: {
          id: 7,
          title: "New",
          cover: "c",
          artists: [{ id: 1, name: "A" }],
        },
      },
      {
        kind: "unknown",
        activityType: "X",
        occurredAt: "2026-10-01T00:00:00Z",
        seen: true,
        item: { id: 8 },
      },
    ]);
    expect(entries.map((e) => e.action)).toEqual([
      expect.objectContaining({
        kind: "open",
        view: expect.objectContaining({ type: "album", id: 7 }),
      }),
    ]);
  });
});

describe("viewForSource", () => {
  it("opens recommendations as their playlist", () => {
    expect(
      viewForSource({
        type: "playlist-recs",
        id: "u1",
        name: "X: Recommended",
        tracks: [],
      }),
    ).toEqual({ type: "playlist", uuid: "u1" });
  });

  it("opens a track radio as its mix", () => {
    expect(
      viewForSource({ type: "radio", id: 77, name: "R", tracks: [] }),
    ).toEqual({ type: "mix", mixId: "77", title: "R", mixType: "TRACK_MIX" });
  });

  it("opens a mix with its mix type", () => {
    expect(
      viewForSource({ type: "mix", id: "m", name: "M", mixType: "ARTIST_MIX", tracks: [] }),
    ).toMatchObject({ type: "mix", mixId: "m", mixType: "ARTIST_MIX" });
  });

  it("opens an artist's top tracks as their own list", () => {
    expect(
      viewForSource({ type: "artist-tracks", id: 9, name: "X", tracks: [] }),
    ).toEqual({ type: "artistTracks", artistId: 9, name: "X" });
  });

  it("has nowhere to go for other sources", () => {
    expect(
      viewForSource({ type: "tv-row", id: "x", name: "Row", tracks: [] }),
    ).toBeNull();
  });
});

describe("entryState", () => {
  it("dims blocked or unavailable tracks and AI media like the desktop", () => {
    const off = { allowExplicit: false, allowAi: false };
    const t = sectionEntries([mkTrack(1, { explicit: true })], "TRACK_LIST").entries[0];
    expect(entryState(t, off)).toEqual({ dimmed: true, explicitBadge: true, aiBadge: false });
    const album = sectionEntries([{ id: 5, title: "A", cover: "c", ai: true, explicit: true }], "ALBUM_LIST").entries[0];
    expect(entryState(album, off)).toEqual({ dimmed: true, explicitBadge: false, aiBadge: true });
    expect(entryState(album, off, { showExplicit: true }).explicitBadge).toBe(true);
    expect(entryState(album, { allowExplicit: false, allowAi: true }).dimmed).toBe(false);
    const gone = sectionEntries([mkTrack(2, { streamReady: false })], "TRACK_LIST").entries[0];
    expect(entryState(gone, { allowExplicit: true, allowAi: true }).dimmed).toBe(true);
  });
});

describe("groupByVolume", () => {
  it("groups by disc in first-appearance order; no disc number is disc 1", () => {
    const v = (id: number, vol?: number) => mkTrack(id, { volumeNumber: vol });
    expect(
      [...groupByVolume([v(1, 1), v(2, 1), v(3, 2)]).entries()].map(([k, ts]) => [k, ts.map((t) => t.id)]),
    ).toEqual([[1, [1, 2]], [2, [3]]]);
    expect([...groupByVolume([v(1)]).keys()]).toEqual([1]);
  });
});

describe("libraryEntries", () => {
  const folder = (id: string, name: string, count?: number): PlaylistOrFolder => ({
    kind: "folder",
    data: { id, name, parent: null, addedAt: "", lastModifiedAt: "", totalNumberOfItems: count },
  });
  const playlist = (uuid: string, title: string): PlaylistOrFolder => ({
    kind: "playlist",
    data: { uuid, title, image: "img", creator: { id: 5, name: "Someone" } },
  });

  it("names, counts and routes folders", () => {
    const entries = libraryEntries(
      [folder("f1", "Road", 3), folder("f2", "Gym"), playlist("p1", "Mine"), playlist("p1", "Mine")],
      new Map([["f1", "Road trips"]]),
      new Map([["f1", 1], ["f2", -2]]),
    );
    expect(entries.map((e) => [e.key, e.title, e.subtitle])).toEqual([
      ["folder:f1", "Road trips", "4 playlists"],
      ["folder:f2", "Gym", "0 playlists"],
      ["playlist:p1", "Mine", "By Someone"],
    ]);
    expect(entries[0]).toMatchObject({
      image: "",
      icon: "folder",
      action: {
        kind: "open",
        view: { type: "list", title: "Road trips", source: { kind: "collection", what: "playlists", folderId: "f1" } },
      },
    });
    expect(entries[2].action).toMatchObject({ kind: "open", view: { type: "playlist", uuid: "p1" } });
  });
});

describe("topHitEntries", () => {
  it("top hits route by kind", () => {
    const [t, a] = topHitEntries([{ hitType: "TRACKS", id: 1, title: "Song", track: mkTrack(1) }, { hitType: "ALBUMS", id: 4, title: "LP" }] as DirectHitItem[]);
    expect(t.action).toEqual({ kind: "playTrack", track: mkTrack(1) });
    expect(a.action).toMatchObject({ kind: "open", view: { type: "album", id: 4 } });
  });
});
