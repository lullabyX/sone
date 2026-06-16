import { describe, it, expect } from "vitest";
import { getTidalVideoUrl } from "./types";

describe("getTidalVideoUrl", () => {
  it("returns empty string for undefined input", () => {
    expect(getTidalVideoUrl(undefined)).toBe("");
  });

  it("passes through values that are already full URLs", () => {
    const url = "https://example.com/clip.mp4";
    expect(getTidalVideoUrl(url)).toBe(url);
  });

  it("builds a /videos/ mp4 URL, converting UUID dashes to slashes", () => {
    expect(getTidalVideoUrl("11-22-33", 640)).toBe(
      "https://resources.tidal.com/videos/11/22/33/640x640.mp4",
    );
  });

  it("snaps sizes <= 640 down to the 640 bracket", () => {
    expect(getTidalVideoUrl("ab", 320)).toBe(
      "https://resources.tidal.com/videos/ab/640x640.mp4",
    );
  });

  it("keeps size exactly 640 in the 640 bracket", () => {
    expect(getTidalVideoUrl("ab", 640)).toBe(
      "https://resources.tidal.com/videos/ab/640x640.mp4",
    );
  });

  it("snaps sizes > 640 up to the 1280 bracket", () => {
    expect(getTidalVideoUrl("ab", 1280)).toBe(
      "https://resources.tidal.com/videos/ab/1280x1280.mp4",
    );
  });

  it("returns the native origin URL when size is 'origin'", () => {
    expect(getTidalVideoUrl("11-22-33", "origin")).toBe(
      "https://resources.tidal.com/videos/11/22/33/origin.mp4",
    );
  });
});
