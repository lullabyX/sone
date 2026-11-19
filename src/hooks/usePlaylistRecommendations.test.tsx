import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { mkTrack, range } from "../components/tv/tvTestUtils";
import type { Track } from "../types";

const api = vi.hoisted(() => ({
  getPlaylistRecommendations: vi.fn(),
  invalidateCache: vi.fn(),
}));

vi.mock("../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tidal")>()),
  ...api,
}));

import { usePlaylistRecommendations } from "./usePlaylistRecommendations";

const ids = (ts: Track[]) => ts.map((t) => t.id);

describe("usePlaylistRecommendations", () => {
  beforeEach(() => {
    for (const m of Object.values(api)) m.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("pages 10 at a time, fetches the next batch, wraps when empty", async () => {
    const recs = range(25).map((i) => mkTrack(i + 1));
    api.getPlaylistRecommendations
      .mockResolvedValueOnce({ items: recs })
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: recs });
    const { result } = renderHook(() => usePlaylistRecommendations("p"));
    await waitFor(() =>
      expect(ids(result.current.visible)).toEqual(range(10).map((i) => i + 1)),
    );
    await act(() => result.current.refresh());
    await act(() => result.current.refresh());
    expect(ids(result.current.visible)).toEqual([21, 22, 23, 24, 25]);
    await act(() => result.current.refresh());
    expect(api.getPlaylistRecommendations).toHaveBeenNthCalledWith(
      2,
      "p",
      50,
      50,
    );
    expect(ids(result.current.visible)).toEqual(range(10).map((i) => i + 1));
  });

  it("removeLocal hides a track and restore brings it back once", async () => {
    api.getPlaylistRecommendations.mockResolvedValue({
      items: range(5).map((i) => mkTrack(i + 1)),
    });
    const { result } = renderHook(() => usePlaylistRecommendations("p"));
    await waitFor(() =>
      expect(ids(result.current.visible)).toEqual([1, 2, 3, 4, 5]),
    );

    act(() => result.current.removeLocal(3));
    expect(ids(result.current.visible)).toEqual([1, 2, 4, 5]);

    act(() => result.current.restore(mkTrack(3)));
    act(() => result.current.restore(mkTrack(3)));
    expect(ids(result.current.visible)).toEqual([1, 2, 4, 5, 3]);
  });

  it("fetches nothing for an empty id", async () => {
    const { result } = renderHook(() => usePlaylistRecommendations(""));
    await act(async () => {});
    expect(api.getPlaylistRecommendations).not.toHaveBeenCalled();
    expect(result.current.visible).toEqual([]);
  });
});
