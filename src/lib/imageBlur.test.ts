import { describe, it, expect } from "vitest";
import { blurRGBA, saturateRGBA } from "./imageBlur";
const px = (w: number, h: number) => new Uint8ClampedArray(w * h * 4);
describe("imageBlur", () => {
  it("leaves a flat image unchanged", () => {
    const d = px(8, 8).fill(120);
    blurRGBA(d, 8, 8, 2);
    expect(Array.from(d.slice(0, 8))).toEqual([
      120, 120, 120, 120, 120, 120, 120, 120,
    ]);
  });
  it("spreads a single bright pixel symmetrically", () => {
    const d = px(9, 9);
    d.set([255, 255, 255, 255], (4 * 9 + 4) * 4);
    blurRGBA(d, 9, 9, 1);
    const at = (x: number, y: number) => d[(y * 9 + x) * 4];
    expect(at(4, 4)).toBeGreaterThan(at(3, 4));
    expect(at(3, 4)).toBe(at(5, 4));
    expect(at(4, 3)).toBe(at(4, 5));
    expect(at(0, 0)).toBe(0);
  });
  it("radius below 1 is a no-op", () => {
    const d = px(3, 3);
    d.set([255, 0, 0, 255], 0);
    blurRGBA(d, 3, 3, 0);
    expect(d[0]).toBe(255);
  });
  it("saturate keeps grey and pushes colour", () => {
    const d = new Uint8ClampedArray([100, 100, 100, 255, 200, 50, 50, 255]);
    saturateRGBA(d, 1.2);
    expect(Array.from(d.slice(0, 3))).toEqual([100, 100, 100]);
    expect(d[4]).toBeGreaterThan(200);
    expect(d[5]).toBeLessThan(50);
  });
});
