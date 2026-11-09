export interface GradientStop {
  offset: number;
  color: string;
}

const MAX_ENTRIES = 32;
const cache = new Map<string, string>();

export function gradientDataUrl(
  stops: GradientStop[],
  direction: "vertical" | "horizontal",
  size = 256,
): string | null {
  const key = JSON.stringify([stops, direction, size]);
  const hit = cache.get(key);
  if (hit) return hit;
  const vertical = direction === "vertical";
  const canvas = document.createElement("canvas");
  canvas.width = vertical ? 1 : size;
  canvas.height = vertical ? size : 1;
  let url: string;
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const g = vertical
      ? ctx.createLinearGradient(0, 0, 0, size)
      : ctx.createLinearGradient(0, 0, size, 0);
    // addColorStop throws on a colour it can't parse.
    for (const s of stops) g.addColorStop(s.offset, s.color);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    url = canvas.toDataURL("image/png");
  } catch {
    return null;
  }
  cache.set(key, url);
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return url;
}

export function _resetGradientCacheForTests() {
  cache.clear();
}
