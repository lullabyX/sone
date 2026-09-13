import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";

// The drawer reaches the Tauri bridge for image bytes and favourites — stub it
// so the render never hits a backend.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

// The drawer pulls in TitleBar and the video actions, both of which reach for
// the Tauri window. Only setFullscreen is asserted on.
const { windowMock } = vi.hoisted(() => ({
  windowMock: {
    setFullscreen: vi.fn(() => Promise.resolve()),
    isMaximized: vi.fn(() => Promise.resolve(false)),
    isFocused: vi.fn(() => Promise.resolve(true)),
    onResized: vi.fn(() => Promise.resolve(() => {})),
    onFocusChanged: vi.fn(() => Promise.resolve(() => {})),
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowMock,
}));

import NowPlayingDrawer from "./NowPlayingDrawer";
import { ToastProvider } from "../contexts/ToastContext";
import { currentTrackAtom } from "../atoms/playback";
import { drawerOpenAtom, maximizedPlayerAtom } from "../atoms/ui";
import {
  currentVideoAtom,
  videoExpandedAtom,
  videoFullscreenAtom,
} from "../atoms/video";
import type { Track, TidalVideo } from "../types";

const track = {
  id: 1,
  title: "Song",
  duration: 100,
  artist: { id: 2, name: "Artist" },
  artists: [{ id: 2, name: "Artist" }],
  album: { id: 3, title: "Album", cover: "cover" },
} as unknown as Track;

const video = {
  id: 42,
  title: "Clip",
  duration: 200,
} as unknown as TidalVideo;

function renderDrawer({ playingVideo = false } = {}) {
  const store = createStore();
  store.set(currentTrackAtom, track);
  store.set(drawerOpenAtom, true);
  if (playingVideo) {
    store.set(currentVideoAtom, video);
    // The overlay is minimized to the player bar — the video keeps playing.
    store.set(videoExpandedAtom, false);
  }
  render(
    <Provider store={store}>
      <ToastProvider>
        <NowPlayingDrawer />
      </ToastProvider>
    </Provider>,
  );
  return store;
}

describe("Drawer fullscreen button", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("plays the video fullscreen while a video is playing", () => {
    const store = renderDrawer({ playingVideo: true });
    fireEvent.click(screen.getByTitle(/^Fullscreen/));
    expect(store.get(videoExpandedAtom)).toBe(true);
    expect(store.get(videoFullscreenAtom)).toBe(true);
    expect(windowMock.setFullscreen).toHaveBeenCalledWith(true);
    expect(store.get(maximizedPlayerAtom)).toBe(false);
  });

  it("opens the audio fullscreen player when no video is playing", () => {
    const store = renderDrawer();
    fireEvent.click(screen.getByTitle(/^Fullscreen/));
    expect(store.get(maximizedPlayerAtom)).toBe(true);
    expect(store.get(videoExpandedAtom)).toBe(false);
    expect(windowMock.setFullscreen).not.toHaveBeenCalled();
  });

  it("labels the button for whichever player it opens", () => {
    renderDrawer({ playingVideo: true });
    expect(screen.getByTitle("Fullscreen video")).not.toBeNull();
    cleanup();
    renderDrawer();
    expect(screen.getByTitle("Fullscreen player")).not.toBeNull();
  });
});
