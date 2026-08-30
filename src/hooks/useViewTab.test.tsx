import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { currentViewAtom } from "../atoms/navigation";
import { pushView, scrollKey } from "../lib/scrollMemory";
import { useViewTab } from "./useViewTab";
import type { AppView } from "../types";

/** `pushView` returns the whole `AppView` union, and its `search` variant types
 *  `tab` as a narrow literal union; narrowing to the pushed variant keeps a
 *  plain `tab` string assignable. */
function favoritesEntry() {
  return pushView({ type: "favorites" }) as Extract<
    AppView,
    { type: "favorites" }
  >;
}

function renderTab<T extends string>(
  initial: T,
  view: AppView,
  allowed: readonly T[],
) {
  const store = createStore();
  store.set(currentViewAtom, view);
  const utils = renderHook(() => useViewTab<T>(initial, allowed), {
    wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
  });
  return { store, ...utils };
}

describe("useViewTab", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the entry's nav id so only the tab segment of the scroll key changes", () => {
    // Carries a tab already, i.e. the shape of a back-navigated entry: the
    // mount-time stamp is a no-op, so the only write under test is `setTab`.
    const seeded = { ...favoritesEntry(), tab: "tracks" };
    window.history.replaceState(seeded, "");
    const seededKey = scrollKey(seeded)!;
    // Installed after seeding: `pushView` pushes state of its own.
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");

    const store = createStore();
    store.set(currentViewAtom, seeded);
    const { result } = renderHook(
      () => useViewTab<"tracks" | "albums">("tracks", ["tracks", "albums"]),
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
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(pushState).not.toHaveBeenCalled();
  });

  it("seeds the tab from the entry's state, not from the initial argument", () => {
    const seeded = { ...favoritesEntry(), tab: "videos" };
    window.history.replaceState(seeded, "");

    const { result } = renderTab<"tracks" | "videos">("tracks", seeded, [
      "tracks",
      "videos",
    ]);

    expect(result.current[0]).toBe("videos");
  });

  it("gives the entry's initial tab its own scroll key", () => {
    const seeded = favoritesEntry();
    window.history.replaceState(seeded, "");
    const pushState = vi.spyOn(window.history, "pushState");

    const { store } = renderTab<"tracks" | "videos">("tracks", seeded, [
      "tracks",
      "videos",
    ]);

    const next = store.get(currentViewAtom);
    expect(next.__navId).toBe(seeded.__navId);
    expect(next.__navSession).toBe(seeded.__navSession);
    expect(scrollKey(next)).toBe(`${seeded.__navId}:tracks`);
    expect((window.history.state as { tab?: string }).tab).toBe("tracks");
    expect(pushState).not.toHaveBeenCalled();
  });

  it("does not rewrite an entry that already carries a tab", () => {
    const seeded = { ...favoritesEntry(), tab: "videos" };
    window.history.replaceState(seeded, "");
    const replaceState = vi.spyOn(window.history, "replaceState");

    renderTab<"tracks" | "videos">("tracks", seeded, ["tracks", "videos"]);

    expect(replaceState).not.toHaveBeenCalled();
  });

  it("stamps the tab into a new entry created without a remount", () => {
    const first = pushView({ type: "favorites" });
    window.history.replaceState(first, "");

    const store = createStore();
    store.set(currentViewAtom, first);
    const { result } = renderHook(
      () => useViewTab<"tracks" | "videos">("tracks", ["tracks", "videos"]),
      {
        wrapper: ({ children }) => (
          <Provider store={store}>{children}</Provider>
        ),
      },
    );

    act(() => {
      result.current[1]("videos");
    });
    expect(scrollKey(store.get(currentViewAtom))).toBe(
      `${first.__navId}:videos`,
    );

    // A fresh entry for the same page, with no remount of the hook.
    const second = pushView({ type: "favorites" });
    window.history.replaceState(second, "");
    act(() => {
      store.set(currentViewAtom, second);
    });

    expect(scrollKey(store.get(currentViewAtom))).toBe(
      `${second.__navId}:videos`,
    );
    expect((window.history.state as { tab?: string }).tab).toBe("videos");
  });

  it("falls back to the initial tab when history state holds a foreign value", () => {
    const entry = { ...favoritesEntry(), tab: "albums" };
    window.history.replaceState(entry, "");

    const store = createStore();
    store.set(currentViewAtom, entry);
    const { result } = renderHook(
      () => useViewTab<"tracks" | "videos">("tracks", ["tracks", "videos"]),
      {
        wrapper: ({ children }) => (
          <Provider store={store}>{children}</Provider>
        ),
      },
    );

    expect(result.current[0]).toBe("tracks");
  });

  it("does not stamp an entry the live history state disagrees with", () => {
    const seeded = favoritesEntry();
    window.history.replaceState(seeded, "");
    const replaceState = vi.spyOn(window.history, "replaceState");

    // The atom names a different entry than the one history is sitting on.
    renderTab<"tracks" | "videos">(
      "tracks",
      { ...seeded, __navId: (seeded.__navId ?? 0) + 1 },
      ["tracks", "videos"],
    );

    expect(replaceState).not.toHaveBeenCalled();
  });
});
