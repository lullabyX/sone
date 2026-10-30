import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

vi.mock("../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tidal")>()),
  getTrackCredits: vi.fn(),
}));

import { getTrackCredits } from "../api/tidal";
import { deferred } from "../components/tv/tvTestUtils";
import type { Credit } from "../types";
import { useTrackCredits } from "./useTrackCredits";

const credit = (creditType: string): Credit => ({
  creditType,
  contributors: [{ name: "A", id: 9 }],
});

describe("useTrackCredits", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads the track's credits", async () => {
    vi.mocked(getTrackCredits).mockResolvedValue([credit("Producer")]);
    const { result } = renderHook(() => useTrackCredits(1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.credits).toEqual([credit("Producer")]);
    expect(result.current.error).toBeNull();
    expect(getTrackCredits).toHaveBeenCalledWith(1);
  });

  it("drops a result that arrives after the track changed", async () => {
    const first = deferred<Credit[]>();
    vi.mocked(getTrackCredits).mockImplementation((id) =>
      id === 1 ? first.promise : Promise.resolve([credit("X")]),
    );
    const { result, rerender } = renderHook(({ id }) => useTrackCredits(id), {
      initialProps: { id: 1 },
    });
    rerender({ id: 2 });
    await waitFor(() => expect(result.current.credits).toEqual([credit("X")]));
    await act(async () => first.resolve([credit("Y")]));
    expect(result.current.credits).toEqual([credit("X")]);
  });
});
