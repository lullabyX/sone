import { afterEach, describe, it, expect } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";

import { PlayingFromLabel } from "./PlayerBar";
import { playbackSourceAtom } from "../atoms/playback";
import { currentViewAtom } from "../atoms/navigation";
import type { PlaybackSource } from "../types";

// PlayingFromLabel reads playbackSourceAtom and uses useNavigation (pure jotai
// setters) — no Tauri bridge involved, so a jotai Provider is all we need.
function renderWithSource(source: PlaybackSource | null) {
  const store = createStore();
  store.set(playbackSourceAtom, source);
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>{children}</Provider>
  );
  return { store, ...render(<PlayingFromLabel />, { wrapper }) };
}

const source = (over: Partial<PlaybackSource>): PlaybackSource => ({
  type: "playlist",
  id: "123",
  name: "My Playlist",
  tracks: [],
  ...over,
});

describe("PlayingFromLabel", () => {
  afterEach(cleanup);

  it("renders a navigable source as a clickable button", () => {
    renderWithSource(source({ type: "playlist", name: "My Playlist" }));
    // getByRole throws if the button is absent — that is the assertion.
    expect(screen.getByRole("button", { name: "My Playlist" })).not.toBeNull();
  });

  it("renders the recommendations source as a clickable button", () => {
    renderWithSource(
      source({ type: "playlist-recs", name: "My Playlist: Recommended" }),
    );
    expect(
      screen.getByRole("button", { name: "My Playlist: Recommended" }),
    ).not.toBeNull();
  });

  it("navigates to the playlist when the recommendations label is clicked", () => {
    const { store } = renderWithSource(
      source({
        type: "playlist-recs",
        id: "123",
        name: "My Playlist: Recommended",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "My Playlist: Recommended" }),
    );
    expect(store.get(currentViewAtom)).toMatchObject({
      type: "playlist",
      playlistId: "123",
    });
  });

  it("renders an unknown source type as plain non-clickable text", () => {
    renderWithSource(source({ type: "mystery", name: "Mystery" }));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Mystery")).not.toBeNull();
  });
});
