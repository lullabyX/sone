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
  blurRGBA(id.data, w, h, BAKE_RADIUS);
  ctx.putImageData(id, 0, 0);
  return canvas;
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
    cache.delete(src);
    return null;
  });
  cache.set(src, promise);
  return promise;
}

export function _resetCoverBlurCacheForTests() {
  cache.clear();
}
