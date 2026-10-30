import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tidal")>()),
  getMixItems: vi.fn(),
}));

import NowPlayingDrawer from "./NowPlayingDrawer";
import { ToastProvider } from "../contexts/ToastContext";
import { getMixItems, type MixPageResult } from "../api/tidal";
import { currentTrackAtom } from "../atoms/playback";
import { drawerOpenAtom, drawerTabAtom } from "../atoms/ui";
import type { Track } from "../types";

const mk = (id: number, over: Partial<Track> = {}) =>
  ({
    id,
    title: `T${id}`,
    duration: 180,
    artist: { id: 100 + id, name: `A${id}` },
    artists: [{ id: 100 + id, name: `A${id}` }],
    album: { id: 200 + id, title: `Al${id}`, cover: "c" },
    ...over,
  }) as Track;

function renderSuggested(track: Track) {
  const store = createStore();
  store.set(currentTrackAtom, track);
  store.set(drawerOpenAtom, true);
  store.set(drawerTabAtom, "suggested");
  render(
    <Provider store={store}>
      <ToastProvider>
        <NowPlayingDrawer />
      </ToastProvider>
    </Provider>,
  );
}

describe("drawer suggested tracks tab", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists the track mix's tracks", async () => {
    vi.mocked(getMixItems).mockResolvedValue({
      tracks: [mk(21), mk(22)],
    } as MixPageResult);
    renderSuggested(mk(1, { mixes: { TRACK_MIX: "m1" } }));
    expect(await screen.findByText("T22")).toBeTruthy();
    expect(screen.getByText("T21")).toBeTruthy();
    expect(getMixItems).toHaveBeenCalledWith("m1");
  });

  it("shows the empty state for a track without a mix", async () => {
    renderSuggested(mk(1));
    expect(
      await screen.findByText("No suggested tracks available for this track"),
    ).toBeTruthy();
    expect(getMixItems).not.toHaveBeenCalled();
  });
});
