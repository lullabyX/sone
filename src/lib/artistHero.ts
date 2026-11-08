import {
  alphaStops,
  createCanvas as defaultCreateCanvas,
  fadeBottom,
  fillLinear,
  loadImage as defaultLoadImage,
  sizeCanvasToBox,
} from "./bannerCanvas";
import { blurRGBA } from "./imageBlur";

const COPIES = 3; // on each side of the centre copy
const FLANK_DARKEN = 0.68; // brightness(0.32)
// blur-2xl (40px) on the 480px-tall hero, as a fraction of the image height.
export const LOW_RES_BLUR = 40 / 480;
const FADE_START = 0.6;
const SCRIM_UP: [number, number][] = [
  [0, 0.85],
  [0.5, 0.25],
  [1, 0],
];
const SCRIM_RIGHT: [number, number][] = [
  [0, 0.5],
  [1, 0],
];

type Drawable = CanvasImageSource & { width: number; height: number };

export interface HeroImage {
  img: Drawable;
  blurred: boolean;
}

export interface HeroDeps {
  loadImage(src: string): Promise<HTMLImageElement>;
  createCanvas(w: number, h: number): HTMLCanvasElement;
}

const defaultDeps: HeroDeps = {
  loadImage: defaultLoadImage,
  createCanvas: defaultCreateCanvas,
};

/** Three box passes of radius r give a gaussian with sigma² = r(r + 1). */
export function blurRadiusFor(sigma: number): number {
  return Math.max(1, Math.round(Math.sqrt(sigma * sigma + 0.25) - 0.5));
}

/**
 * Blurs the image at its own size, wrapping horizontally so the stitched
 * copies blur into each other without seams.
 */
export function blurHeroSource(
  img: Drawable,
  createCanvas: HeroDeps["createCanvas"] = defaultDeps.createCanvas,
): HTMLCanvasElement | null {
  const w = img.width;
  const h = img.height;
  const r = blurRadiusFor(h * LOW_RES_BLUR);
  const p = Math.min(w, 3 * r);
  const pw = w + 2 * p;
  const padded = createCanvas(pw, h);
  const pctx = padded.getContext("2d");
  const out = createCanvas(w, h);
  const octx = out.getContext("2d");
  if (!pctx || !octx) return null;
  for (const x of [p - w, p, p + w]) pctx.drawImage(img, x, 0, w, h);
  const id = pctx.getImageData(0, 0, pw, h);
  blurRGBA(id.data, pw, h, r);
  pctx.putImageData(id, 0, 0);
  octx.drawImage(padded, p, 0, w, h, 0, 0, w, h);
  return out;
}

/** Loads a hero source; the low-res stage is blurred once here, never per paint. */
export async function loadHeroImage(
  src: string,
  blurred: boolean,
  deps: HeroDeps = defaultDeps,
): Promise<HeroImage> {
  const img = await deps.loadImage(src);
  if (!blurred) return { img, blurred };
  try {
    const soft = blurHeroSource(img, deps.createCanvas);
    if (soft) return { img: soft, blurred };
  } catch {
    // Fall through to the unblurred image.
  }
  return { img, blurred: false };
}

/**
 * Copies of the artist image stitched edge to edge at full height, the centre
 * one bright and the flanking ones darkened, faded out at the bottom, then the
 * two base-tone legibility scrims on top. Without an image only the scrims are
 * painted.
 */
export function paintArtistHero(
  target: HTMLCanvasElement,
  hero: HeroImage | null,
  boxW: number,
  boxH: number,
  base: string,
) {
  if (!boxW || !boxH) return;
  const { w, h } = sizeCanvasToBox(target, boxW, boxH);
  const ctx = target.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  if (hero && hero.img.width && hero.img.height) {
    const cw = Math.max(1, Math.round((h * hero.img.width) / hero.img.height));
    const x0 = Math.round((w - cw) / 2);
    for (let k = -COPIES; k <= COPIES; k++) {
      ctx.drawImage(hero.img, x0 + k * cw, 0, cw, h);
    }
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    const shade = `rgba(0, 0, 0, ${FLANK_DARKEN})`;
    if (hero.blurred) {
      // The darkening edge is blurred along with the art.
      const s = (2 * h * LOW_RES_BLUR) / w;
      const l = x0 / w;
      const r = (x0 + cw) / w;
      const at = (o: number) => Math.min(1, Math.max(0, o));
      fillLinear(ctx, "right", w, h, [
        [at(l - s), shade],
        [at(l + s), "rgba(0, 0, 0, 0)"],
        [at(r - s), "rgba(0, 0, 0, 0)"],
        [at(r + s), shade],
      ]);
    } else {
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, x0, h);
      ctx.fillRect(x0 + cw, 0, w - x0 - cw, h);
    }
    ctx.restore();
    fadeBottom(ctx, w, h, FADE_START);
  }

  const up = alphaStops(base, SCRIM_UP);
  const right = alphaStops(base, SCRIM_RIGHT);
  if (up && right) {
    fillLinear(ctx, "up", w, h, up);
    fillLinear(ctx, "right", w, h, right);
  }
}
