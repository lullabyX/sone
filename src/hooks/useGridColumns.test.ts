import { describe, it, expect } from "vitest";
import { columnsFor, fitRows, GRID_ROWS } from "./useGridColumns";

describe("columnsFor", () => {
  it("gives 3 columns at the measured grid width", () => {
    // 937px: the real figure off the probe, at the app's 1.5 zoom.
    expect(columnsFor(937)).toBe(3);
  });

  it("counts by the width the grid actually has", () => {
    expect(columnsFor(288)).toBe(1);
    expect(columnsFor(600)).toBe(2);
    expect(columnsFor(912)).toBe(3);
    expect(columnsFor(1224)).toBe(3);
  });

  it("holds each column at the boundary below", () => {
    expect(columnsFor(599)).toBe(1);
    expect(columnsFor(911)).toBe(2);
    expect(columnsFor(1223)).toBe(3);
  });

  it("never exceeds three columns however wide it gets", () => {
    expect(columnsFor(4000)).toBe(3);
  });

  it("stays at one column for an unmeasured or hidden grid", () => {
    expect(columnsFor(0)).toBe(1);
    expect(columnsFor(-1)).toBe(1);
  });

  it("never returns a count whose cards fall under the minimum", () => {
    for (let width = 1; width <= 3000; width++) {
      const columns = columnsFor(width);
      if (columns > 1) {
        const card = (width - (columns - 1) * 24) / columns;
        expect(card).toBeGreaterThanOrEqual(288);
      }
    }
  });
});

describe("fitRows", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("fills three rows per column", () => {
    expect(GRID_ROWS).toBe(3);
  });

  it("keeps a short section whole instead of trimming it to one row", () => {
    // The three track shelves arrive with exactly 5 items.
    expect(fitRows(items(5), 3)).toHaveLength(5);
    expect(fitRows(items(5), 4)).toHaveLength(5);
    expect(fitRows(items(5), 1)).toHaveLength(3);
  });

  it("caps a long section at rows times columns", () => {
    // "Recently played": 10 items at 3 columns is the 3x3 grid.
    expect(fitRows(items(10), 3)).toHaveLength(9);
    expect(fitRows(items(10), 4)).toHaveLength(10);
    expect(fitRows(items(30), 4)).toHaveLength(12);
  });

  it("never drops an item the grid has room for", () => {
    for (let columns = 1; columns <= 4; columns++) {
      for (let count = 0; count <= 16; count++) {
        expect(fitRows(items(count), columns)).toHaveLength(
          Math.min(count, columns * 3),
        );
      }
    }
  });

  it("treats an unmeasured grid as one column", () => {
    expect(fitRows(items(10), 0)).toHaveLength(3);
  });
});

describe("column count against item count", () => {
  const fill = (widthColumns: number, itemCount: number) =>
    Math.min(widthColumns, Math.max(1, Math.ceil(itemCount / 3)));

  it("never opens a column the items cannot fill", () => {
    // 9 items over 3 rows is exactly 3 columns — a 4th would be dead width.
    expect(fill(3, 9)).toBe(3);
    expect(fill(3, 5)).toBe(2);
    expect(fill(3, 9)).toBe(3);
  });

  it("uses the full width when there are enough items", () => {
    expect(fill(3, 12)).toBe(3);
    expect(fill(3, 20)).toBe(3);
  });

  it("keeps one column for an empty or tiny section", () => {
    expect(fill(3, 0)).toBe(1);
    expect(fill(3, 1)).toBe(1);
  });

  it("leaves no empty column for any count at any width", () => {
    for (let widthColumns = 1; widthColumns <= 3; widthColumns++) {
      for (let count = 1; count <= 24; count++) {
        const columns = fill(widthColumns, count);
        const shown = Math.min(count, columns * 3);
        expect(Math.ceil(shown / 3)).toBe(columns);
      }
    }
  });
});
