import { describe, it, expect } from "vitest";
import { findActiveLine, type LrcLine } from "./lrc";

const lines: LrcLine[] = [
  { time: 1, text: "One" },
  { time: 5, text: "Two" },
  { time: 9, text: "Three" },
];

describe("findActiveLine", () => {
  it("returns -1 with no lines", () => {
    expect(findActiveLine([], 3)).toBe(-1);
  });

  it("returns -1 before the first line", () => {
    expect(findActiveLine(lines, 0.5)).toBe(-1);
  });

  it("activates a line exactly at its timestamp", () => {
    expect(findActiveLine(lines, 5)).toBe(1);
  });

  it("keeps a line active until the next one starts", () => {
    expect(findActiveLine(lines, 8.99)).toBe(1);
  });

  it("holds the last line past the end", () => {
    expect(findActiveLine(lines, 300)).toBe(2);
  });
});
