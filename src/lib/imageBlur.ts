// One separable box-blur pass (horizontal or vertical) over RGBA pixels, using a
// sliding running-sum so cost is O(pixels) regardless of radius. Edges clamped.
export function boxBlurPass(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
  horizontal: boolean,
) {
  const div = radius * 2 + 1;
  const lineLen = horizontal ? w : h;
  const lineCount = horizontal ? h : w;
  const stride = horizontal ? 4 : w * 4; // step between pixels along a line
  const lineStep = horizontal ? w * 4 : 4; // step between lines
  const line = new Float32Array(lineLen * 4);
  for (let l = 0; l < lineCount; l++) {
    const base = l * lineStep;
    let sr = 0,
      sg = 0,
      sb = 0,
      sa = 0;
    for (let i = -radius; i <= radius; i++) {
      const p = base + Math.min(lineLen - 1, Math.max(0, i)) * stride;
      sr += data[p];
      sg += data[p + 1];
      sb += data[p + 2];
      sa += data[p + 3];
    }
    for (let x = 0; x < lineLen; x++) {
      line[x * 4] = sr / div;
      line[x * 4 + 1] = sg / div;
      line[x * 4 + 2] = sb / div;
      line[x * 4 + 3] = sa / div;
      const pOut =
        base + Math.min(lineLen - 1, Math.max(0, x - radius)) * stride;
      const pIn =
        base + Math.min(lineLen - 1, Math.max(0, x + radius + 1)) * stride;
      sr += data[pIn] - data[pOut];
      sg += data[pIn + 1] - data[pOut + 1];
      sb += data[pIn + 2] - data[pOut + 2];
      sa += data[pIn + 3] - data[pOut + 3];
    }
    for (let x = 0; x < lineLen; x++) {
      const p = base + x * stride;
      data[p] = line[x * 4];
      data[p + 1] = line[x * 4 + 1];
      data[p + 2] = line[x * 4 + 2];
      data[p + 3] = line[x * 4 + 3];
    }
  }
}

// Dependency-free near-gaussian blur: 3 box passes per axis (central-limit
// theorem ≈ gaussian). Runs ONCE per track, never on the per-frame paint path.
export function blurRGBA(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  radius: number,
) {
  if (radius < 1) return;
  for (let pass = 0; pass < 3; pass++) {
    boxBlurPass(data, w, h, radius, true);
    boxBlurPass(data, w, h, radius, false);
  }
}

export function saturateRGBA(data: Uint8ClampedArray, factor: number) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    data[i] = luma + (r - luma) * factor;
    data[i + 1] = luma + (g - luma) * factor;
    data[i + 2] = luma + (b - luma) * factor;
  }
}
