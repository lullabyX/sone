import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { trackRenderMode } from "./renderMode";

const flagged = () =>
  document.documentElement.classList.contains("software-rendering");

beforeEach(() => {
  invoke.mockReset();
  document.documentElement.classList.remove("software-rendering");
});

describe("trackRenderMode", () => {
  it("flags the document when WebKit paints without compositing", async () => {
    invoke.mockResolvedValue(true);
    await trackRenderMode();
    expect(invoke).toHaveBeenCalledWith("is_software_rendering");
    expect(flagged()).toBe(true);
  });

  it("leaves animations on when compositing is available", async () => {
    document.documentElement.classList.add("software-rendering");
    invoke.mockResolvedValue(false);
    await trackRenderMode();
    expect(flagged()).toBe(false);
  });

  it("leaves animations on when the backend cannot answer", async () => {
    invoke.mockRejectedValue(new Error("unknown command"));
    await expect(trackRenderMode()).resolves.toBeUndefined();
    expect(flagged()).toBe(false);
  });
});
