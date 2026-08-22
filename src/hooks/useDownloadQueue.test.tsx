import { act, renderHook, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { downloadItemsAtom, downloadQueueAtom } from "../atoms/downloads";
import { useDownloadQueue } from "./useDownloadQueue";

const { fetchMediaTracks, getArtistAlbums, getAlbumPage } = vi.hoisted(() => ({
  fetchMediaTracks: vi.fn(),
  getArtistAlbums: vi.fn(),
  getAlbumPage: vi.fn(),
}));

vi.mock("../api/tidal", () => ({
  fetchMediaTracks,
  getArtistAlbums,
  getAlbumPage,
}));

describe("useDownloadQueue", () => {
  it("shows only the selected track when queuing a track from an album", () => {
    const store = createStore();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    const { result } = renderHook(() => useDownloadQueue(), { wrapper });
    const track = { id: 1, title: "Selected", duration: 1, album: { id: 42, title: "Album" } };

    act(() => result.current.addTrackToDownloads(track));

    expect(store.get(downloadQueueAtom)[0]).toMatchObject({
      sourceType: "track",
      url: "https://tidal.com/track/1",
      resolvedItems: [track],
      resolutionStatus: "ready",
    });
    expect(Object.values(store.get(downloadItemsAtom))).toMatchObject([{ title: "Selected", status: "pending" }]);
    expect(getAlbumPage).not.toHaveBeenCalled();
  });

  it("queues an album immediately and adds its resolved tracks as pending", async () => {
    const store = createStore();
    getAlbumPage.mockResolvedValueOnce({ page: {
      album: { id: 42, title: "Album", cover: "cover-id" },
      tracks: [
        { id: 1, title: "First", duration: 1 },
        { id: 2, title: "Second", duration: 1 },
      ],
    } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    const { result } = renderHook(() => useDownloadQueue(), { wrapper });

    act(() => result.current.addMediaToDownloads({
      type: "album",
      id: 42,
      title: "Album",
      artistName: "Artist",
    }));

    expect(store.get(downloadQueueAtom)[0]).toMatchObject({
      sourceType: "album",
      url: "https://tidal.com/album/42",
      resolutionStatus: "loading",
    });
    await waitFor(() => expect(store.get(downloadQueueAtom)[0].resolutionStatus).toBe("ready"));
    expect(store.get(downloadQueueAtom)[0].resolvedItems).toHaveLength(2);
    expect(Object.values(store.get(downloadItemsAtom))).toMatchObject([
      { title: "First", status: "pending" },
      { title: "Second", status: "pending" },
    ]);
    expect(store.get(downloadQueueAtom)[0].coverUrl).toBe("https://resources.tidal.com/images/cover/id/1280x1280.jpg");
  });

  it("keeps duplicate playlist resources and their own queue IDs", () => {
    const store = createStore();
    fetchMediaTracks.mockResolvedValue([]);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    const { result } = renderHook(() => useDownloadQueue(), { wrapper });
    const playlist = { type: "playlist" as const, uuid: "playlist-id", title: "Playlist" };

    act(() => {
      result.current.addMediaToDownloads(playlist);
      result.current.addMediaToDownloads(playlist);
    });

    const queue = store.get(downloadQueueAtom);
    expect(queue).toHaveLength(2);
    expect(queue[0].id).not.toBe(queue[1].id);
    expect(queue[0].url).toBe(queue[1].url);
  });

  it.each([
    [9, 2],
    [99, 2],
    [100, 3],
    [999, 3],
  ])("pads a %i-track playlist number to %s digits", async (trackCount, width) => {
    const store = createStore();
    fetchMediaTracks.mockResolvedValueOnce(Array.from({ length: trackCount }, (_, id) => ({ id, title: `Track ${id}`, duration: 1 })));
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    const { result } = renderHook(() => useDownloadQueue(), { wrapper });

    act(() => result.current.addMediaToDownloads({ type: "playlist", uuid: "playlist-id", title: "Playlist" }));

    await waitFor(() => expect(store.get(downloadQueueAtom)[0].resolutionStatus).toBe("ready"));
    expect(store.get(downloadQueueAtom)[0].output).toContain(`{playlist.index:0${width}d}`);
  });
});
