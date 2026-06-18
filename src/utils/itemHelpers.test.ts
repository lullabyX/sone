import { describe, it, expect } from "vitest";
import {
  getTrackPrimaryArtist,
  getAudioQualityBadge,
  getMediaQualityBadge,
  formatTotalDuration,
} from "./itemHelpers";

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
      getTrackPrimaryArtist({
        artists: [{ name: "First" }, { name: "Second" }],
      }),
    ).toBe("First");
  });

  it("falls back to the singular artist when artists[] is empty", () => {
    expect(
      getTrackPrimaryArtist({ artist: { name: "Solo" }, artists: [] }),
    ).toBe("Solo");
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

describe("formatTotalDuration", () => {
  it("formats durations under an hour as m:ss", () => {
    expect(formatTotalDuration(0)).toBe("0:00");
    expect(formatTotalDuration(59)).toBe("0:59");
    expect(formatTotalDuration(75)).toBe("1:15");
    expect(formatTotalDuration(2560)).toBe("42:40");
  });

  it("formats durations of an hour or more as h:mm:ss", () => {
    expect(formatTotalDuration(3600)).toBe("1:00:00");
    expect(formatTotalDuration(5073)).toBe("1:24:33");
  });
});

describe("getMediaQualityBadge", () => {
  it("prefers a HIRES_LOSSLESS tag over a LOSSLESS audioQuality", () => {
    expect(
      getMediaQualityBadge(
        { tags: ["LOSSLESS", "HIRES_LOSSLESS"] },
        "LOSSLESS",
      ),
    ).toEqual({ label: "HI-RES LOSSLESS", tier: "max" });
  });

  it("returns hifi for a LOSSLESS-only tag list", () => {
    expect(getMediaQualityBadge({ tags: ["LOSSLESS"] }, "LOSSLESS")).toEqual({
      label: "LOSSLESS",
      tier: "hifi",
    });
  });

  it("ignores non-quality tags like DOLBY_ATMOS", () => {
    expect(
      getMediaQualityBadge({ tags: ["LOSSLESS", "DOLBY_ATMOS"] }, "LOSSLESS"),
    ).toEqual({ label: "LOSSLESS", tier: "hifi" });
  });

  it("falls back to audioQuality when no recognized tags", () => {
    expect(getMediaQualityBadge(undefined, "HI_RES_LOSSLESS")).toEqual({
      label: "HI-RES LOSSLESS",
      tier: "max",
    });
    expect(getMediaQualityBadge({ tags: [] }, "HIGH")).toEqual({
      label: "HIGH",
      tier: "high",
    });
  });

  it("returns null when nothing is available", () => {
    expect(getMediaQualityBadge(undefined, undefined)).toBeNull();
  });
});
