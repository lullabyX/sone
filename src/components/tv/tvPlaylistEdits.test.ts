import { describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ invalidateCache: vi.fn() }));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()),
  ...api,
}));

import {
  playlistBusy,
  playlistRevision,
  playlistSettled,
  queuePlaylistEdit,
} from "./tvPlaylistEdits";
import { deferred, setupTvTest } from "./tvTestUtils";

setupTvTest();

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("playlist writes", () => {
  it("go out one at a time, in order, and bump the revision when queued", async () => {
    const sent: string[] = [];
    const first = deferred<void>();
    expect(playlistRevision("p")).toBe(0);
    const a = queuePlaylistEdit("p", async () => {
      sent.push("a");
      await first.promise;
    });
    const b = queuePlaylistEdit("p", async () => {
      sent.push("b");
    });
    expect(playlistRevision("p")).toBe(2);
    expect(playlistRevision("q")).toBe(0);
    expect(playlistBusy("p")).toBe(true);
    await flush();
    expect(sent).toEqual(["a"]);
    first.resolve();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(sent).toEqual(["a", "b"]);
    expect(playlistBusy("p")).toBe(false);
    expect(playlistRevision("p")).toBe(2);
  });

  it("a failure drops the removals queued before it, not later writes, and marks the list changed", async () => {
    const sent: string[] = [];
    const fail = deferred<void>();
    const a = queuePlaylistEdit("p", () => fail.promise, { positional: true });
    const b = queuePlaylistEdit("p", async () => void sent.push("b"), {
      positional: true,
    });
    const add = queuePlaylistEdit("p", async () => void sent.push("add"));
    fail.reject(new Error("x"));
    await expect(a).rejects.toThrow("x");
    expect(await b).toBe(false);
    expect(await add).toBe(true);
    expect(sent).toEqual(["add"]);
    expect(playlistRevision("p")).toBe(4);
    expect(api.invalidateCache).toHaveBeenCalledWith("playlist:p");
    const c = queuePlaylistEdit("p", async () => void sent.push("c"), {
      positional: true,
    });
    expect(await c).toBe(true);
  });

  it("settles once every queued write has landed, including ones queued meanwhile", async () => {
    const one = deferred<void>();
    const two = deferred<void>();
    void queuePlaylistEdit("p", () => one.promise);
    let settled = false;
    void playlistSettled("p").then(() => (settled = true));
    void queuePlaylistEdit("p", () => two.promise);
    one.resolve();
    await flush();
    expect(settled).toBe(false);
    two.resolve();
    await flush();
    expect(settled).toBe(true);
    await expect(playlistSettled("never-written")).resolves.toBeUndefined();
  });
});
