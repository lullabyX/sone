import { describe, it, expect } from "vitest";
import {
  BLOBS,
  easeInOut,
  sampleStops,
  blobStateAt,
  drawBanner,
  type Ctx2dLike,
} from "./lovedBanner";

describe("lovedBanner", () => {
  it("carries the three CSS blobs verbatim", () => {
    expect(BLOBS).toHaveLength(3);
    expect(BLOBS[0].box).toEqual({
      w: 0.7975,
      h: 2.325,
      left: -0.1738,
      top: -0.7125,
    });
    expect(BLOBS[0].drift).toMatchObject({ period: 23, delay: 4 });
    expect(BLOBS[0].drift.stops[1]).toEqual([0.28, 15.2, 6.1]);
    expect(BLOBS[1].morph.stops[1]).toEqual([0.44, -9, 1.19]);
    expect(BLOBS[2].pulse).toEqual({
      period: 41,
      delay: 6,
      stops: [
        [0, 0.6],
        [0.48, 0.38],
        [1, 0.6],
      ],
    });
    expect(BLOBS[2].color).toEqual([0, 210, 255]);
  });
  it("easeInOut is the CSS curve", () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 3);
    expect(easeInOut(0.25)).toBeLessThan(0.25);
    expect(easeInOut(0.75)).toBeGreaterThan(0.75);
  });
  it("sampleStops hits the stops exactly and wraps", () => {
    const stops = [
      [0, 0, 0],
      [0.5, 10, -10],
      [1, 0, 0],
    ];
    expect(sampleStops(stops, 10, 0, 5)).toEqual([10, -10]);
    expect(sampleStops(stops, 10, 0, 15)).toEqual([10, -10]);
    expect(sampleStops(stops, 10, 2, 3)).toEqual([10, -10]); // delay shifts the phase
    expect(sampleStops(stops, 10, 0, 0)).toEqual([0, 0]);
  });
  it("blobStateAt returns the keyframe values at a stop", () => {
    const s = blobStateAt(BLOBS[0], 0.28 * 23 - 4); // drift stop 1 for blob 1
    expect(s.tx).toBeCloseTo(15.2, 5);
    expect(s.ty).toBeCloseTo(6.1, 5);
  });
  it("drawBanner paints three gradients at the blob centres", () => {
    const calls: string[] = [];
    const ctx: Ctx2dLike = {
      globalAlpha: 1,
      fillStyle: null,
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      translate: (x, y) =>
        calls.push(`translate ${x.toFixed(1)} ${y.toFixed(1)}`),
      rotate: () => calls.push("rotate"),
      scale: () => calls.push("scale"),
      clearRect: () => calls.push("clear"),
      fillRect: () => calls.push("fill"),
      createRadialGradient: () => ({ addColorStop: () => calls.push("stop") }),
    };
    drawBanner(ctx, 1200, 420, 0);
    expect(calls.filter((c) => c === "fill")).toHaveLength(3);
    expect(calls.filter((c) => c === "stop")).toHaveLength(18); // 6 stops × 3 blobs
    expect(calls[0]).toBe("clear");
    // blob 1 centre at t=0 (no drift offset): left + w/2 of 1200, top + h/2 of 420
    expect(calls).toContain(
      `translate ${(-0.1738 * 1200 + (0.7975 * 1200) / 2).toFixed(1)} ${(-0.7125 * 420 + (2.325 * 420) / 2).toFixed(1)}`,
    );
  });
});
