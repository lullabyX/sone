import { describe, expect, it } from "vitest";
import { cssBlurPasses, cssBlurRGBA } from "./cssBlur";

describe("cssBlurPasses", () => {
  it("follows the spec's box sizes", () => {
    // σ = 10 → d = floor(10·3·√(2π)/4 + 0.5) = 19, odd: three centred boxes.
    expect(cssBlurPasses(10)).toEqual([
      [9, 9],
      [9, 9],
      [9, 9],
    ]);
    // σ = 2 → d = 4, even: d left, d right, d + 1 centred.
    expect(cssBlurPasses(2)).toEqual([
      [2, 1],
      [1, 2],
      [2, 2],
    ]);
    expect(cssBlurPasses(0.3)).toEqual([]);
  });
});

describe("cssBlurRGBA", () => {
  const solid = (w: number, h: number, rgb: [number, number, number]) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < d.length; i += 4) d.set([...rgb, 255], i);
    return d;
  };

  it("keeps a flat colour flat away from the edges, and fades the edges to transparent", () => {
    const w = 60;
    const d = solid(w, w, [200, 100, 50]);
    cssBlurRGBA(d, w, w, 3);
    const at = (x: number, y: number) =>
      Array.from(d.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
    expect(at(30, 30)).toEqual([200, 100, 50, 255]);
    // The colour stays the same at the edge; only its alpha falls off.
    const edge = at(0, 30);
    expect(edge.slice(0, 3)).toEqual([200, 100, 50]);
    expect(edge[3]).toBeLessThan(160);
    expect(edge[3]).toBeGreaterThan(90);
  });

  it("spreads a point symmetrically and keeps its total", () => {
    const w = 41;
    const d = new Uint8ClampedArray(w * w * 4);
    const c = (20 * w + 20) * 4;
    d.set([255, 255, 255, 255], c);
    // Scale the impulse up through alpha sums, which stay unrounded until the end.
    cssBlurRGBA(d, w, w, 1.5);
    let total = 0;
    for (let i = 3; i < d.length; i += 4) total += d[i];
    expect(Math.abs(total - 255)).toBeLessThan(40);
    const a = (x: number, y: number) => d[(y * w + x) * 4 + 3];
    expect(a(19, 20)).toBe(a(21, 20));
    expect(a(20, 19)).toBe(a(20, 21));
  });
});
