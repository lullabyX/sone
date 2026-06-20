import { describe, it, expect } from "vitest";
import { hsvToHex, hexToHsv } from "./ColorPicker";

describe("hsv/hex conversion", () => {
  it("round-trips a known accent", () => {
    const { h, s, v } = hexToHsv("#A855F7");
    expect(hsvToHex(h, s, v).toLowerCase()).toBe("#a855f7");
  });
  it("maps pure red", () => {
    expect(hsvToHex(0, 1, 1).toLowerCase()).toBe("#ff0000");
  });
  it("maps black and white", () => {
    expect(hsvToHex(0, 0, 0).toLowerCase()).toBe("#000000");
    expect(hsvToHex(0, 0, 1).toLowerCase()).toBe("#ffffff");
  });
});
