import { describe, it, expect } from "vitest";
import {
  BLOBS,
  easeInOut,
  sampleStops,
  blobStateAt,
  drawBanner,
  bannerOverlay,
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
    const m = blobStateAt(BLOBS[1], 0.44 * 17 - 2);
    expect(m.deg).toBeCloseTo(-9, 5);
    expect(m.scale).toBeCloseTo(1.19, 5);
    expect(blobStateAt(BLOBS[2], 0.48 * 41 - 6).opacity).toBeCloseTo(0.38, 5);
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
      createLinearGradient: () => ({ addColorStop: () => {} }),
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

  type Op = { op: string; args: number[]; alpha?: number };
  function recordingCtx(): { ctx: Ctx2dLike; ops: Op[] } {
    const ops: Op[] = [];
    const ctx: Ctx2dLike = {
      globalAlpha: 1,
      fillStyle: null,
      save: () => ops.push({ op: "save", args: [] }),
      restore: () => ops.push({ op: "restore", args: [] }),
      translate: (x, y) => ops.push({ op: "translate", args: [x, y] }),
      rotate: (rad) => ops.push({ op: "rotate", args: [rad] }),
      scale: (x, y) => ops.push({ op: "scale", args: [x, y] }),
      clearRect: (...a) => ops.push({ op: "clear", args: a }),
      fillRect: (...a) =>
        ops.push({ op: "fill", args: a, alpha: ctx.globalAlpha }),
      createRadialGradient: (...a) => {
        ops.push({ op: "gradient", args: a });
        return { addColorStop: () => {} };
      },
      createLinearGradient: (...a) => {
        ops.push({ op: "linear", args: a });
        return { addColorStop: () => {} };
      },
    };
    return { ctx, ops };
  }
  function firstBlobOps(ops: Op[]): Op[] {
    const start = ops.findIndex((o) => o.op === "save");
    const end = ops.findIndex((o) => o.op === "restore");
    return ops.slice(start + 1, end);
  }

  it("drawBanner applies drift, rotation, scale and pulse for a blob", () => {
    const t = 0.28 * 23 - 4;
    const state = blobStateAt(BLOBS[0], t);
    const bw = 0.7975 * 1200;
    const bh = 2.325 * 420;
    const { ctx, ops } = recordingCtx();
    drawBanner(ctx, 1200, 420, t);
    const blob = firstBlobOps(ops);
    const [centre, drift] = blob.filter((o) => o.op === "translate");
    expect(centre.args[0]).toBeCloseTo(-0.1738 * 1200 + bw / 2, 5);
    expect(drift.args[0]).toBeCloseTo(0.152 * bw, 5);
    expect(drift.args[1]).toBeCloseTo(0.061 * bh, 5);
    const rotate = blob.find((o) => o.op === "rotate")!;
    expect(rotate.args[0]).toBeCloseTo((state.deg * Math.PI) / 180, 10);
    const [morphScale] = blob.filter((o) => o.op === "scale");
    expect(morphScale.args[0]).toBeCloseTo(state.scale, 10);
    expect(morphScale.args[1]).toBeCloseTo(state.scale, 10);
    expect(blob.find((o) => o.op === "fill")!.alpha).toBeCloseTo(
      state.opacity,
      10,
    );
  });

  it("drawBanner paints a closest-side ellipse that turns with the box", () => {
    const w = 800;
    const h = 420;
    const bw = 0.7975 * w;
    const bh = 2.325 * h;
    const { ctx, ops } = recordingCtx();
    drawBanner(ctx, w, h, 0);
    const blob = firstBlobOps(ops);
    const names = blob.map((o) => o.op);
    const scales = blob.filter((o) => o.op === "scale");
    expect(scales).toHaveLength(2);
    expect(names.indexOf("rotate")).toBeLessThan(names.lastIndexOf("scale"));
    expect(scales[1].args[0]).toBeCloseTo(bw / 2, 5);
    expect(scales[1].args[1]).toBeCloseTo(bh / 2, 5);
    expect(blob.find((o) => o.op === "gradient")!.args).toEqual([
      0, 0, 0, 0, 0, 1,
    ]);
    expect(blob.find((o) => o.op === "fill")!.args).toEqual([-1, -1, 2, 2]);
  });

  it("bannerOverlay builds the wash, right-edge and bottom gradients", () => {
    expect(bannerOverlay("#101010", "#202020")).toEqual({
      wash: "rgba(16, 16, 16, 0.6)",
      right: [
        [0, "rgba(16, 16, 16, 0)"],
        [0.5, "rgba(16, 16, 16, 0.2)"],
        [1, "rgba(16, 16, 16, 0.6)"],
      ],
      bottom: [
        [0, "rgba(32, 32, 32, 0)"],
        [0.7, "rgba(32, 32, 32, 0)"],
        [1, "rgba(32, 32, 32, 1)"],
      ],
    });
    expect(bannerOverlay("#zz", "#202020")).toBeNull();
  });

  it("drawBanner lays the wash and both gradients over the blobs", () => {
    const { ctx, ops } = recordingCtx();
    const styles: unknown[] = [];
    const fill = ctx.fillRect;
    ctx.fillRect = (...a) => {
      styles.push(ctx.fillStyle);
      fill(...a);
    };
    drawBanner(ctx, 400, 100, 0, bannerOverlay("#101010", "#202020"));
    const tail = ops.slice(ops.map((o) => o.op).lastIndexOf("restore") + 1);
    expect(tail.map((o) => o.op)).toEqual([
      "fill",
      "linear",
      "fill",
      "linear",
      "fill",
    ]);
    expect(tail[1].args).toEqual([0, 0, 400, 0]);
    expect(tail[3].args).toEqual([0, 0, 0, 100]);
    expect(styles[3]).toBe("rgba(16, 16, 16, 0.6)");
  });
});
