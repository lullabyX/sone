import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import React from "react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../api/tidal", () => ({
  clearCache: vi.fn(),
  getPlaylistFolders: vi.fn(),
  normalizePlaylistFolders: vi.fn(),
}));

import { useAuth } from "./useAuth";
import { userNameAtom, currentUserAvatarAtom } from "../atoms/auth";
import { favoriteAlbumIdsAtom, favoriteMixIdsAtom } from "../atoms/favorites";
import { currentViewAtom } from "../atoms/navigation";
import { allFoldersFetchedAtom } from "../atoms/playlists";

describe("useAuth logout", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("clears cross-account state and localStorage on logout", async () => {
    const store = createStore();
    store.set(userNameAtom, "Alice");
    store.set(currentUserAvatarAtom, "https://img/avatar.jpg");
    store.set(favoriteAlbumIdsAtom, new Set([1, 2, 3]));
    store.set(favoriteMixIdsAtom, new Set(["m1"]));
    store.set(currentViewAtom, { type: "playlist", id: "p1" } as never);
    store.set(allFoldersFetchedAtom, true);
    localStorage.setItem("sone.search-history", JSON.stringify(["queen"]));

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    const { result } = renderHook(() => useAuth(), { wrapper });

    await act(async () => {
      await result.current.logout();
    });

    expect(store.get(userNameAtom)).toBe("TIDAL User");
    expect(store.get(currentUserAvatarAtom)).toBeNull();
    expect(store.get(favoriteAlbumIdsAtom).size).toBe(0);
    expect(store.get(favoriteMixIdsAtom).size).toBe(0);
    expect(store.get(currentViewAtom)).toEqual({ type: "home" });
    expect(store.get(allFoldersFetchedAtom)).toBe(false);
    expect(localStorage.getItem("sone.search-history")).toBeNull();
  });
});
