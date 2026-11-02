import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../components/TidalImage", () => ({
  fetchCachedImageUrl: (s: string) => Promise.resolve(`blob:${s}`),
}));
import {
  bakeBlurredCover,
  BAKE_WIDTH,
  _resetCoverBlurCacheForTests,
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
beforeEach(() => _resetCoverBlurCacheForTests());
describe("bakeBlurredCover", () => {
  it("bakes at BAKE_WIDTH keeping the aspect and runs the pixel pass", async () => {
    const c = fakeCanvas();
    const out = await bakeBlurredCover("u1", {
      loadImage: async () => img(640, 320),
      createCanvas: () => c,
    });
    expect(out).toBe(c);
    expect(c.width).toBe(BAKE_WIDTH);
    expect(c.height).toBe(BAKE_WIDTH / 2);
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
});
