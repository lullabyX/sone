import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import ArtistHeroCanvas from "./ArtistHeroCanvas";
import {
  blurHeroSource,
  blurRadiusFor,
  loadHeroImage,
  paintArtistHero,
} from "../lib/artistHero";

type ROCallback = (
  entries: { contentRect: { width: number; height: number } }[],
) => void;
let observers: { cb: ROCallback; el: Element | null }[] = [];
const resizeTo = (width: number, height: number) =>
  act(() => {
    for (const o of observers)
      if (o.el) o.cb([{ contentRect: { width, height } }]);
  });

interface Op {
  op: string;
  args: unknown[];
  style?: unknown;
  composite?: string;
}

interface Gradient {
  args: number[];
  stops: [number, string][];
}

function makeCtx() {
  const ops: Op[] = [];
  const ctx: Record<string, unknown> = {
    fillStyle: null,
    globalCompositeOperation: "source-over",
    save: () => {},
    restore: () => {
      ctx.globalCompositeOperation = "source-over";
    },
    clearRect: (...args: unknown[]) => ops.push({ op: "clear", args }),
    drawImage: (...args: unknown[]) => ops.push({ op: "draw", args }),
    fillRect: (...args: unknown[]) =>
      ops.push({
        op: "fill",
        args,
        style: ctx.fillStyle,
        composite: ctx.globalCompositeOperation as string,
      }),
    createLinearGradient: (
      ...args: number[]
    ): Gradient & {
      addColorStop(o: number, c: string): void;
    } => ({
      args,
      stops: [],
      addColorStop(o: number, c: string) {
        this.stops.push([o, c]);
      },
    }),
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      ops.push({ op: "getImageData", args: [w, h] });
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
    },
    putImageData: (...args: unknown[]) =>
      ops.push({ op: "putImageData", args }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops };
}

function canvasWith(ctx: CanvasRenderingContext2D) {
  const c = document.createElement("canvas");
  c.getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"];
  return c;
}

const image = (width: number, height: number) =>
  ({ width, height }) as unknown as HTMLImageElement;

