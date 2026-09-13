import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Provider, createStore } from "jotai";

// The drawer reaches the Tauri bridge for image bytes and favourites — stub it
// so the render never hits a backend.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

import NowPlayingDrawer from "./NowPlayingDrawer";
import { TITLEBAR_HEIGHT } from "./TitleBar";
import { ToastProvider } from "../contexts/ToastContext";
import { currentTrackAtom } from "../atoms/playback";
import { decorationsAtom, drawerOpenAtom, hideTitleBarAtom } from "../atoms/ui";
import type { Track } from "../types";

const track = {
  id: 1,
  title: "Song",
  duration: 100,
  artist: { id: 2, name: "Artist" },
  artists: [{ id: 2, name: "Artist" }],
  album: { id: 3, title: "Album", cover: "cover" },
} as unknown as Track;

function renderDrawer(
  chrome: { nativeChrome?: boolean; hideTitleBar?: boolean } = {},
) {
  const store = createStore();
  store.set(currentTrackAtom, track);
  store.set(drawerOpenAtom, true);
  store.set(decorationsAtom, chrome.nativeChrome ?? false);
  store.set(hideTitleBarAtom, chrome.hideTitleBar ?? false);
  const { container } = render(
    <Provider store={store}>
      <ToastProvider>
        <NowPlayingDrawer />
      </ToastProvider>
    </Provider>,
  );
  const root = container.querySelector<HTMLElement>(".z-40");
  expect(root).not.toBeNull();
  return root!;
}

describe("Now-playing drawer top edge", () => {
  afterEach(cleanup);

  it("stops below the custom title bar so the window stays draggable", () => {
    expect(getComputedStyle(renderDrawer()).top).toBe(`${TITLEBAR_HEIGHT}px`);
  });

  it("reaches the window top when the OS draws the chrome", () => {
    const root = renderDrawer({ nativeChrome: true });
    expect(getComputedStyle(root).top).toBe("0px");
  });

  it("reaches the window top when the title bar is hidden entirely", () => {
    const root = renderDrawer({ hideTitleBar: true });
    expect(getComputedStyle(root).top).toBe("0px");
  });
});
