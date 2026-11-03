import { afterEach, describe, it, expect, vi, beforeAll } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));
const pos = { v: 2 };
vi.mock("../lib/playbackPosition", async (orig) => ({
  ...(await orig<object>()),
  getInterpolatedPosition: () => pos.v,
}));
vi.mock("../api/tidal", async (orig) => ({
  ...(await orig<object>()),
  getTrackLyrics: vi.fn(() =>
    Promise.resolve({
      lyrics: "Line A\nLine B\nLine C",
      subtitles: "[00:01.00]Line A\n[00:10.00]Line B\n[00:20.00]Line C",
    }),
  ),
}));

import NowPlayingDrawer from "./NowPlayingDrawer";
import { ToastProvider } from "../contexts/ToastContext";
import { currentTrackAtom, isPlayingAtom } from "../atoms/playback";
import { drawerOpenAtom, drawerTabAtom } from "../atoms/ui";
import type { Track } from "../types";

const track = {
  id: 1,
  title: "Song",
  duration: 100,
  artist: { id: 2, name: "Artist" },
  artists: [{ id: 2, name: "Artist" }],
  album: { id: 3, title: "Album", cover: "cover" },
} as unknown as Track;

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

const active = () =>
  screen
    .getAllByText(/^Line [ABC]$/)
    .find((p) => p.className.includes("font-bold"))?.textContent;

function renderDrawer() {
  const store = createStore();
  store.set(currentTrackAtom, track);
  store.set(drawerTabAtom, "lyrics");
  store.set(isPlayingAtom, true);
  store.set(drawerOpenAtom, true);
  render(
    <Provider store={store}>
      <ToastProvider>
        <NowPlayingDrawer />
      </ToastProvider>
    </Provider>,
  );
  return store;
}

describe("NowPlayingDrawer lyrics sync while the drawer is closed", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    pos.v = 2;
  });

  it("stops the sync loop while the drawer is closed", async () => {
    const store = renderDrawer();
    await waitFor(() => expect(active()).toBe("Line A"));
    act(() => store.set(drawerOpenAtom, false));
    const raf = vi.spyOn(window, "requestAnimationFrame");
    await new Promise((r) => setTimeout(r, 100));
    expect(raf).not.toHaveBeenCalled();
  });

  it("resyncs the line on reopen when the position moved while paused", async () => {
    const store = renderDrawer();
    await waitFor(() => expect(active()).toBe("Line A"));
    act(() => store.set(drawerOpenAtom, false));
    act(() => store.set(isPlayingAtom, false));
    // A seek while paused moves the position with the drawer closed.
    pos.v = 25;
    act(() => store.set(drawerOpenAtom, true));
    await waitFor(() => expect(active()).toBe("Line C"));
  });
});
