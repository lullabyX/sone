import { describe, expect, it } from "vitest";
import { pickNext, type Box } from "./spatialNav";

const box = (left: number, top: number, w = 100, h = 100): Box => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});

describe("pickNext", () => {
  // Two rows of three cards:
  //   0 1 2
  //   3 4 5
  const grid = [
    box(0, 0),
    box(120, 0),
    box(240, 0),
    box(0, 120),
    box(120, 120),
    box(240, 120),
  ];

  it("moves to the adjacent card in each direction", () => {
    const from = grid[4];
    const others = grid.filter((_, i) => i !== 4);
    const at = (dir: Parameters<typeof pickNext>[2]) =>
      grid.indexOf(others[pickNext(from, others, dir)]);
    expect(at("left")).toBe(3);
    expect(at("right")).toBe(5);
    expect(at("up")).toBe(1);
    expect(at("down")).toBe(-1);
  });

  it("returns -1 when nothing lies in that direction", () => {
    expect(pickNext(grid[0], grid.slice(1), "left")).toBe(-1);
    expect(pickNext(grid[0], grid.slice(1), "up")).toBe(-1);
  });

  it("prefers a candidate straight ahead over a nearer one off to the side", () => {
    const from = box(0, 0);
    const ahead = box(0, 400);
    const diagonal = box(300, 150);
    expect(pickNext(from, [diagonal, ahead], "down")).toBe(1);
  });

  it("moving down from a narrow item picks the overlapping wide one", () => {
    const from = box(500, 0, 50, 50);
    const wide = box(0, 100, 1000, 60);
    const narrowFar = box(900, 70, 50, 50);
    expect(pickNext(from, [narrowFar, wide], "down")).toBe(1);
  });

  it("does not treat a card below a wider one as lying to its side", () => {
    const banner = box(180, 110, 360, 260);
    const cardBelow = box(180, 550, 228, 228);
    expect(pickNext(banner, [cardBelow], "left")).toBe(-1);
    expect(pickNext(banner, [cardBelow], "down")).toBe(0);
    expect(pickNext(cardBelow, [banner], "right")).toBe(-1);
    expect(pickNext(cardBelow, [banner], "up")).toBe(0);
  });
});
