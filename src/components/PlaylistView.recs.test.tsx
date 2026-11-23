import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Provider } from "jotai";
import { ToastProvider } from "../contexts/ToastContext";
import { mkTrack, range, signedIn } from "./tv/tvTestUtils";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../hooks/useNavigation", () => ({
  useNavigation: () => ({
    navigateToAlbum: vi.fn(),
    navigateToArtist: vi.fn(),
  }),
}));

const api = vi.hoisted(() => ({
  getPlaylistDetails: vi.fn(),
  getPlaylistTracksPage: vi.fn(),
  getPlaylistRecommendations: vi.fn(),
  invalidateCache: vi.fn(),
}));

vi.mock("../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tidal")>()),
  ...api,
}));

import PlaylistView from "./PlaylistView";

class StubResizeObserver {
  constructor(private cb: (entries: unknown[], obs: unknown) => void) {}
  observe() {
    this.cb([{ borderBoxSize: [{ inlineSize: 800, blockSize: 480 }] }], this);
  }
  disconnect() {}
  unobserve() {}
}

function recTitles(): string[] {
  const section = screen.getByText("Recommended Tracks").parentElement!;
  return Array.from(section.querySelectorAll("span"))
    .map((el) => el.textContent ?? "")
    .filter((t) => /^T\d+$/.test(t));
}

const titles = (ids: number[]) => ids.map((id) => `T${id}`);

describe("PlaylistView recommendations", () => {
  beforeEach(() => {
    for (const m of Object.values(api)) m.mockReset();
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    api.getPlaylistDetails.mockResolvedValue({
      uuid: "p",
      title: "P",
      numberOfTracks: 1,
      creator: { id: 42 },
    });
    api.getPlaylistTracksPage.mockResolvedValue({
      items: [mkTrack(900)],
      totalNumberOfItems: 1,
    });
    api.getPlaylistRecommendations.mockImplementation(
      (_id: string, offset: number) =>
        Promise.resolve(
          offset === 0
            ? { items: range(25).map((i) => mkTrack(i + 1)) }
            : { items: [] },
        ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("pages ten at a time on Refresh and wraps to the start when the next batch is empty", async () => {
    render(
      <Provider store={signedIn(42)}>
        <ToastProvider>
          <PlaylistView playlistId="p" onBack={vi.fn()} />
        </ToastProvider>
      </Provider>,
    );

    await screen.findByText("Recommended Tracks");
    await waitFor(() =>
      expect(recTitles()).toEqual(titles(range(10).map((i) => i + 1))),
    );

    const refresh = screen.getByRole("button", { name: "Refresh" });
    fireEvent.click(refresh);
    await waitFor(() =>
      expect(recTitles()).toEqual(titles(range(10).map((i) => i + 11))),
    );

    fireEvent.click(refresh);
    await waitFor(() =>
      expect(recTitles()).toEqual(titles(range(5).map((i) => i + 21))),
    );

    fireEvent.click(refresh);
    await waitFor(() =>
      expect(api.getPlaylistRecommendations).toHaveBeenCalledWith("p", 50, 50),
    );
    await waitFor(() =>
      expect(recTitles()).toEqual(titles(range(10).map((i) => i + 1))),
    );
    expect(api.invalidateCache).toHaveBeenCalledWith("playlist-recs:p");
  });
});
