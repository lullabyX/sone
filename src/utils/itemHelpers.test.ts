import { describe, it, expect } from "vitest";
import { getTrackPrimaryArtist, getAudioQualityBadge } from "./itemHelpers";

describe("getTrackPrimaryArtist", () => {
  it("returns the first MAIN artist (runtime field is `type`)", () => {
    expect(
      getTrackPrimaryArtist({
        artists: [
          { name: "Main", type: "MAIN" },
          { name: "Featured", type: "FEATURED" },
        ],
      }),
    ).toBe("Main");
  });

  it("also accepts the `artistType` field name", () => {
    expect(
      getTrackPrimaryArtist({
        artists: [
          { name: "Feat", artistType: "FEATURED" },
          { name: "Main", artistType: "MAIN" },
        ],
      }),
    ).toBe("Main");
  });

  it("falls back to the first artist when no MAIN type exists", () => {
    expect(
      getTrackPrimaryArtist({ artists: [{ name: "First" }, { name: "Second" }] }),
    ).toBe("First");
  });

  it("falls back to the singular artist when artists[] is empty", () => {
    expect(getTrackPrimaryArtist({ artist: { name: "Solo" }, artists: [] })).toBe("Solo");
  });

  it("returns Unknown Artist when nothing is present", () => {
    expect(getTrackPrimaryArtist({})).toBe("Unknown Artist");
  });
});

describe("getAudioQualityBadge", () => {
  it("returns null when no quality is given", () => {
    expect(getAudioQualityBadge(undefined)).toBeNull();
    expect(getAudioQualityBadge("")).toBeNull();
  });

  it("maps hi-res lossless to the MAX tier with HI-RES LOSSLESS wording", () => {
    expect(getAudioQualityBadge("HI_RES_LOSSLESS")).toEqual({
      label: "HI-RES LOSSLESS",
      tier: "max",
    });
    expect(getAudioQualityBadge("HI_RES")).toEqual({
      label: "HI-RES LOSSLESS",
      tier: "max",
    });
  });

  it("maps lossless to the hifi tier", () => {
    expect(getAudioQualityBadge("LOSSLESS")).toEqual({
      label: "LOSSLESS",
      tier: "hifi",
    });
  });

  it("maps everything else to the high tier", () => {
    expect(getAudioQualityBadge("HIGH")).toEqual({
      label: "HIGH",
      tier: "high",
    });
    expect(getAudioQualityBadge("LOW")).toEqual({
      label: "HIGH",
      tier: "high",
    });
  });
});
