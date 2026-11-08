export type ColorStops = readonly (readonly [number, string])[];

export interface LinearGradientCtx {
  createLinearGradient(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): { addColorStop(offset: number, color: string): void };
  fillRect(x: number, y: number, w: number, h: number): void;
  fillStyle: unknown;
}

/** `#rgb`/`#rrggbb` to `rgba()`; null when the colour can't be parsed. */
export function withAlpha(hex: string, alpha: number): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h =
    m[1].length === 3
      ? m[1]
          .split("")
          .map((c) => c + c)
          .join("")
      : m[1];
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Stops of one colour at varying alpha; null when the colour can't be parsed. */
export function alphaStops(
  hex: string,
  stops: readonly (readonly [number, number])[],
): ColorStops | null {
  const out: [number, string][] = [];
  for (const [offset, alpha] of stops) {
    const color = withAlpha(hex, alpha);
    if (!color) return null;
    out.push([offset, color]);
  }
  return out;
}

/** Fills the whole canvas with a linear gradient running in `direction`. */
export function fillLinear(
  ctx: LinearGradientCtx,
  direction: "down" | "up" | "right",
  w: number,
  h: number,
  stops: ColorStops,
) {
  const g =
    direction === "right"
      ? ctx.createLinearGradient(0, 0, w, 0)
      : direction === "down"
        ? ctx.createLinearGradient(0, 0, 0, h)
        : ctx.createLinearGradient(0, h, 0, 0);
  for (const [offset, color] of stops) g.addColorStop(offset, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** Opaque down to `fadeStart` of the height, then linear to transparent at the bottom. */
export function fadeBottom(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  fadeStart: number,
) {
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  fillLinear(ctx, "down", w, h, [
    [0, "rgba(0, 0, 0, 1)"],
    [fadeStart, "rgba(0, 0, 0, 1)"],
    [1, "rgba(0, 0, 0, 0)"],
  ]);
  ctx.restore();
}

/** Sizes the backing store to the CSS box at device resolution. */
export function sizeCanvasToBox(
  canvas: HTMLCanvasElement,
  boxW: number,
  boxH: number,
): { w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(boxW * dpr));
  const h = Math.max(1, Math.round(boxH * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return { w, h };
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}
