import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { currentViewAtom } from "../atoms/navigation";
import { pushView, scrollKey } from "../lib/scrollMemory";
import { useViewTab } from "./useViewTab";

describe("useViewTab", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the entry's nav id so only the tab segment of the scroll key changes", () => {
    const seeded = pushView({ type: "favorites" });
    window.history.replaceState(seeded, "");
    const seededKey = scrollKey(seeded)!;

    const store = createStore();
    store.set(currentViewAtom, seeded);
    const { result } = renderHook(
      () => useViewTab<"tracks" | "albums">("tracks"),
      {
        wrapper: ({ children }) => (
          <Provider store={store}>{children}</Provider>
        ),
      },
    );

    act(() => {
      result.current[1]("albums");
    });

    const next = store.get(currentViewAtom);
    expect(next.__navId).toBe(seeded.__navId);
    expect(next.__navSession).toBe(seeded.__navSession);
    expect(scrollKey(next)).toBe(`${seededKey.split(":")[0]}:albums`);
  });
});
