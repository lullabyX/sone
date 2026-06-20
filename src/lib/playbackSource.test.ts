import { describe, it, expect } from "vitest";
import { isNavigableSource, NAVIGABLE_SOURCE_TYPES } from "./playbackSource";

describe("isNavigableSource", () => {
  it("returns true for every navigable source type", () => {
    for (const type of [
      "album",
      "playlist",
      "playlist-recs",
      "mix",
      "artist",
      "artist-tracks",
      "favorites",
      "radio",
    ]) {
      expect(isNavigableSource(type)).toBe(true);
    }
  });

  it("returns false for unknown, empty, or missing types", () => {
    expect(isNavigableSource("something-else")).toBe(false);
    expect(isNavigableSource("")).toBe(false);
    expect(isNavigableSource(undefined)).toBe(false);
  });

  it("exposes exactly the eight navigable types", () => {
    expect([...NAVIGABLE_SOURCE_TYPES].sort()).toEqual(
      [
        "album",
        "artist",
        "artist-tracks",
        "favorites",
        "mix",
        "playlist",
        "playlist-recs",
        "radio",
      ].sort(),
    );
  });
});
