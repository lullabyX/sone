import { describe, it, expect } from "vitest";
import { isUnplayableError } from "./trackAvailability";

const api = (status: number, body = "") => ({
  kind: "Api",
  message: { status, body },
});
const sub = (code: number) => `{"status":401,"subStatus":${code}}`;

describe("isUnplayableError", () => {
  it("treats catalog-removal statuses as unplayable", () => {
    expect(isUnplayableError(api(404))).toBe(true);
    expect(isUnplayableError(api(410))).toBe(true);
    expect(isUnplayableError(api(451))).toBe(true);
  });

  it("treats a terminal playbackinfo sub-status as unplayable", () => {
    for (const code of [4005, 4010, 4030, 4031, 4032, 4034, 4035]) {
      expect(isUnplayableError(api(401, sub(code)))).toBe(true);
    }
  });

  it("keeps recoverable sub-statuses, auth, rate-limit and 5xx transient", () => {
    expect(isUnplayableError(api(401, sub(4006)))).toBe(false);
    expect(isUnplayableError(api(401, sub(4033)))).toBe(false);
    expect(isUnplayableError(api(401, sub(11003)))).toBe(false);
    expect(isUnplayableError(api(401))).toBe(false);
    expect(isUnplayableError(api(429))).toBe(false);
    expect(isUnplayableError(api(500))).toBe(false);
    expect(isUnplayableError({ kind: "Network", message: "offline" })).toBe(
      false,
    );
  });
});
