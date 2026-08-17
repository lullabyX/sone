import { describe, it, expect, beforeEach, vi } from "vitest";

const { clearAllCacheMock } = vi.hoisted(() => ({
  clearAllCacheMock: vi.fn(),
}));
vi.mock("../api/tidal", () => ({ clearAllCache: clearAllCacheMock }));

import { refreshApp } from "./refreshApp";

describe("refreshApp", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearAllCacheMock.mockReset();
    reload = vi.fn();
    // jsdom's location.reload is non-writable — redefine it.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });
  });

  it("clears every cache before reloading", async () => {
    const order: string[] = [];
    clearAllCacheMock.mockImplementation(async () => {
      order.push("clear");
    });
    reload.mockImplementation(() => order.push("reload"));

    await refreshApp();

    expect(clearAllCacheMock).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["clear", "reload"]);
  });

  it("still reloads when clearing rejects", async () => {
    clearAllCacheMock.mockRejectedValue(new Error("backend down"));
    await refreshApp();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
