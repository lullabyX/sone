import { describe, it, expect, vi, afterEach } from "vitest";
import {
  alphaStops,
  fadeBottom,
  fillLinear,
  sizeCanvasToBox,
  withAlpha,
} from "./bannerCanvas";

function recordingCtx() {
  const gradients: { args: number[]; stops: [number, string][] }[] = [];
  const fills: { rect: number[]; style: unknown; op: string }[] = [];
  const ctx = {
    fillStyle: null as unknown,
    globalCompositeOperation: "source-over",
    save: vi.fn(),
    restore: vi.fn(() => {
      ctx.globalCompositeOperation = "source-over";
    }),
    createLinearGradient: (...args: number[]) => {
      const g = { args, stops: [] as [number, string][] };
      gradients.push(g);
      return {
        addColorStop: (o: number, c: string) => g.stops.push([o, c]),
        _g: g,
      };
    },
    fillRect: (...rect: number[]) =>
      fills.push({
        rect,
        style: ctx.fillStyle,
        op: ctx.globalCompositeOperation,
      }),
  };
  return { ctx, gradients, fills };
}

afterEach(() => vi.unstubAllGlobals());

describe("withAlpha", () => {
  it("parses #rrggbb and #rgb", () => {
    expect(withAlpha("#0E1118", 0.5)).toBe("rgba(14, 17, 24, 0.5)");
    expect(withAlpha("#fff", 0)).toBe("rgba(255, 255, 255, 0)");
  });
  it("rejects malformed colours", () => {
    expect(withAlpha("#zzzzzz", 1)).toBeNull();
    expect(withAlpha("#NaNNaNNaN", 1)).toBeNull();
    expect(alphaStops("nope", [[0, 1]])).toBeNull();
  });
  it("alphaStops keeps the offsets", () => {
    expect(
      alphaStops("#000000", [
        [0, 0.3],
        [1, 0],
      ]),
    ).toEqual([
      [0, "rgba(0, 0, 0, 0.3)"],
      [1, "rgba(0, 0, 0, 0)"],
    ]);
  });
});

describe("fillLinear", () => {
  it("runs the gradient in the requested direction over the whole canvas", () => {
    const { ctx, gradients, fills } = recordingCtx();
    fillLinear(ctx, "right", 100, 50, [[0, "red"]]);
    fillLinear(ctx, "down", 100, 50, [[0, "red"]]);
    fillLinear(ctx, "up", 100, 50, [[0, "red"]]);
    expect(gradients.map((g) => g.args)).toEqual([
      [0, 0, 100, 0],
      [0, 0, 0, 50],
      [0, 50, 0, 0],
    ]);
    expect(fills.every((f) => f.rect.join() === "0,0,100,50")).toBe(true);
  });
});

describe("fadeBottom", () => {
  it("keeps alpha to fadeStart and ramps it to zero at the bottom", () => {
    const { ctx, gradients, fills } = recordingCtx();
    fadeBottom(ctx as unknown as CanvasRenderingContext2D, 10, 200, 0.5);
    expect(fills).toHaveLength(1);
    expect(fills[0].op).toBe("destination-in");
    expect(gradients[0].args).toEqual([0, 0, 0, 200]);
    expect(gradients[0].stops).toEqual([
      [0, "rgba(0, 0, 0, 1)"],
      [0.5, "rgba(0, 0, 0, 1)"],
      [1, "rgba(0, 0, 0, 0)"],
    ]);
    expect(ctx.globalCompositeOperation).toBe("source-over");
  });
});

describe("sizeCanvasToBox", () => {
  it("scales the backing store by devicePixelRatio", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const canvas = document.createElement("canvas");
    expect(sizeCanvasToBox(canvas, 400.4, 100)).toEqual({ w: 801, h: 200 });
    expect([canvas.width, canvas.height]).toEqual([801, 200]);
  });
});
