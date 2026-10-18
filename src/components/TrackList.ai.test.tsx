import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";
import { allowAiAtom } from "../atoms/playback";
import type { Track } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../hooks/useNavigation", () => ({
  useNavigation: () => ({
    navigateToAlbum: vi.fn(),
    navigateToArtist: vi.fn(),
  }),
}));
vi.mock("../hooks/useFavorites", () => ({
  useFavorites: () => ({
    favoriteTrackIds: new Set<number>(),
    addFavoriteTrack: vi.fn(),
    removeFavoriteTrack: vi.fn(),
  }),
}));
vi.mock("../contexts/ToastContext", () => ({
  useToast: () => ({ showToast: vi.fn() }),
  ToastProvider: ({ children }: PropsWithChildren) => children,
}));

import TrackList from "./TrackList";

const synth = { id: 1, title: "Synth", duration: 100, ai: true } as Track;

function renderList(store: ReturnType<typeof createStore>, onPlay: () => void) {
  return render(
    <Provider store={store}>
      <TrackList tracks={[synth]} onPlay={onPlay} />
    </Provider>,
  );
}

describe("TrackList AI rows", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("badges and dims an ai row when AI is off, and clicking does not play", () => {
    const store = createStore();
    store.set(allowAiAtom, false);
    const onPlay = vi.fn();
    const { getByText, getByLabelText } = renderList(store, onPlay);
    expect(getByLabelText("AI-generated").textContent).toBe("AI");
    expect(getByText("Synth").closest("[class*='opacity-40']")).not.toBeNull();
    fireEvent.click(getByText("Synth"));
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("shows the badge but keeps the row playable when AI is on", () => {
    const onPlay = vi.fn();
    const { getByText, getByLabelText } = renderList(createStore(), onPlay);
    expect(getByLabelText("AI-generated")).toBeTruthy();
    expect(getByText("Synth").closest("[class*='opacity-40']")).toBeNull();
    fireEvent.click(getByText("Synth"));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });
});
