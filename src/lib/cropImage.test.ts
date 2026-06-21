import { describe, it, expect } from "vitest";
import { clampOutputSize } from "./cropImage";

describe("clampOutputSize", () => {
  it("uses the cropped width when below the cap", () => {
    expect(clampOutputSize({ width: 800, height: 800 })).toBe(800);
  });

  it("caps at 1280 by default", () => {
    expect(clampOutputSize({ width: 3000, height: 3000 })).toBe(1280);
  });

  it("rounds to an integer and honors a custom cap", () => {
    expect(clampOutputSize({ width: 640.6, height: 640.6 }, 512)).toBe(512);
    expect(clampOutputSize({ width: 200.4, height: 200.4 }, 512)).toBe(200);
  });
});
