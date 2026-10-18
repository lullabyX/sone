import { describe, expect, it } from "vitest";
import { feedEntries, sectionEntries } from "./tvItems";

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
