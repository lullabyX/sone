import { fetchCachedImageUrl } from "../components/TidalImage";
import { blurRGBA, saturateRGBA } from "./imageBlur";
import { createCanvas, loadImage } from "./bannerCanvas";

export const BAKE_WIDTH = 128;
export const BAKE_RADIUS = 5;
export const BAKE_SATURATE = 1.2;

export interface BakeDeps {
  loadImage(src: string): Promise<HTMLImageElement>;
  createCanvas(w: number, h: number): HTMLCanvasElement;
}

const defaultDeps: BakeDeps = { loadImage, createCanvas };

export const SHARP_MAX_WIDTH = 1280;

export interface BakeOptions {
  blur: boolean;
  /** Exact width when blurring; an upper bound for sharp art, which is never upscaled. */
  width: number;
}

export const BLUR_OPTIONS: BakeOptions = { blur: true, width: BAKE_WIDTH };
export const SHARP_OPTIONS: BakeOptions = {
  blur: false,
  width: SHARP_MAX_WIDTH,
};

const BLUR_MAX_ENTRIES = 64;
const SHARP_MAX_ENTRIES = 4;
const blurCache = new Map<string, Promise<HTMLCanvasElement | null>>();
const sharpCache = new Map<string, Promise<HTMLCanvasElement | null>>();

async function bake(
  src: string,
  opts: BakeOptions,
  deps: BakeDeps,
): Promise<HTMLCanvasElement | null> {
  const img = await deps.loadImage(await fetchCachedImageUrl(src));
  if (!img.width || !img.height) throw new Error("empty image");
  const w = opts.blur ? opts.width : Math.min(img.width, opts.width);
  const h = Math.max(1, Math.round((w * img.height) / img.width));
  const canvas = deps.createCanvas(w, h);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(img, 0, 0, w, h);
  if (opts.blur) {
    const id = ctx.getImageData(0, 0, w, h);
    saturateRGBA(id.data, BAKE_SATURATE);
    blurWithEdgeFade(id.data, w, h);
    ctx.putImageData(id, 0, 0);
  }
  return canvas;
}

// Blurs into transparent padding, like a CSS filter does past an element's
// bounds, so the top/left/right edges fade instead of staying fully opaque.
function blurWithEdgeFade(data: Uint8ClampedArray, w: number, h: number) {
  const p = 3 * BAKE_RADIUS;
  const pw = w + 2 * p;
  const ph = h + 2 * p;
  const buf = new Uint8ClampedArray(pw * ph * 4);
  for (let y = 0; y < h; y++) {
    buf.set(data.subarray(y * w * 4, (y + 1) * w * 4), ((y + p) * pw + p) * 4);
  }
  blurRGBA(buf, pw, ph, BAKE_RADIUS);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y + p) * pw + x + p) * 4;
      const o = (y * w + x) * 4;
      const a = buf[i + 3];
      const k = a > 0 ? 255 / a : 0;
      data[o] = buf[i] * k;
      data[o + 1] = buf[i + 1] * k;
      data[o + 2] = buf[i + 2] * k;
      data[o + 3] = a;
    }
  }
}

// Blurred art is baked small and upscaled when drawn; sharp art is capped in
// width. Each kind has its own LRU cache.
export function bakeCover(
  src: string,
  opts: BakeOptions,
  deps: BakeDeps = defaultDeps,
): Promise<HTMLCanvasElement | null> {
  const cache = opts.blur ? blurCache : sharpCache;
  const max = opts.blur ? BLUR_MAX_ENTRIES : SHARP_MAX_ENTRIES;
  const key = `${opts.width}:${src}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const promise = bake(src, opts, deps).catch(() => {
    if (cache.get(key) === promise) cache.delete(key);
    return null;
  });
  cache.set(key, promise);
  if (cache.size > max) cache.delete(cache.keys().next().value!);
  return promise;
}

export function _resetCoverBlurCacheForTests() {
  blurCache.clear();
  sharpCache.clear();
}
