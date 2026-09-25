import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Narrowest a card may get before the grid drops a column. */
const MIN_CARD_WIDTH = 288;
/** Matches the `gap-x-6` on the home grids. */
const COLUMN_GAP = 24;
const MAX_COLUMNS = 3;

/**
 * Columns that fit in `width`. Viewport breakpoints can't answer this: the
 * sidebar is 240-340px wide and collapsible, so the window is a poor proxy
 * for what the grid actually gets.
 */
export function columnsFor(width: number): number {
  if (width <= 0) return 1;
  const fits = Math.floor((width + COLUMN_GAP) / (MIN_CARD_WIDTH + COLUMN_GAP));
  return Math.min(Math.max(fits, 1), MAX_COLUMNS);
}

/** Rows every grid fills top-to-bottom before starting the next column. */
export const GRID_ROWS = 3;

/**
 * Items the grid can hold at `columns` wide: whatever is left over would need
 * a column the width has no room for.
 */
export function fitRows<T>(items: T[], columns: number, rows = GRID_ROWS): T[] {
  return items.slice(0, Math.max(columns, 1) * rows);
}

/**
 * Measures the grid and derives its column count, so the same number drives
 * both `grid-template-columns` and the item cap and the two cannot drift.
 */
export function useGridColumns(itemCount?: number): {
  gridRef: RefObject<HTMLDivElement | null>;
  columns: number;
} {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(1);

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    // clientWidth, not getBoundingClientRect: with CSS zoom on :root the rect
    // is the visual size (layout x zoom) while ResizeObserver reports layout
    // px, and mixing the two makes the count jump on mount.
    setColumns(columnsFor(grid.clientWidth));

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      // A hidden tab reports zero — hold the last good count.
      if (!box || box.width === 0) return;
      setColumns(columnsFor(box.width));
    });
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  // Never open a column the items cannot fill: 9 items over 3 rows is 3
  // columns, and a 4th would just be dead width.
  const filled =
    itemCount === undefined
      ? columns
      : Math.min(columns, Math.max(1, Math.ceil(itemCount / GRID_ROWS)));

  return { gridRef, columns: filled };
}
