import { describe, it, expect } from "vitest";
import {
  shouldShowUpdateToast,
  MAX_UPDATE_TOAST_SHOWS,
  type UpdateInfo,
  type SeenUpdate,
} from "./updateToast";

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  available: true,
  current: "0.18.1",
  latest: "0.19.0",
  url: "https://github.com/lullabyX/sone/releases/tag/v0.19.0",
  ...over,
});

describe("shouldShowUpdateToast", () => {
  it("does not show when no update is available", () => {
    const r = shouldShowUpdateToast(info({ available: false }), {
      version: "",
      count: 0,
    });
    expect(r.show).toBe(false);
  });

  it("shows on first sighting of a new version and counts it", () => {
    const r = shouldShowUpdateToast(info(), { version: "", count: 0 });
    expect(r.show).toBe(true);
    expect(r.next).toEqual({ version: "0.19.0", count: 1 });
  });

  it("keeps showing until the cap, incrementing each time", () => {
    const seen: SeenUpdate = { version: "0.19.0", count: 1 };
    const r2 = shouldShowUpdateToast(info(), seen);
    expect(r2.show).toBe(true);
    expect(r2.next.count).toBe(2);
    const r3 = shouldShowUpdateToast(info(), r2.next);
    expect(r3.show).toBe(true);
    expect(r3.next.count).toBe(MAX_UPDATE_TOAST_SHOWS);
  });

  it("stops showing once the cap is reached", () => {
    const r = shouldShowUpdateToast(info(), {
      version: "0.19.0",
      count: MAX_UPDATE_TOAST_SHOWS,
    });
    expect(r.show).toBe(false);
    expect(r.next).toEqual({
      version: "0.19.0",
      count: MAX_UPDATE_TOAST_SHOWS,
    });
  });

  it("resets the counter when a newer version appears", () => {
    const r = shouldShowUpdateToast(info({ latest: "0.20.0" }), {
      version: "0.19.0",
      count: MAX_UPDATE_TOAST_SHOWS,
    });
    expect(r.show).toBe(true);
    expect(r.next).toEqual({ version: "0.20.0", count: 1 });
  });
});
