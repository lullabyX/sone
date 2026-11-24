import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  acquireVideoCover,
  releaseVideoCover,
  _resetVideoCoverCache,
} from "./videoCoverCache";

const MB = 1024 * 1024;
let n = 0;

beforeEach(() => {
  _resetVideoCoverCache();
  invoke.mockReset();
  invoke.mockImplementation(() => Promise.resolve(new ArrayBuffer(40 * MB)));
  URL.createObjectURL = vi.fn(() => `blob:${++n}`);
  URL.revokeObjectURL = vi.fn();
});

describe("videoCoverCache", () => {
  it("fetches each url once and shares the blob", async () => {
    const [a, b] = await Promise.all([
      acquireVideoCover("u1"),
      acquireVideoCover("u1"),
    ]);
    expect(a).toBe(b);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("never revokes a blob that is still in use", async () => {
    const inUse = await acquireVideoCover("u1");
    await acquireVideoCover("u2");
    releaseVideoCover("u2");
    await acquireVideoCover("u3"); // 120 MB total, over the cap
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(inUse);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it("evicts the least recently used idle blob over the cap", async () => {
    const u1 = await acquireVideoCover("u1");
    releaseVideoCover("u1");
    await acquireVideoCover("u2");
    releaseVideoCover("u2");
    await acquireVideoCover("u3");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(u1);
    await acquireVideoCover("u1");
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it("retries after a failed fetch", async () => {
    invoke.mockRejectedValueOnce(new Error("offline"));
    await expect(acquireVideoCover("u1")).rejects.toThrow("offline");
    await expect(acquireVideoCover("u1")).resolves.toMatch(/^blob:/);
  });
});
