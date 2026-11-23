/** How much a desktop dialog hosted in TV mode is scaled up: its smallest
 *  (9.5px) labels reach 16px at 1080p, never below its desktop size, and it
 *  stays inside the screen margin. */
export function tvNativeZoom(
  rem: number,
  viewportW: number,
  dialogW: number,
  overscanPct = 0,
): number {
  return Math.max(
    1,
    Math.min(
      rem / 14,
      (viewportW * (0.95 - (2 * overscanPct) / 100)) / dialogW,
    ),
  );
}

/** The tallest the hosted dialog may be, in its own (unzoomed) CSS px, to
 *  fit the screen height inside the margin. */
export function tvNativeFitHeight(
  viewportH: number,
  zoom: number,
  overscanPct: number,
): number {
  return (viewportH * (0.94 - (2 * overscanPct) / 100)) / zoom;
}
