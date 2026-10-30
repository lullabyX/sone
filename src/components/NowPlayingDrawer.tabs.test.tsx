import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tidal")>()),
  getMixItems: vi.fn(),
  getTrackCredits: vi.fn(),
  getArtistBio: vi.fn(async () => ""),
}));

import NowPlayingDrawer from "./NowPlayingDrawer";
import { ToastProvider } from "../contexts/ToastContext";
import { getMixItems, getTrackCredits, type MixPageResult } from "../api/tidal";
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

function renderTab(tab: "suggested" | "credits", track: Track) {
  const store = createStore();
  store.set(currentTrackAtom, track);
  store.set(drawerOpenAtom, true);
  store.set(drawerTabAtom, tab);
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
    renderTab("suggested", mk(1, { mixes: { TRACK_MIX: "m1" } }));
    expect(await screen.findByText("T22")).toBeTruthy();
    expect(screen.getByText("T21")).toBeTruthy();
    expect(getMixItems).toHaveBeenCalledWith("m1");
  });

  it("shows the empty state for a track without a mix", async () => {
    renderTab("suggested", mk(1));
    expect(
      await screen.findByText("No suggested tracks available for this track"),
    ).toBeTruthy();
    expect(getMixItems).not.toHaveBeenCalled();
  });
});

describe("drawer credits tab", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists each role with its contributors", async () => {
    vi.mocked(getTrackCredits).mockResolvedValue([
      {
        creditType: "Producer",
        contributors: [{ name: "A", id: 9 }, { name: "B" }],
      },
    ]);
    renderTab("credits", mk(1));
    expect(await screen.findByText("Producer")).toBeTruthy();
    expect(screen.getByText("A, B")).toBeTruthy();
    expect(getTrackCredits).toHaveBeenCalledWith(1);
  });

  it("shows the empty state when there are no credits", async () => {
    vi.mocked(getTrackCredits).mockResolvedValue([]);
    renderTab("credits", mk(1));
    expect(
      await screen.findByText("No credits available for this track"),
    ).toBeTruthy();
  });
});
