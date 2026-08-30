import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  NAV_SESSION,
  clearAllOffsets,
  clearOffset,
  getOffset,
  pushView,
  replaceView,
  saveOffset,
  scrollKey,
} from "./scrollMemory";
import type { AppView } from "../types";

describe("scrollKey", () => {
  it("returns null for an unstamped view", () => {
    expect(scrollKey({ type: "home" })).toBe(null);
  });

  it("returns null for a view stamped by a previous app run", () => {
    const stale: AppView = {
      type: "home",
      __navId: 3,
      __navSession: "some-other-run",
    };
    expect(scrollKey(stale)).toBe(null);
  });

  it("composes the id with an empty tab segment when no tab is set", () => {
    const view: AppView = {
      type: "home",
      __navId: 3,
      __navSession: NAV_SESSION,
    };
    expect(scrollKey(view)).toBe("3:");
  });

  it("includes the tab so each tab of one entry gets its own offset", () => {
    const view: AppView = {
      type: "search",
      query: "q",
      tab: "albums",
      __navId: 3,
      __navSession: NAV_SESSION,
    };
    expect(scrollKey(view)).toBe("3:albums");
  });
});

describe("offset store", () => {
  beforeEach(() => {
    clearAllOffsets();
  });

  it("round-trips a saved offset", () => {
    saveOffset("1:", 640);
    expect(getOffset("1:")).toBe(640);
  });

  it("returns undefined for a key that was never saved", () => {
    expect(getOffset("nope")).toBe(undefined);
  });

  it("clears a single key without touching the others", () => {
    saveOffset("1:", 10);
    saveOffset("2:", 20);
    clearOffset("1:");
    expect(getOffset("1:")).toBe(undefined);
    expect(getOffset("2:")).toBe(20);
  });

  it("evicts the oldest entry past the 50-entry cap", () => {
    for (let i = 1; i <= 50; i++) saveOffset(`${i}:`, i);
    saveOffset("51:", 51);
    expect(getOffset("1:")).toBe(undefined);
    expect(getOffset("2:")).toBe(2);
    expect(getOffset("51:")).toBe(51);
  });

  it("refreshes recency on re-save so an active entry is not evicted", () => {
    for (let i = 1; i <= 50; i++) saveOffset(`${i}:`, i);
    saveOffset("1:", 999);
    saveOffset("51:", 51);
    expect(getOffset("1:")).toBe(999);
    expect(getOffset("2:")).toBe(undefined);
  });
});

describe("history helpers", () => {
  beforeEach(() => {
    clearAllOffsets();
  });

  it("pushView stamps the view with the current session and a fresh id", () => {
    const spy = vi
      .spyOn(window.history, "pushState")
      .mockImplementation(() => {});
    const first = pushView({ type: "home" });
    const second = pushView({ type: "favorites" });

    expect(first.__navSession).toBe(NAV_SESSION);
    expect(second.__navId).toBeGreaterThan(first.__navId!);
    expect(spy).toHaveBeenLastCalledWith(second, "");
    spy.mockRestore();
  });

  it("gives a re-pushed page a fresh empty key while the earlier entry keeps its offset", () => {
    const spy = vi
      .spyOn(window.history, "pushState")
      .mockImplementation(() => {});
    const first = pushView({ type: "album", albumId: 1 });
    saveOffset(scrollKey(first)!, 500);

    const second = pushView({ type: "album", albumId: 1 });

    expect(scrollKey(second)).not.toBe(scrollKey(first));
    expect(getOffset(scrollKey(second)!)).toBe(undefined);
    expect(getOffset(scrollKey(first)!)).toBe(500);
    spy.mockRestore();
  });

  it("replaceView stamps a fresh id so the entry cannot inherit a stale offset", () => {
    const pushSpy = vi
      .spyOn(window.history, "pushState")
      .mockImplementation(() => {});
    const replaceSpy = vi
      .spyOn(window.history, "replaceState")
      .mockImplementation(() => {});

    const pushed = pushView({ type: "playlist", playlistId: "p1" });
    saveOffset(scrollKey(pushed)!, 800);
    const replaced = replaceView({ type: "home" });

    expect(replaced.__navId).toBeGreaterThan(pushed.__navId!);
    expect(getOffset(scrollKey(replaced)!)).toBe(undefined);
    expect(replaceSpy).toHaveBeenCalledWith(replaced, "");
    pushSpy.mockRestore();
    replaceSpy.mockRestore();
  });
});
