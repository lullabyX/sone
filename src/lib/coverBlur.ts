import { fetchCachedImageUrl } from "../components/TidalImage";
import { blurRGBA, saturateRGBA } from "./imageBlur";

export const BAKE_WIDTH = 128;
export const BAKE_RADIUS = 5;
export const BAKE_SATURATE = 1.2;

export interface BakeDeps {
  loadImage(src: string): Promise<HTMLImageElement>;
  createCanvas(w: number, h: number): HTMLCanvasElement;
}

const defaultDeps: BakeDeps = {
  loadImage: (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image load failed"));
      img.src = src;
    }),
  createCanvas: (w, h) => {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    return canvas;
  },
};

const MAX_ENTRIES = 64;
const cache = new Map<string, Promise<HTMLCanvasElement | null>>();

async function bake(
  src: string,
  deps: BakeDeps,
): Promise<HTMLCanvasElement | null> {
  const img = await deps.loadImage(await fetchCachedImageUrl(src));
  if (!img.width || !img.height) throw new Error("empty image");
  const w = BAKE_WIDTH;
  const h = Math.max(1, Math.round((BAKE_WIDTH * img.height) / img.width));
  const canvas = deps.createCanvas(w, h);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(img, 0, 0, w, h);
  const id = ctx.getImageData(0, 0, w, h);
  saturateRGBA(id.data, BAKE_SATURATE);
  blurWithEdgeFade(id.data, w, h);
  ctx.putImageData(id, 0, 0);
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

// Blurred once at a small size; the browser's upscale keeps it smooth and
// scroll repaints become a plain blit instead of a live CSS filter.
export function bakeBlurredCover(
  src: string,
  deps: BakeDeps = defaultDeps,
): Promise<HTMLCanvasElement | null> {
  const hit = cache.get(src);
  if (hit) return hit;
  const promise = bake(src, deps).catch(() => {
    if (cache.get(src) === promise) cache.delete(src);
    return null;
  });
  cache.set(src, promise);
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return promise;
}

export function _resetCoverBlurCacheForTests() {
  cache.clear();
}
