import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ComponentProps } from "react";
import type { Track } from "../types";
import type TrackList from "./TrackList";

const { playSource, getPage } = vi.hoisted(() => ({
  playSource: vi.fn(),
  getPage: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../api/tidal", () => ({
  getPlaylistTracksPage: getPage,
  getPlaylistDetails: vi.fn(async () => ({ accessType: "UNLISTED" })),
  getPlaylistRecommendations: vi.fn(async () => ({ items: [] })),
}));
vi.mock("../hooks/usePlaySource", () => ({ usePlaySource: () => playSource }));
vi.mock("../hooks/useRestoreLoader", () => ({ useRestoreLoader: vi.fn() }));
vi.mock("../hooks/useFavorites", () => ({
  useFavorites: () => ({ favoritePlaylistUuids: new Set() }),
}));
vi.mock("../hooks/usePlaylists", () => ({
  usePlaylists: () => ({ userPlaylists: [] }),
}));
vi.mock("../contexts/ToastContext", () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock("./CoverBanner", () => ({ default: () => null }));
vi.mock("./MediaContextMenu", () => ({ default: () => null }));
vi.mock("./AddToPlaylistMenu", () => ({ EditPlaylistModal: () => null }));
vi.mock("./SourcePlayButton", () => ({ default: () => null }));
vi.mock("./TrackList", () => ({
  default: ({
    tracks,
    onLoadMore,
    hasMore,
    onTrackRemoved,
    onPlay,
    trackDisplayNumbers,
    onSort,
  }: ComponentProps<typeof TrackList>) => (
    <div>
      <output data-testid="entries">
        {JSON.stringify(tracks.map((t) => t.id))}
      </output>
      <output data-testid="more">{String(hasMore)}</output>
      <button onClick={onLoadMore}>Load page</button>
      <button onClick={() => onSort?.("NAME", "ASC")}>Title ascending</button>
      <button onClick={() => onSort?.("NAME", "DESC")}>Title descending</button>
      <button onClick={() => onSort?.(null, null)}>Original order</button>
      <output data-testid="positions">
        {JSON.stringify(trackDisplayNumbers)}
      </output>
      {tracks.map((track, index) => (
        <div key={index}>
          <button
            onClick={() =>
              onTrackRemoved?.((trackDisplayNumbers?.[index] ?? index + 1) - 1)
            }
          >
            Remove {index}
          </button>
          <button onClick={() => onPlay(track, index)}>Play {index}</button>
        </div>
      ))}
    </div>
  ),
}));

import PlaylistView from "./PlaylistView";
import { trackSortPrefsAtom } from "../atoms/favorites";

const track = (id: number): Track => ({
  id,
  title: `Song ${id}`,
  duration: 200,
});

function entries() {
  return JSON.parse(screen.getByTestId("entries").textContent!);
}

describe("PlaylistView playlist entries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    const pages = [
      Array.from({ length: 100 }, (_, i) => track(i + 1)),
      [track(1), track(101), track(2), track(102)],
    ];
    getPage.mockImplementation(async (_id: string, offset: number) => ({
      items: offset === 0 ? pages[0] : pages[1],
      totalNumberOfItems: 104,
      offset,
      limit: 100,
    }));
  });
  afterEach(cleanup);

  it.each(["scroll", "search"])(
    "preserves duplicates when loading through %s",
    async (mode) => {
      render(
        <Provider store={createStore()}>
          <PlaylistView
            playlistId="playlist"
            playlistInfo={{ title: "Test", isUserPlaylist: true }}
            onBack={vi.fn()}
          />
        </Provider>,
      );
      await waitFor(() => expect(entries()).toHaveLength(100));
      if (mode === "scroll") fireEvent.click(screen.getByText("Load page"));
      else fireEvent.focus(screen.getByRole("textbox"));
      await waitFor(() => expect(entries()).toHaveLength(104));
      expect(entries().slice(100)).toEqual([1, 101, 2, 102]);
      expect(screen.getByTestId("more").textContent).toBe("false");
      expect(getPage).toHaveBeenLastCalledWith("playlist", 100, 100);

      // Filter to the two occurrences of song 1, then remove the later entry.
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "Song 1" },
      });
      await waitFor(() => expect(entries()).toHaveLength(15));
      fireEvent.click(screen.getByText("Remove 12"));
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
      await waitFor(() => expect(entries()).toHaveLength(103));
      expect(entries()[0]).toBe(1);
      expect(entries().slice(100)).toEqual([101, 2, 102]);
      fireEvent.click(screen.getByText("Play 0"));
      const source = playSource.mock.calls[playSource.mock.calls.length - 1][0];
      expect(source.loaded.map((t: Track) => t.id)).toEqual(entries());
      expect(source.nextOffset).toBe(103);
    },
  );
  it.each([
    { direction: "ascending", filter: "" },
    { direction: "descending", filter: "" },
    { direction: "ascending", filter: "Song 1" },
    { direction: "descending", filter: "Song 1" },
  ])(
    "removes canonical entries when sorting $direction with filter '$filter'",
    async ({ direction, filter }) => {
      const original = [track(3), track(1), track(2), track(1)];
      getPage.mockImplementation(async (_id: string, offset: number) => ({
        items: offset === 0 ? original.slice(0, 2) : original.slice(2),
        totalNumberOfItems: 4,
        offset,
        limit: 100,
      }));
      render(
        <Provider store={createStore()}>
          <PlaylistView
            playlistId="playlist"
            playlistInfo={{ title: "Test", isUserPlaylist: true }}
            onBack={vi.fn()}
          />
        </Provider>,
      );
      await waitFor(() => expect(entries()).toEqual([3, 1]));
      fireEvent.click(screen.getByText(`Title ${direction}`));
      await waitFor(() => expect(entries()).toHaveLength(4));
      expect(entries()).toEqual(
        direction === "ascending" ? [1, 1, 2, 3] : [3, 2, 1, 1],
      );
      // All requests stay in original order, even the page fetched for sorting.
      expect(getPage.mock.calls.every((call) => call.length === 3)).toBe(true);
      if (filter) {
        fireEvent.change(screen.getByRole("textbox"), {
          target: { value: filter },
        });
        await waitFor(() => expect(entries()).toEqual([1, 1]));
      }
      const positions: number[] = JSON.parse(
        screen.getByTestId("positions").textContent!,
      );
      // Delete the later occurrence of song 1, whose original position is 4.
      fireEvent.click(screen.getByText(`Remove ${positions.indexOf(4)}`));
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
      fireEvent.click(screen.getByText("Original order"));
      await waitFor(() => expect(entries()).toEqual([3, 1, 2]));
      fireEvent.click(screen.getByText("Play 0"));
      expect(
        playSource.mock.calls[0][0].loaded.map((t: Track) => t.id),
      ).toEqual([3, 1, 2]);
      // A subsequent sorted deletion must use the updated canonical positions.
      fireEvent.click(screen.getByText(`Title ${direction}`));
      const updatedPositions: number[] = JSON.parse(
        screen.getByTestId("positions").textContent!,
      );
      fireEvent.click(
        screen.getByText(`Remove ${updatedPositions.indexOf(2)}`),
      );
      fireEvent.click(screen.getByText("Original order"));
      await waitFor(() => expect(entries()).toEqual([3, 2]));
    },
  );
  it("loads canonical pages when a saved title sort is active", async () => {
    const store = createStore();
    store.set(trackSortPrefsAtom, {
      playlist: { order: "NAME", direction: "DESC" },
    });
    render(
      <Provider store={store}>
        <PlaylistView
          playlistId="playlist"
          playlistInfo={{ title: "Test", isUserPlaylist: true }}
          onBack={vi.fn()}
        />
      </Provider>,
    );
    await waitFor(() => expect(entries()).toHaveLength(104));
    expect(entries().slice(0, 3)).toEqual([102, 101, 100]);
    expect(getPage.mock.calls.every((call) => call.length === 3)).toBe(true);
    expect(
      JSON.parse(screen.getByTestId("positions").textContent!).slice(0, 3),
    ).toEqual([104, 102, 100]);
  });

  it("waits for an in-flight scroll page before fetching the remaining sorted entries", async () => {
    let resolvePage!: (page: {
      items: Track[];
      totalNumberOfItems: number;
    }) => void;
    getPage.mockImplementation(async (_id: string, offset: number) => {
      if (offset === 0)
        return { items: [track(3), track(1)], totalNumberOfItems: 5 };
      if (offset === 2)
        return new Promise((resolve) => {
          resolvePage = resolve;
        });
      return { items: [track(4)], totalNumberOfItems: 5 };
    });
    render(
      <Provider store={createStore()}>
        <PlaylistView
          playlistId="playlist"
          playlistInfo={{ title: "Test", isUserPlaylist: true }}
          onBack={vi.fn()}
        />
      </Provider>,
    );
    await waitFor(() => expect(entries()).toEqual([3, 1]));
    fireEvent.click(screen.getByText("Load page"));
    fireEvent.click(screen.getByText("Title ascending"));
    expect(getPage).toHaveBeenCalledTimes(2);
    resolvePage({ items: [track(1), track(2)], totalNumberOfItems: 5 });
    await waitFor(() => expect(entries()).toEqual([1, 1, 2, 3, 4]));
    expect(getPage.mock.calls.map((call) => call[1])).toEqual([0, 2, 4]);
  });
});
