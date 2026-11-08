import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../components/TidalImage", () => ({
  fetchCachedImageUrl: (s: string) => Promise.resolve(`blob:${s}`),
}));
import {
  bakeCover,
  BAKE_WIDTH,
  BLUR_OPTIONS,
  SHARP_MAX_WIDTH,
  SHARP_OPTIONS,
  _resetCoverBlurCacheForTests,
  type BakeDeps,
} from "./coverBlur";
const fakeCanvas = () => {
  const data = new Uint8ClampedArray(BAKE_WIDTH * BAKE_WIDTH * 4).fill(200);
  const ctx = {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({
      data,
      width: BAKE_WIDTH,
      height: BAKE_WIDTH,
    })),
    putImageData: vi.fn(),
  };
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
    _ctx: ctx,
  } as unknown as HTMLCanvasElement & { _ctx: typeof ctx };
};
const img = (w: number, h: number) =>
  ({ width: w, height: h }) as HTMLImageElement;
const bakeBlurredCover = (src: string, deps: BakeDeps) =>
  bakeCover(src, BLUR_OPTIONS, deps);
beforeEach(() => _resetCoverBlurCacheForTests());
describe("bakeCover (blur)", () => {
  it("bakes at BAKE_WIDTH keeping the aspect and runs the pixel pass", async () => {
    const c = fakeCanvas();
    const image = img(640, 320);
    const out = await bakeBlurredCover("u1", {
      loadImage: async () => image,
      createCanvas: () => c,
    });
    expect(out).toBe(c);
    expect(c.width).toBe(BAKE_WIDTH);
    expect(c.height).toBe(BAKE_WIDTH / 2);
    expect(c._ctx.drawImage).toHaveBeenCalledWith(
      image,
      0,
      0,
      BAKE_WIDTH,
      BAKE_WIDTH / 2,
    );
    expect(c._ctx.putImageData).toHaveBeenCalledTimes(1);
  });
  it("memoises per source", async () => {
    const loadImage = vi.fn(async () => img(10, 10));
    await bakeBlurredCover("u2", { loadImage, createCanvas: fakeCanvas });
    await bakeBlurredCover("u2", { loadImage, createCanvas: fakeCanvas });
    expect(loadImage).toHaveBeenCalledTimes(1);
  });
  it("a failed image resolves to null and is retried next time", async () => {
    const loadImage = vi
      .fn()
      .mockRejectedValueOnce(new Error("x"))
      .mockResolvedValueOnce(img(4, 4));
    expect(
      await bakeBlurredCover("u3", { loadImage, createCanvas: fakeCanvas }),
    ).toBeNull();
    expect(
      await bakeBlurredCover("u3", { loadImage, createCanvas: fakeCanvas }),
    ).not.toBeNull();
  });
  it("fades the edges into transparency like a CSS blur", async () => {
    const w = BAKE_WIDTH;
    const h = BAKE_WIDTH / 2;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = data[i + 1] = data[i + 2] = 200;
      data[i + 3] = 255;
    }
    const ctx = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data, width: w, height: h })),
      putImageData: vi.fn(),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;
    await bakeBlurredCover("edge", {
      loadImage: async () => img(640, 320),
      createCanvas: () => canvas,
    });
    const out = ctx.putImageData.mock.calls[0][0].data as Uint8ClampedArray;
    const at = (x: number, y: number) => (y * w + x) * 4;
    const corner = at(0, 0);
    const top = at(w / 2, 0);
    const centre = at(w / 2, h / 2);
    expect(out[corner + 3]).toBeLessThan(100);
    expect(out[top + 3]).toBeLessThan(200);
    expect(out[top + 3]).toBeGreaterThan(out[corner + 3]);
    expect(out[centre + 3]).toBe(255);
    expect(Math.abs(out[top] - 200)).toBeLessThanOrEqual(3);
    expect(Math.abs(out[corner] - 200)).toBeLessThanOrEqual(3);
  });
  it("keeps at most 64 sources, evicting the oldest", async () => {
    const loadImage = vi.fn(async () => img(4, 4));
    for (let i = 0; i <= 64; i++) {
      await bakeBlurredCover(`cap${i}`, {
        loadImage,
        createCanvas: fakeCanvas,
      });
    }
    await bakeBlurredCover("cap64", { loadImage, createCanvas: fakeCanvas });
    expect(loadImage).toHaveBeenCalledTimes(65);
    await bakeBlurredCover("cap0", { loadImage, createCanvas: fakeCanvas });
    expect(loadImage).toHaveBeenCalledTimes(66);
  });
});
describe("bakeCover (sharp)", () => {
  it("caps the width at 1280 without upscaling and skips the pixel pass", async () => {
    const big = fakeCanvas();
    await bakeCover("s1", SHARP_OPTIONS, {
      loadImage: async () => img(1600, 1600),
      createCanvas: () => big,
    });
    expect(SHARP_MAX_WIDTH).toBe(1280);
    expect(big.width).toBe(1280);
    expect(big.height).toBe(1280);
    expect(big._ctx.getImageData).not.toHaveBeenCalled();
    const small = fakeCanvas();
    await bakeCover("s2", SHARP_OPTIONS, {
      loadImage: async () => img(640, 320),
      createCanvas: () => small,
    });
    expect(small.width).toBe(640);
    expect(small.height).toBe(320);
  });
  it("is cached apart from blurred bakes and keeps at most 4 sources", async () => {
    const loadImage = vi.fn(async () => img(4, 4));
    const deps = { loadImage, createCanvas: fakeCanvas };
    await bakeBlurredCover("same", deps);
    await bakeCover("same", SHARP_OPTIONS, deps);
    expect(loadImage).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 4; i++) await bakeCover(`sc${i}`, SHARP_OPTIONS, deps);
    expect(loadImage).toHaveBeenCalledTimes(6);
    await bakeCover("same", SHARP_OPTIONS, deps);
    expect(loadImage).toHaveBeenCalledTimes(7);
    await bakeBlurredCover("same", deps);
    expect(loadImage).toHaveBeenCalledTimes(7);
  });
  it("evicts the least recently used source, not the oldest", async () => {
    const loadImage = vi.fn(async () => img(4, 4));
    const deps = { loadImage, createCanvas: fakeCanvas };
    for (let i = 0; i < 4; i++) await bakeCover(`lru${i}`, SHARP_OPTIONS, deps);
    await bakeCover("lru0", SHARP_OPTIONS, deps);
    await bakeCover("lru4", SHARP_OPTIONS, deps);
    expect(loadImage).toHaveBeenCalledTimes(5);
    await bakeCover("lru0", SHARP_OPTIONS, deps);
    expect(loadImage).toHaveBeenCalledTimes(5);
    await bakeCover("lru1", SHARP_OPTIONS, deps);
    expect(loadImage).toHaveBeenCalledTimes(6);
  });
});
