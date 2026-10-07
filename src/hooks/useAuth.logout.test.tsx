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
import { usePlaySource } from "./usePlaySource";
import { ToastProvider } from "../contexts/ToastContext";
import { queueAtom } from "../atoms/playback";
import type { TrackPage } from "../lib/trackSources";
import type { Track } from "../types";
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

  it("stops a paged source from appending after logout", async () => {
    const store = createStore();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <Provider store={store}>
        <ToastProvider>{children}</ToastProvider>
      </Provider>
    );
    const { result } = renderHook(
      () => ({ auth: useAuth(), play: usePlaySource() }),
      { wrapper },
    );
    const mk = (id: number) =>
      ({ id, title: `T${id}`, duration: 100 }) as unknown as Track;
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => mk(from + i));
    let resolvePage!: (p: TrackPage) => void;
    const page = new Promise<TrackPage>((r) => (resolvePage = r));

    await act(async () => {
      await result.current.play({
        meta: { type: "playlist", id: "p1", name: "P" },
        loaded: range(1, 50),
        fetchPage: () => page,
      });
    });
    expect(store.get(queueAtom)).toHaveLength(49);

    await act(async () => {
      await result.current.auth.logout();
    });
    await act(async () => {
      resolvePage({ items: range(51, 60), hasMore: false });
      await page;
    });
    expect(store.get(queueAtom)).toHaveLength(0);
  });
});
