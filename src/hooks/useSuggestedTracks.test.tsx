import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

vi.mock("../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tidal")>()),
  getMixItems: vi.fn(),
}));

import { getMixItems, type MixPageResult } from "../api/tidal";
import type { Track } from "../types";
import { useSuggestedTracks } from "./useSuggestedTracks";

const mk = (id: number, over: Partial<Track> = {}) =>
  ({ id, title: `T${id}`, duration: 180, ...over }) as Track;

describe("useSuggestedTracks", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads the track mix's tracks", async () => {
    vi.mocked(getMixItems).mockResolvedValue({
      tracks: [mk(21), mk(22)],
    } as MixPageResult);
    const { result } = renderHook(() =>
      useSuggestedTracks(mk(1, { mixes: { TRACK_MIX: "m1" } })),
    );
    await waitFor(() => expect(result.current.tracks).toHaveLength(2));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(getMixItems).toHaveBeenCalledWith("m1");
  });

  it("is empty and not loading for a track without a mix", () => {
    const { result } = renderHook(() => useSuggestedTracks(mk(1)));
    expect(result.current).toMatchObject({ tracks: [], loading: false });
    expect(getMixItems).not.toHaveBeenCalled();
  });
});
