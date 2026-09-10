import { describe, it, expect } from "vitest";
import { fitCoverSize, MAX_COVER_SIZE } from "./coverFit";

describe("fitCoverSize", () => {
  it("fills the width when the column is tall and narrow", () => {
    expect(fitCoverSize({ width: 300, height: 900, textHeight: 50 })).toBe(300);
  });

  it("leaves room for the gap and the title block when the column is short", () => {
    expect(
      fitCoverSize({ width: 900, height: 300, textHeight: 50, gap: 24 }),
    ).toBe(226);
  });

  it("stops growing at the maximum cover size", () => {
    expect(fitCoverSize({ width: 1200, height: 1200, textHeight: 50 })).toBe(
      MAX_COVER_SIZE,
    );
  });

  it("floors fractional space to whole pixels", () => {
    expect(fitCoverSize({ width: 300.7, height: 900, textHeight: 50 })).toBe(
      300,
    );
  });

  it("never returns a negative size when the column is tiny", () => {
    expect(fitCoverSize({ width: 100, height: 40, textHeight: 50 })).toBe(0);
  });
});
