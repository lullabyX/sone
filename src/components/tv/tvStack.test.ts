import { describe, expect, it } from "vitest";
import type { TvView } from "./tvItems";
import { tvBackStep, tvPush, tvStackIndexOf, type TvStackEntry } from "./tvStack";
import { setupTvTest } from "./tvTestUtils";

setupTvTest();

const e = (id: number, type: TvView["type"], returnTo?: "nowPlaying"): TvStackEntry =>
  returnTo ? { id, view: { type } as TvView, returnTo } : { id, view: { type } as TvView };
it("never puts Now Playing on the stack", () => {
  const s = [e(1, "home")];
  expect(tvPush(s, e(2, "nowPlaying"), false)).toBe(s);
  expect(tvPush(s, e(2, "nowPlaying"), true)).toBe(s);
});
it("marks a screen opened from Now Playing", () => {
  const s = [e(1, "home")];
  expect(tvPush(s, e(2, "artist"), true)).toEqual([e(1, "home"), e(2, "artist", "nowPlaying")]);
  expect(tvPush(s, e(2, "artist"), false)).toEqual([e(1, "home"), e(2, "artist")]);
  expect(s).toEqual([e(1, "home")]);
});
it("Back closes an open Now Playing before touching the stack", () => {
  expect(tvBackStep([e(1, "home"), e(2, "album")], true)).toEqual({ kind: "closeNowPlaying" });
});
it("Back from a screen opened from Now Playing reopens it", () => {
  expect(tvBackStep([e(1, "home"), e(2, "artist", "nowPlaying")], false))
    .toEqual({ kind: "pop", stack: [e(1, "home")], popped: e(2, "artist", "nowPlaying"), reopenNowPlaying: true });
  expect(tvBackStep([e(1, "home"), e(2, "album")], false)).toMatchObject({ kind: "pop", reopenNowPlaying: false });
  expect(tvBackStep([e(1, "home")], false)).toEqual({ kind: "root" });
});
it("playing again from a screen opened from Now Playing keeps one Now Playing and the stack (P6)", () => {
  const s = tvPush([e(1, "home")], e(2, "artist"), true);  // Now Playing → Artist
  expect(tvPush(s, e(3, "nowPlaying"), false)).toBe(s);    // play there: the layer opens, the stack is unchanged
  expect(tvBackStep(s, true)).toEqual({ kind: "closeNowPlaying" });
  expect(tvBackStep(s, false)).toMatchObject({ kind: "pop", reopenNowPlaying: true });
});

describe("a page already on the stack", () => {
  const pl = (id: number, uuid: string, returnTo?: "nowPlaying"): TvStackEntry => ({
    id,
    view: { type: "playlist", uuid },
    ...(returnTo ? { returnTo } : {}),
  });
  const album = (id: number, albumId: number): TvStackEntry => ({ id, view: { type: "album", id: albumId } });

  it("is gone back to instead of opened twice", () => {
    const s = [e(1, "home"), pl(2, "p"), album(3, 9)];
    expect(tvStackIndexOf(s, { type: "playlist", uuid: "p", title: "P" })).toBe(1);
    expect(tvPush(s, pl(4, "p"), false)).toEqual([e(1, "home"), pl(2, "p")]);
    expect(tvPush(s, pl(4, "p"), false)[1]).toBe(s[1]);
  });

  it("opened again from Now Playing is marked to reopen it, and Back does (Task 34)", () => {
    const s = [e(1, "home"), pl(2, "p"), album(3, 9)];
    const next = tvPush(s, pl(4, "p"), true);
    expect(next).toEqual([e(1, "home"), pl(2, "p", "nowPlaying")]);
    expect(tvBackStep(next, false)).toEqual({
      kind: "pop",
      stack: [e(1, "home")],
      popped: pl(2, "p", "nowPlaying"),
      reopenNowPlaying: true,
    });
  });

  it("on top stays as it is, unless opened from Now Playing", () => {
    const s = [e(1, "home"), pl(2, "p")];
    expect(tvPush(s, pl(3, "p"), false)).toBe(s);
    expect(tvPush(s, pl(3, "p"), true)).toEqual([e(1, "home"), pl(2, "p", "nowPlaying")]);
  });

  it("Back after going back to it keeps the history below it", () => {
    const s = [e(1, "home"), album(2, 9), pl(3, "p"), e(4, "artist")];
    const next = tvPush(s, album(5, 9), false);
    expect(next).toEqual([e(1, "home"), album(2, 9)]);
    expect(tvBackStep(next, false)).toMatchObject({ kind: "pop", stack: [e(1, "home")], reopenNowPlaying: false });
  });

  it("other playlists, albums and mixes still stack", () => {
    const s = [e(1, "home"), pl(2, "p")];
    expect(tvPush(s, pl(3, "q"), false)).toEqual([...s, pl(3, "q")]);
    expect(tvPush(s, album(3, 9), false)).toEqual([...s, album(3, 9)]);
    const search = { id: 3, view: { type: "searchResults", query: "x", what: "tracks", title: "T" } } as TvStackEntry;
    expect(tvPush([...s, search], { ...search, id: 4 }, false)).toHaveLength(4);
  });
});
