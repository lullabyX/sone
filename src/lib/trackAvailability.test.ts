import { describe, it, expect } from "vitest";
import { isUnplayableError } from "./trackAvailability";

describe("isUnplayableError", () => {
  it("accepts the classic catalog-removal statuses", () => {
    expect(isUnplayableError({ kind: "Api", message: { status: 404 } })).toBe(
      true,
    );
    expect(isUnplayableError({ kind: "Api", message: { status: 451 } })).toBe(
      true,
    );
    expect(isUnplayableError({ kind: "Api", message: { status: 500 } })).toBe(
      false,
    );
  });

  it("treats Sonos unplayable-resource faults as unplayable", () => {
    for (const code of [714, 716, 800]) {
      expect(
        isUnplayableError({ kind: "SonosUpnp", message: { code, context: "AddURIToQueue" } }),
      ).toBe(true);
    }
  });

  it("does not treat other Sonos faults as unplayable", () => {
    // 701 = transition not available — transient, must NOT trigger skip-loop.
    expect(
      isUnplayableError({ kind: "SonosUpnp", message: { code: 701, context: "Play" } }),
    ).toBe(false);
    expect(isUnplayableError({ kind: "SonosUnreachable", message: "x" })).toBe(
      false,
    );
  });

  it("handles JSON-string errors", () => {
    expect(
      isUnplayableError(
        JSON.stringify({ kind: "SonosUpnp", message: { code: 716 } }),
      ),
    ).toBe(true);
  });
});
