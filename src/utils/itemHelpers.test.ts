import { describe, it, expect } from "vitest";
import {
  getTrackPrimaryArtist,
  getAudioQualityBadge,
  getMediaQualityBadge,
  formatTotalDuration,
  getArtistImage,
  getItemImage,
  getItemTitle,
  getItemId,
  buildMediaItem,
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

describe("getArtistImage", () => {
  it("prefers artworkId and uses artist CDN sizes", () => {
    expect(
      getArtistImage({ artworkId: "aaaa-bbbb", picture: "cccc-dddd" }, 480),
    ).toBe("https://resources.tidal.com/images/aaaa/bbbb/480x480.jpg");
  });

  it("falls back to the legacy picture UUID", () => {
    expect(getArtistImage({ picture: "cccc-dddd" }, 320)).toBe(
      "https://resources.tidal.com/images/cccc/dddd/320x320.jpg",
    );
  });

  it("uses selectedAlbumCoverFallback with album CDN sizes when no artist artwork exists", () => {
    expect(
      getArtistImage(
        { picture: null, selectedAlbumCoverFallback: "eeee-ffff" },
        640,
      ),
    ).toBe("https://resources.tidal.com/images/eeee/ffff/640x640.jpg");
  });

  it("accepts the camelCased albumCoverFallback alias used by ArtistPageData", () => {
    expect(getArtistImage({ albumCoverFallback: "eeee-ffff" }, 320)).toBe(
      "https://resources.tidal.com/images/eeee/ffff/320x320.jpg",
    );
  });

  it("returns an empty string when the item has no image at all", () => {
    expect(getArtistImage({ id: 1, name: "Nobody" })).toBe("");
    expect(getArtistImage(null)).toBe("");
  });
});

describe("getItemImage artist fallback", () => {
  it("resolves an artist with no picture through the album fallback", () => {
    expect(
      getItemImage({
        id: 1,
        name: "CMA",
        picture: null,
        selectedAlbumCoverFallback: "eeee-ffff",
      }),
    ).toBe("https://resources.tidal.com/images/eeee/ffff/320x320.jpg");
  });

  it("still prefers an album cover for non-artist items", () => {
    expect(getItemImage({ cover: "1111-2222", picture: "3333-4444" })).toBe(
      "https://resources.tidal.com/images/1111/2222/320x320.jpg",
    );
  });
});

describe("deep-link items (v2 My Tracks shortcut)", () => {
  // The backend unwraps {type, data} and injects _itemType, so the runtime
  // item is flat. The wrapped shape still arrives from v1 payloads.
  const unwrapped = {
    _itemType: "DEEP_LINK",
    title: "My Tracks",
    id: "tidal://my-collection/tracks",
    url: "tidal://my-collection/tracks",
    externalUrl: false,
  };
  const wrapped = {
    type: "DEEP_LINK",
    data: {
      title: "My Tracks",
      id: "tidal://my-collection/tracks",
      url: "tidal://my-collection/tracks",
    },
  };

  it("reads the title from an unwrapped deep link", () => {
    expect(getItemTitle(unwrapped)).toBe("My Tracks");
  });

  it("still reads the title from a wrapped deep link", () => {
    expect(getItemTitle(wrapped)).toBe("My Tracks");
  });

  it("returns a stable id for an unwrapped deep link", () => {
    expect(getItemId(unwrapped)).toBe("tidal://my-collection/tracks");
  });

  it("returns a stable id for a wrapped deep link", () => {
    expect(getItemId(wrapped)).toBe("tidal://my-collection/tracks");
  });

  it("has no image for either shape", () => {
    expect(getItemImage(unwrapped)).toBe("");
    expect(getItemImage(wrapped)).toBe("");
  });

  it("is not playable media", () => {
    expect(buildMediaItem(unwrapped)).toBeNull();
    expect(buildMediaItem(wrapped)).toBeNull();
  });
});
