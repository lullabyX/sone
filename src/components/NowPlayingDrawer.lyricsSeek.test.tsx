import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    cmd === "get_track_lyrics"
      ? Promise.resolve({
          subtitles: "[00:01.00] One\n[00:05.00] Two\n[00:09.00] Three",
          isRightToLeft: false,
        })
      : cmd === "get_playback_position"
        ? Promise.resolve(0)
        : Promise.resolve(undefined),
  ),
}));

import { invoke } from "@tauri-apps/api/core";
import NowPlayingDrawer from "./NowPlayingDrawer";
import { ToastProvider } from "../contexts/ToastContext";
import { currentTrackAtom } from "../atoms/playback";
import { drawerOpenAtom, drawerTabAtom } from "../atoms/ui";
import type { Track } from "../types";

const track = {
  id: 224001,
  title: "Song",
  duration: 100,
  artist: { id: 2, name: "Artist" },
  artists: [{ id: 2, name: "Artist" }],
  album: { id: 3, title: "Album", cover: "cover" },
} as unknown as Track;

// Lyrics text can paint before the seek listener's effect runs; wait for the
// listener so a click can't race past it
async function renderLyricsTab() {
  const addListener = vi.spyOn(window, "addEventListener");
  const store = createStore();
  store.set(currentTrackAtom, track);
  store.set(drawerOpenAtom, true);
  store.set(drawerTabAtom, "lyrics");
  render(
    <Provider store={store}>
      <ToastProvider>
        <NowPlayingDrawer />
      </ToastProvider>
    </Provider>,
  );
  await waitFor(() =>
    expect(addListener).toHaveBeenCalledWith(
      "playback-seeked",
      expect.any(Function),
    ),
  );
  addListener.mockRestore();
}

describe("drawer lyrics click-to-seek", () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockClear();
  });

  it("seeks to the clicked line and highlights it while paused", async () => {
    await renderLyricsTab();
    const two = await screen.findByText("Two");
    fireEvent.click(two);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("seek_track", { positionSecs: 5 }),
    );
    await waitFor(() => expect(two.className).toContain("font-bold"));
    expect(screen.getByText("One").className).toContain(
      "text-th-text-disabled",
    );
    expect(screen.getByText("Three").className).toContain("text-th-text-faint");
  });

  it("re-centres on the clicked line, not the old one, after scrolling away", async () => {
    await renderLyricsTab();
    const three = await screen.findByText("Three");
    fireEvent.scroll(three.parentElement!);
    expect(await screen.findByText("Sync lyrics")).not.toBeNull();

    act(() => {
      window.dispatchEvent(new CustomEvent("playback-seeked", { detail: 1 }));
    });
    await waitFor(() =>
      expect(screen.getByText("One").className).toContain("font-bold"),
    );
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);
    scrollIntoView.mockClear();

    fireEvent.click(three);
    await waitFor(() => expect(screen.queryByText("Sync lyrics")).toBeNull());
    expect(scrollIntoView.mock.contexts.length).toBeGreaterThan(0);
    expect(scrollIntoView.mock.contexts.every((el) => el === three)).toBe(true);
  });
});
