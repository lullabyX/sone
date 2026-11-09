import {
  alphaStops,
  fillLinear,
  withAlpha,
  type ColorStops,
} from "./bannerCanvas";

export interface BlobSpec {
  color: [number, number, number];
  box: { w: number; h: number; left: number; top: number };
  drift: { period: number; delay: number; stops: [number, number, number][] };
  morph: { period: number; delay: number; stops: [number, number, number][] };
  pulse: { period: number; delay: number; stops: [number, number][] };
}

export const BLOBS: readonly BlobSpec[] = [
  {
    color: [69, 10, 245],
    box: { w: 0.7975, h: 2.325, left: -0.1738, top: -0.7125 },
    drift: {
      period: 23,
      delay: 4,
      stops: [
        [0, 0, 0],
        [0.28, 15.2, 6.1],
        [0.52, 4.3, -7.4],
        [0.76, -9.6, 3.8],
        [1, 0, 0],
      ],
    },
    morph: {
      period: 19,
      delay: 7,
      stops: [
        [0, 0, 1],
        [0.37, 6, 1.14],
        [0.68, -4, 0.94],
        [1, 0, 1],
      ],
    },
    pulse: {
      period: 31,
      delay: 11,
      stops: [
        [0, 0.85],
        [0.46, 0.58],
        [1, 0.85],
      ],
    },
  },
  {
    color: [142, 45, 226],
    box: { w: 0.725, h: 2.17, left: 0.1375, top: -0.485 },
    drift: {
      period: 29,
      delay: 9,
      stops: [
        [0, 0, 0],
        [0.31, -17.4, 7.9],
        [0.58, -6.1, -5.2],
        [0.81, 9.8, 4.4],
        [1, 0, 0],
      ],
    },
    morph: {
      period: 17,
      delay: 2,
      stops: [
        [0, 0, 1],
        [0.44, -9, 1.19],
        [0.79, 5, 0.96],
        [1, 0, 1],
      ],
    },
    pulse: {
      period: 37,
      delay: 19,
      stops: [
        [0, 0.85],
        [0.53, 0.6],
        [1, 0.85],
      ],
    },
  },
  {
    color: [0, 210, 255],
    box: { w: 0.6525, h: 2.015, left: 0.3988, top: -0.5575 },
    drift: {
      period: 26,
      delay: 15,
      stops: [
        [0, 0, 0],
        [0.24, -12.7, -8.1],
        [0.49, 6.4, 5.6],
        [0.73, 13.1, -3.3],
        [1, 0, 0],
      ],
    },
    morph: {
      period: 21,
      delay: 5,
      stops: [
        [0, 0, 1],
        [0.41, 7, 1.11],
        [0.72, -6, 0.9],
        [1, 0, 1],
      ],
    },
    pulse: {
      period: 41,
      delay: 6,
      stops: [
        [0, 0.6],
        [0.48, 0.38],
        [1, 0.6],
      ],
    },
  },
];

const GRADIENT_STOPS: readonly [number, number][] = [
  [0, 1],
  [0.46, 0.98],
  [0.6, 0.84],
  [0.73, 0.5],
  [0.86, 0.16],
  [1, 0],
];

const X1 = 0.42;
const X2 = 0.58;

function bezier(s: number, p1: number, p2: number): number {
  const u = 1 - s;
  return 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s;
}

function bezierSlope(s: number, p1: number, p2: number): number {
  const u = 1 - s;
  return 3 * u * u * p1 + 6 * u * s * (p2 - p1) + 3 * s * s * (1 - p2);
}

export function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  let s = x;
  for (let i = 0; i < 8; i++) {
    s -= (bezier(s, X1, X2) - x) / bezierSlope(s, X1, X2);
  }
  return bezier(Math.min(1, Math.max(0, s)), 0, 1);
}

export function sampleStops(
  stops: number[][],
  period: number,
  delay: number,
  t: number,
): number[] {
  const phase = ((((t + delay) % period) + period) % period) / period;
  let i = 0;
  while (i < stops.length - 2 && phase > stops[i + 1][0]) i++;
  const from = stops[i];
  const to = stops[i + 1];
  const e = easeInOut((phase - from[0]) / (to[0] - from[0]));
  const out: number[] = [];
  for (let k = 1; k < from.length; k++)
    out.push(from[k] + (to[k] - from[k]) * e);
  return out;
}

export interface BlobState {
  tx: number;
  ty: number;
  deg: number;
  scale: number;
  opacity: number;
}

export function blobStateAt(spec: BlobSpec, t: number): BlobState {
  const [tx, ty] = sampleStops(
    spec.drift.stops,
    spec.drift.period,
    spec.drift.delay,
    t,
  );
  const [deg, scale] = sampleStops(
    spec.morph.stops,
    spec.morph.period,
    spec.morph.delay,
    t,
  );
  const [opacity] = sampleStops(
    spec.pulse.stops,
    spec.pulse.period,
    spec.pulse.delay,
    t,
  );
  return { tx, ty, deg, scale, opacity };
}

export interface Ctx2dLike {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(rad: number): void;
  scale(x: number, y: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  globalAlpha: number;
  fillStyle: unknown;
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): { addColorStop(o: number, c: string): void };
  createLinearGradient(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): { addColorStop(o: number, c: string): void };
}

export interface BannerOverlay {
  wash: string;
  right: ColorStops;
  bottom: ColorStops;
}

/**
 * Base-tone wash that keeps the title readable on light or dark themes, a
 * right-edge settle into the page tone and a bottom blend into the surface.
 * Null when a colour can't be parsed.
 */
export function bannerOverlay(
  base: string,
  surface: string,
): BannerOverlay | null {
  const wash = withAlpha(base, 0.6);
  const right = alphaStops(base, [
    [0, 0],
    [0.5, 0.2],
    [1, 0.6],
  ]);
  const bottom = alphaStops(surface, [
    [0, 0],
    [0.7, 0],
    [1, 1],
  ]);
  return wash && right && bottom ? { wash, right, bottom } : null;
}

export function drawBanner(
  ctx: Ctx2dLike,
  w: number,
  h: number,
  t: number,
  overlay?: BannerOverlay | null,
): void {
  ctx.clearRect(0, 0, w, h);
  for (const spec of BLOBS) {
    const bw = spec.box.w * w;
    const bh = spec.box.h * h;
    const state = blobStateAt(spec, t);
    const [r, g, b] = spec.color;

    ctx.save();
    ctx.translate(spec.box.left * w + bw / 2, spec.box.top * h + bh / 2);
    ctx.translate((state.tx / 100) * bw, (state.ty / 100) * bh);
    ctx.rotate((state.deg * Math.PI) / 180);
    ctx.scale(state.scale, state.scale);
    ctx.scale(bw / 2, bh / 2);
    ctx.globalAlpha = state.opacity;

    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    for (const [offset, alpha] of GRADIENT_STOPS) {
      gradient.addColorStop(offset, `rgba(${r}, ${g}, ${b}, ${alpha})`);
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }
  if (overlay) {
    ctx.fillStyle = overlay.wash;
    ctx.fillRect(0, 0, w, h);
    fillLinear(ctx, "right", w, h, overlay.right);
    fillLinear(ctx, "down", w, h, overlay.bottom);
  }
}
