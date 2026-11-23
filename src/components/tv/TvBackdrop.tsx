import { useEffect, useRef } from "react";
import { fetchCachedImageUrl } from "../TidalImage";
import { cssBlurRGBA } from "../../lib/cssBlur";
import { alphaStops, fillLinear } from "../../lib/bannerCanvas";
import { useDerivedTheme } from "../../hooks/useDerivedTheme";

/** The CSS blur radius this backdrop reproduces. */
const BLUR_REM = 1.2;
/** The blur, in baked pixels, the bake is scaled down to. */
const BAKE_SIGMA = 6;

/** Draws `src` as `object-fit: cover` into a w×h canvas and blurs it like
 *  CSS `blur(sigma)`; null when the image can't be loaded. */
async function bakeBlur(
  src: string,
  w: number,
  h: number,
  sigma: number,
): Promise<HTMLCanvasElement | null> {
  const img = new Image();
  img.src = await fetchCachedImageUrl(src);
  await img.decode();
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx || !img.naturalWidth || !img.naturalHeight) return null;
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  const pixels = ctx.getImageData(0, 0, w, h);
  cssBlurRGBA(pixels.data, w, h, sigma);
  ctx.putImageData(pixels, 0, 0);
  return out;
}

/** The CSS backdrop this reproduces: the cover blurred, zoomed 1.25× at 35%
 *  over the base colour, faded to the base colour from the middle down. */
const ZOOM = 1.25;
const STRENGTH = 0.35;
const FADE: [number, number][] = [
  [0, 0],
  [0.5, 0.6],
  [1, 1],
];

/**
 * Now Playing's blurred cover backdrop, drawn once into one opaque canvas.
 * As CSS (a `blur()` under a gradient) it was redrawn on every repaint above
 * it (each video frame, the progress bar), holding the screen to ~10 fps.
 * The last picture stays up until the next is ready.
 */
export default function TvBackdrop({ src }: { src?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { bgBase } = useDerivedTheme();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (!src) {
      canvas.width = 0;
      return;
    }
    let run = 0;
    let wanted = "";
    const bake = async () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      const rem = parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const sigma = BLUR_REM * rem * dpr;
      const key = `${w}x${h}@${sigma}`;
      if (!w || !h || key === wanted) return;
      wanted = key;
      const id = ++run;
      // A blur this wide keeps no fine detail, so it is baked at a fraction
      // of the size (blurring ~BAKE_SIGMA px) and stretched by the compositor.
      const f = Math.max(1, Math.floor(sigma / BAKE_SIGMA));
      const bw = Math.ceil(w / f);
      const bh = Math.ceil(h / f);
      const blurred = await bakeBlur(src, bw, bh, sigma / f).catch(() => null);
      const fade = alphaStops(bgBase, FADE);
      if (!blurred || !fade || id !== run) return;
      canvas.width = bw;
      canvas.height = bh;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = bgBase;
      ctx.fillRect(0, 0, bw, bh);
      ctx.globalAlpha = STRENGTH;
      const zw = bw * ZOOM;
      const zh = bh * ZOOM;
      ctx.drawImage(blurred, (bw - zw) / 2, (bh - zh) / 2, zw, zh);
      ctx.globalAlpha = 1;
      fillLinear(ctx, "down", bw, bh, fade);
    };
    void bake();
    let frame = 0;
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => void bake());
          });
    resize?.observe(canvas);
    return () => {
      run++;
      cancelAnimationFrame(frame);
      resize?.disconnect();
    };
  }, [src, bgBase]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-0 w-full h-full"
    />
  );
}
