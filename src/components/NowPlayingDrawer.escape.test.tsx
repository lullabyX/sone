import { afterEach, describe, it, expect, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";

// The real drawer and the real track menu both reach the Tauri bridge (image
// bytes, favourites, playlists) — stub it so neither hits a backend.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

import NowPlayingDrawer from "./NowPlayingDrawer";
import { ToastProvider } from "../contexts/ToastContext";
import { currentTrackAtom } from "../atoms/playback";
import { drawerOpenAtom } from "../atoms/ui";
import type { Track } from "../types";

const track = {
  id: 1,
  title: "Song",
  duration: 100,
  artist: { id: 2, name: "Artist" },
  artists: [{ id: 2, name: "Artist" }],
  album: { id: 3, title: "Album", cover: "cover" },
} as unknown as Track;

function escape() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
}

function renderDrawer() {
  const store = createStore();
  store.set(currentTrackAtom, track);
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

describe("Escape over the now-playing drawer", () => {
  afterEach(cleanup);

  it("closes a context menu opened over the drawer, then the drawer", () => {
    const store = renderDrawer();
    fireEvent.click(screen.getAllByTitle("More options")[0]);
    expect(screen.getByText("Add to play queue")).not.toBeNull();

    escape();
    expect(screen.queryByText("Add to play queue")).toBeNull();
    expect(store.get(drawerOpenAtom)).toBe(true);

    escape();
    expect(store.get(drawerOpenAtom)).toBe(false);
  });
});