beforeEach(() => {
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      o: { cb: ROCallback; el: Element | null };
      constructor(cb: ROCallback) {
        this.o = { cb, el: null };
        observers.push(this.o);
      }
      observe(el: Element) {
        this.o.el = el;
      }
      disconnect() {
        this.o.el = null;
      }
    },
  );
  vi.stubGlobal("devicePixelRatio", 1);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("paintArtistHero", () => {
  it("stitches seven full-height copies around the centre and darkens the flanks", () => {
    const { ctx, ops } = makeCtx();
    const img = image(750, 750);
    paintArtistHero(
      canvasWith(ctx),
      { img, blurred: false },
      1200,
      480,
      "#101010",
    );
    const draws = ops.filter((o) => o.op === "draw");
    expect(draws).toHaveLength(7);
    expect(draws.map((d) => d.args[1])).toEqual([
      -1080, -600, -120, 360, 840, 1320, 1800,
    ]);
    expect(draws.every((d) => d.args[3] === 480 && d.args[4] === 480)).toBe(
      true,
    );
    const darken = ops.filter((o) => o.composite === "source-atop");
    expect(darken.map((d) => d.args)).toEqual([
      [0, 0, 360, 480],
      [840, 0, 360, 480],
    ]);
    expect(darken[0].style).toBe("rgba(0, 0, 0, 0.68)");
  });

  it("lands every copy on whole device pixels", () => {
    vi.stubGlobal("devicePixelRatio", 1.25);
    const { ctx, ops } = makeCtx();
    paintArtistHero(
      canvasWith(ctx),
      { img: image(640, 427), blurred: false },
      1001,
      480,
      "#101010",
    );
    for (const d of ops.filter((o) => o.op === "draw")) {
      expect(Number.isInteger(d.args[1])).toBe(true);
      expect(Number.isInteger(d.args[3])).toBe(true);
    }
  });

  it("fades the art before laying the two scrims on top", () => {
    const { ctx, ops } = makeCtx();
    paintArtistHero(
      canvasWith(ctx),
      { img: image(10, 10), blurred: false },
      100,
      50,
      "#101010",
    );
    const fills = ops.filter(
      (o) => o.op === "fill" && o.composite !== "source-atop",
    );
    expect(fills.map((f) => f.composite)).toEqual([
      "destination-in",
      "source-over",
      "source-over",
    ]);
    const [fade, up, right] = fills.map((f) => f.style as Gradient);
    expect(fade.stops[1]).toEqual([0.6, "rgba(0, 0, 0, 1)"]);
    expect(up.args).toEqual([0, 50, 0, 0]);
    expect(up.stops).toEqual([
      [0, "rgba(16, 16, 16, 0.85)"],
      [0.5, "rgba(16, 16, 16, 0.25)"],
      [1, "rgba(16, 16, 16, 0)"],
    ]);
    expect(right.args).toEqual([0, 0, 100, 0]);
    expect(right.stops).toEqual([
      [0, "rgba(16, 16, 16, 0.5)"],
      [1, "rgba(16, 16, 16, 0)"],
    ]);
  });

  it("softens the flank edges for the blurred stage without any canvas filter", () => {
    const { ctx, ops } = makeCtx();
    paintArtistHero(
      canvasWith(ctx),
      { img: image(10, 10), blurred: true },
      1000,
      480,
      "#101010",
    );
    expect(ops.filter((o) => o.op === "draw")).toHaveLength(7);
    expect("filter" in ctx).toBe(false);
    const darken = ops.filter((o) => o.composite === "source-atop");
    expect(darken).toHaveLength(1);
    const g = darken[0].style as Gradient;
    expect(g.stops.map(([, c]) => c)).toEqual([
      "rgba(0, 0, 0, 0.68)",
      "rgba(0, 0, 0, 0)",
      "rgba(0, 0, 0, 0)",
      "rgba(0, 0, 0, 0.68)",
    ]);
    expect(g.stops[0][0]).toBeLessThan(0.26);
    expect(g.stops[1][0]).toBeGreaterThan(0.26);
    expect(g.stops[2][0]).toBeLessThan(0.74);
    expect(g.stops[3][0]).toBeGreaterThan(0.74);
  });

  it("paints only the scrims without an image or with a malformed colour", () => {
    const a = makeCtx();
    paintArtistHero(canvasWith(a.ctx), null, 100, 50, "#101010");
    expect(a.ops.filter((o) => o.op === "fill")).toHaveLength(2);
    const b = makeCtx();
    expect(() =>
      paintArtistHero(canvasWith(b.ctx), null, 100, 50, "#zz"),
    ).not.toThrow();
    expect(b.ops.filter((o) => o.op === "fill")).toHaveLength(0);
  });
});

describe("low-res blur", () => {
  it("picks the box radius whose three passes match the gaussian sigma", () => {
    expect(blurRadiusFor(13.33)).toBe(13);
    expect(blurRadiusFor(0.1)).toBe(1);
    const r = blurRadiusFor(20);
    expect(Math.abs(Math.sqrt(r * (r + 1)) - 20)).toBeLessThan(1);
  });

  it("blurs once at the source size, wrapping horizontally", () => {
    const padded = makeCtx();
    const out = makeCtx();
    const canvases = [canvasWith(padded.ctx), canvasWith(out.ctx)];
    const createCanvas = vi.fn((w: number, h: number) => {
      const c = canvases.shift()!;
      c.width = w;
      c.height = h;
      return c;
    });
    const img = image(160, 160);
    const result = blurHeroSource(img, createCanvas);
    const r = blurRadiusFor(160 * (40 / 480));
    expect(createCanvas.mock.calls).toEqual([
      [160 + 6 * r, 160],
      [160, 160],
    ]);
    expect(
      padded.ops.filter((o) => o.op === "draw").map((o) => o.args[1]),
    ).toEqual([3 * r - 160, 3 * r, 3 * r + 160]);
    expect(padded.ops.filter((o) => o.op === "getImageData")).toHaveLength(1);
    expect(out.ops.find((o) => o.op === "draw")!.args).toEqual([
      expect.anything(),
      3 * r,
      0,
      160,
      160,
      0,
      0,
      160,
      160,
    ]);
    expect(result).not.toBeNull();
  });

  it("loadHeroImage blurs only the low-res stage", async () => {
    const createCanvas = vi.fn(() => canvasWith(makeCtx().ctx));
    const loadImage = vi.fn(async () => image(160, 160));
    const hi = await loadHeroImage("hi", false, { loadImage, createCanvas });
    expect(hi.blurred).toBe(false);
    expect(createCanvas).not.toHaveBeenCalled();
    const low = await loadHeroImage("low", true, { loadImage, createCanvas });
    expect(low.blurred).toBe(true);
    expect(createCanvas).toHaveBeenCalledTimes(2);
  });
});

