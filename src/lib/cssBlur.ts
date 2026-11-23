/** The box passes (pixels left and right of the output pixel) that the
 *  Filter Effects spec uses to approximate a gaussian of `sigma` pixels:
 *  d = floor(σ·3·√(2π)/4 + 0.5); three of size d if d is odd, else two of
 *  size d half a pixel left and right and one of size d + 1. */
export function cssBlurPasses(sigma: number): [number, number][] {
  const d = Math.floor((sigma * 3 * Math.sqrt(2 * Math.PI)) / 4 + 0.5);
  if (d < 2) return [];
  if (d % 2 === 1) {
    const r = (d - 1) / 2;
    return [
      [r, r],
      [r, r],
      [r, r],
    ];
  }
  const h = d / 2;
  return [
    [h, h - 1],
    [h - 1, h],
    [h, h],
  ];
}

/** One box pass along every row (or column) of a premultiplied RGBA float
 *  image, transparent beyond its edges. */
function boxPass(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  [left, right]: [number, number],
  horizontal: boolean,
) {
  const size = left + right + 1;
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const step = horizontal ? 4 : w * 4;
  const lineStep = horizontal ? w * 4 : 4;
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let i = -left; i <= right; i++) {
        if (i >= 0 && i < len) sum += src[base + i * step + c];
      }
      for (let x = 0; x < len; x++) {
        dst[base + x * step + c] = sum / size;
        const enter = x + right + 1;
        const leave = x - left;
        if (enter < len) sum += src[base + enter * step + c];
        if (leave >= 0) sum -= src[base + leave * step + c];
      }
    }
  }
}

/** CSS `blur(sigma)` in place on unpremultiplied RGBA (as from
 *  getImageData), blurring premultiplied colour as the browser does. */
export function cssBlurRGBA(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  sigma: number,
): void {
  const passes = cssBlurPasses(sigma);
  if (passes.length === 0) return;
  let a = new Float32Array(data.length);
  let b = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    a[i] = data[i] * alpha;
    a[i + 1] = data[i + 1] * alpha;
    a[i + 2] = data[i + 2] * alpha;
    a[i + 3] = data[i + 3];
  }
  for (const horizontal of [true, false]) {
    for (const pass of passes) {
      boxPass(a, b, w, h, pass, horizontal);
      [a, b] = [b, a];
    }
  }
  for (let i = 0; i < data.length; i += 4) {
    const alpha = a[i + 3];
    const k = alpha > 0 ? 255 / alpha : 0;
    data[i] = a[i] * k;
    data[i + 1] = a[i + 1] * k;
    data[i + 2] = a[i + 2] * k;
    data[i + 3] = alpha;
  }
}
