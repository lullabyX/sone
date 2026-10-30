import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Provider } from "jotai";
import { ToastProvider } from "../contexts/ToastContext";
import { normalizePlaylistFolders } from "../api/tidal";
import { rawPlaylistItem, signedIn } from "./tv/tvTestUtils";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../hooks/useNavigation", () => ({
  useNavigation: () => ({
    navigateToPlaylist: vi.fn(),
    navigateToAlbum: vi.fn(),
    navigateToArtist: vi.fn(),
    navigateToMix: vi.fn(),
    navigateToPlaylistFolder: vi.fn(),
  }),
}));

const api = vi.hoisted(() => ({
  getPlaylistFolders: vi.fn(),
  getFlattenedPlaylists: vi.fn(),
}));

vi.mock("../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tidal")>()),
  ...api,
}));

import LibraryViewAll from "./LibraryViewAll";

type ObserverCallback = (entries: { isIntersecting: boolean }[]) => void;
let observers: { cb: ObserverCallback; targets: Element[] }[] = [];

class StubIntersectionObserver {
  private rec: { cb: ObserverCallback; targets: Element[] };
  constructor(cb: ObserverCallback) {
    this.rec = { cb, targets: [] };
    observers.push(this.rec);
  }
  observe(el: Element) {
    this.rec.targets.push(el);
  }
  disconnect() {
    observers = observers.filter((o) => o !== this.rec);
  }
  unobserve() {}
}

function renderPlaylists() {
  return render(
    <Provider store={signedIn(42)}>
      <ToastProvider>
        <LibraryViewAll libraryType="playlists" />
      </ToastProvider>
    </Provider>,
  );
}

const emptyPage = { items: [], totalNumberOfItems: 1, cursor: null };

describe("LibraryViewAll playlists", () => {
  beforeEach(() => {
    for (const m of Object.values(api)) m.mockReset();
    observers = [];
    vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
    api.getPlaylistFolders.mockResolvedValue(emptyPage);
    api.getPlaylistFolders.mockResolvedValueOnce({
      items: [rawPlaylistItem("p1", "One")],
      totalNumberOfItems: 1,
      cursor: "n",
    });
    api.getFlattenedPlaylists.mockResolvedValue(
      normalizePlaylistFolders({
        lastModifiedAt: "",
        items: [rawPlaylistItem("p2", "Jazz")],
        totalNumberOfItems: 1,
        cursor: null,
      }).items,
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the first page fetched with the default sort", async () => {
    renderPlaylists();
    expect(await screen.findByText("One")).toBeTruthy();
    expect(api.getPlaylistFolders).toHaveBeenCalledTimes(1);
    expect(api.getPlaylistFolders.mock.calls[0]).toEqual([
      "root",
      0,
      50,
      "DATE_UPDATED",
      "DESC",
      undefined,
      undefined,
    ]);
  });

  it("requests the next page with the cursor when the sentinel shows", async () => {
    renderPlaylists();
    await screen.findByText("One");
    await waitFor(() =>
      expect(observers.some((o) => o.targets.length > 0)).toBe(true),
    );
    const observer = observers.find((o) => o.targets.length > 0)!;
    await act(async () => {
      observer.cb([{ isIntersecting: true }]);
    });
    await waitFor(() =>
      expect(api.getPlaylistFolders).toHaveBeenCalledTimes(2),
    );
    expect(api.getPlaylistFolders.mock.calls[1]).toEqual([
      "root",
      1,
      50,
      "DATE_UPDATED",
      "DESC",
      undefined,
      "n",
    ]);
  });

  it("refetches from the start when Name is picked", async () => {
    renderPlaylists();
    await screen.findByText("One");
    fireEvent.click(screen.getByTitle(/^Sort by:/));
    fireEvent.click(screen.getByText("Name", { selector: "button" }));
    await waitFor(() =>
      expect(api.getPlaylistFolders.mock.lastCall).toEqual([
        "root",
        0,
        50,
        "NAME",
        "ASC",
        undefined,
        undefined,
      ]),
    );
  });

  it("filters across nested playlists", async () => {
    renderPlaylists();
    await screen.findByText("One");
    const input = screen.getByPlaceholderText("Filter by title or creator");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "zz" } });
    expect(await screen.findByText("Jazz")).toBeTruthy();
    expect(screen.queryByText("One")).toBe(null);
    expect(api.getFlattenedPlaylists).toHaveBeenCalledTimes(1);
  });
});
