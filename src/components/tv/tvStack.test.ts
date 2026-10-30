import { expect, it } from "vitest";
import type { TvView } from "./tvItems";
import { tvBackStep, tvPush, type TvStackEntry } from "./tvStack";
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