describe("ArtistHeroCanvas", () => {
  let loads: {
    src: string;
    img: { width: number; height: number; onload?: () => void };
  }[];
  let ctx: ReturnType<typeof makeCtx>;
  beforeEach(() => {
    loads = [];
    vi.stubGlobal(
      "Image",
      class {
        width = 100;
        height = 100;
        onload?: () => void;
        onerror?: () => void;
        set src(v: string) {
          loads.push({ src: v, img: this });
        }
      },
    );
    ctx = makeCtx();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      ctx.ctx,
    );
  });
  const finish = (src: string) =>
    act(async () => {
      loads.find((l) => l.src === src)!.img.onload!();
    });
  const blurRuns = () => ctx.ops.filter((o) => o.op === "getImageData").length;
  const heroDraws = () =>
    ctx.ops.filter(
      (o) => o.op === "draw" && o.args.length === 5 && o.args[4] === 480,
    );

  it("is hidden from assistive tech", () => {
    const { getByTestId } = render(<ArtistHeroCanvas low={null} hi={null} />);
    expect(getByTestId("artist-hero-canvas").getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("sizes the canvas to the hero box and repaints on resize", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const { getByTestId } = render(<ArtistHeroCanvas low={null} hi={null} />);
    resizeTo(900, 480);
    const canvas = getByTestId("artist-hero-canvas") as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([1800, 960]);
    resizeTo(1000, 480);
    expect([canvas.width, canvas.height]).toEqual([2000, 960]);
  });

  it("blurs the low-res image once, not on every repaint", async () => {
    render(<ArtistHeroCanvas low="low" hi={null} />);
    resizeTo(900, 480);
    await finish("low");
    expect(blurRuns()).toBe(1);
    expect(heroDraws()).toHaveLength(7);
    resizeTo(1000, 480);
    resizeTo(1100, 480);
    expect(blurRuns()).toBe(1);
    expect(heroDraws()).toHaveLength(21);
  });

  it("keeps the low-res image until the hi-res loads, then swaps", async () => {
    const { rerender } = render(<ArtistHeroCanvas low="low" hi={null} />);
    resizeTo(900, 480);
    await finish("low");
    ctx.ops.length = 0;
    rerender(<ArtistHeroCanvas low="low" hi="hi" />);
    expect(ctx.ops).toHaveLength(0);
    await finish("hi");
    expect(blurRuns()).toBe(0);
    const draws = heroDraws();
    expect(draws).toHaveLength(7);
    expect(draws.every((d) => d.args[0] === loads[1].img)).toBe(true);
  });

  it("drops the previous artist's image when the sources reset", async () => {
    const { rerender } = render(<ArtistHeroCanvas low="a" hi={null} />);
    resizeTo(900, 480);
    await finish("a");
    rerender(<ArtistHeroCanvas low={null} hi={null} />);
    ctx.ops.length = 0;
    rerender(<ArtistHeroCanvas low="b" hi={null} />);
    resizeTo(901, 480);
    expect(heroDraws()).toHaveLength(0);
    expect(ctx.ops.filter((o) => o.op === "fill")).toHaveLength(2);
  });

  it("repaints at the new resolution when the monitor scale changes", () => {
    const listeners: (() => void)[] = [];
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        addEventListener: (_: string, cb: () => void) => listeners.push(cb),
        removeEventListener: () => {},
      })),
    );
    const { getByTestId } = render(<ArtistHeroCanvas low={null} hi={null} />);
    resizeTo(900, 480);
    const canvas = getByTestId("artist-hero-canvas") as HTMLCanvasElement;
    expect(canvas.width).toBe(900);
    vi.stubGlobal("devicePixelRatio", 2);
    act(() => listeners.forEach((cb) => cb()));
    expect([canvas.width, canvas.height]).toEqual([1800, 960]);
    expect(window.matchMedia).toHaveBeenLastCalledWith("(resolution: 2dppx)");
  });
});
