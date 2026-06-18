import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";
import { useNavigation } from "./useNavigation";
import { drawerOpenAtom, maximizedPlayerAtom } from "../atoms/ui";
import { currentViewAtom } from "../atoms/navigation";

describe("useNavigation overlay dismissal", () => {
  beforeEach(() => {
    // Don't mutate real jsdom history between cases.
    vi.spyOn(window.history, "pushState").mockImplementation(() => {});
  });

  function setup() {
    const store = createStore();
    store.set(drawerOpenAtom, true);
    store.set(maximizedPlayerAtom, true);
    const wrapper = ({ children }: PropsWithChildren) => (
      <Provider store={store}>{children}</Provider>
    );
    const { result } = renderHook(() => useNavigation(), { wrapper });
    return { store, result };
  }

  it("closes the queue drawer and fullscreen player when navigating to an album", () => {
    const { store, result } = setup();
    act(() => {
      result.current.navigateToAlbum(123);
    });
    expect(store.get(drawerOpenAtom)).toBe(false);
    expect(store.get(maximizedPlayerAtom)).toBe(false);
    expect(store.get(currentViewAtom)).toMatchObject({
      type: "album",
      albumId: 123,
    });
  });

  it("closes overlays when navigating to an artist", () => {
    const { store, result } = setup();
    act(() => {
      result.current.navigateToArtist(7, { name: "Artist" });
    });
    expect(store.get(drawerOpenAtom)).toBe(false);
    expect(store.get(maximizedPlayerAtom)).toBe(false);
    expect(store.get(currentViewAtom)).toMatchObject({
      type: "artist",
      artistId: 7,
    });
  });
});
