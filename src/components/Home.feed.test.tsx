import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

const getHomePage = vi.fn();
const refreshHomePage = vi.fn();
const getHomePageMore = vi.fn();
const invalidateCache = vi.fn();

vi.mock("../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tidal")>()),
  getHomePage: (...args: unknown[]) => getHomePage(...args),
  refreshHomePage: (...args: unknown[]) => refreshHomePage(...args),
  getHomePageMore: (...args: unknown[]) => getHomePageMore(...args),
  invalidateCache: (...args: unknown[]) => invalidateCache(...args),
}));

vi.mock("../hooks/useNavigation", () => ({
  useNavigation: () => ({
    navigateToPlaylist: vi.fn(),
    navigateToFavorites: vi.fn(),
    navigateToAlbum: vi.fn(),
    navigateToArtist: vi.fn(),
    navigateToMix: vi.fn(),
  }),
}));

vi.mock("./HomeSection", () => ({
  default: ({ section }: { section: { title: string } }) => (
    <div data-testid="home-section">{section.title}</div>
  ),
}));

const section = (title: string) => ({
  title,
  sectionType: "HORIZONTAL_LIST",
  items: [],
});

const shown = () =>
  screen.queryAllByTestId("home-section").map((el) => el.textContent);

type Observer = {
  cb: (entries: unknown[]) => void;
  connected: boolean;
};
let observers: Observer[] = [];

/** Lets pending effects attach the current observer, then fires every
 *  observer that is still connected, as a browser would. */
async function fireSentinel() {
  await act(async () => {});
  act(() => {
    for (const o of observers.filter((x) => x.connected)) {
      o.cb([{ isIntersecting: true }]);
    }
  });
}

const loadingMoreShown = () =>
  document.querySelector(".animate-pulse") !== null;

/** Home keeps its tab cache in module scope, so every case needs a fresh copy
 *  of the module — otherwise the first test's sections leak into the next. */
async function renderHome() {
  vi.resetModules();
  const { default: Home } = await import("./Home");
  return render(<Home />);
}

beforeEach(() => {
  getHomePage.mockReset();
  refreshHomePage.mockReset();
  getHomePageMore.mockReset();
  invalidateCache.mockReset();
  observers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private o: Observer;
      constructor(cb: (entries: unknown[]) => void) {
        this.o = { cb, connected: true };
        observers.push(this.o);
      }
      observe() {}
      disconnect() {
        this.o.connected = false;
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Home feed", () => {
  it("replaces a stale feed with the refreshed one", async () => {
    getHomePage.mockResolvedValue({
      home: { tabs: [], sections: [section("Old")], cursor: "c" },
      isStale: true,
    });
    refreshHomePage.mockResolvedValue({
      tabs: [],
      sections: [section("New")],
      cursor: "c2",
    });

    await renderHome();

    await waitFor(() => expect(shown()).toEqual(["New"]));
    expect(refreshHomePage).toHaveBeenCalledWith("STATIC");
  });

  it("shows a tab's own sections when its tab is clicked", async () => {
    const tabs = [
      { name: "For You", tabType: "STATIC" },
      { name: "Music", tabType: "MUSIC" },
    ];
    getHomePage.mockImplementation(async (feedType: string) => ({
      home: {
        tabs,
        sections: [section(feedType === "MUSIC" ? "Music hits" : "For you")],
        cursor: null,
      },
      isStale: false,
    }));

    await renderHome();
    await waitFor(() => expect(shown()).toEqual(["For you"]));

    fireEvent.click(screen.getByRole("tab", { name: "Music" }));

    await waitFor(() => expect(shown()).toEqual(["Music hits"]));
    expect(
      screen.getByRole("tab", { name: "Music" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(getHomePage).toHaveBeenCalledWith("MUSIC");
  });

  it("appends the next page when the sentinel shows, and drops a failed cursor", async () => {
    getHomePage.mockResolvedValue({
      home: { tabs: [], sections: [section("First")], cursor: "c1" },
      isStale: false,
    });
    getHomePageMore
      .mockResolvedValueOnce({
        tabs: [],
        sections: [section("Second")],
        cursor: "c2",
      })
      .mockRejectedValueOnce({ kind: "Network", message: "offline" });

    await renderHome();
    await waitFor(() => expect(shown()).toEqual(["First"]));

    await fireSentinel();
    await waitFor(() => expect(shown()).toEqual(["First", "Second"]));
    expect(getHomePageMore).toHaveBeenLastCalledWith("c1", "STATIC");
    await waitFor(() => expect(loadingMoreShown()).toBe(false));

    await fireSentinel();
    await waitFor(() => expect(getHomePageMore).toHaveBeenCalledTimes(2));
    expect(getHomePageMore).toHaveBeenLastCalledWith("c2", "STATIC");
    await waitFor(() => expect(loadingMoreShown()).toBe(false));

    await fireSentinel();
    await act(async () => {});
    expect(getHomePageMore).toHaveBeenCalledTimes(2);
    expect(shown()).toEqual(["First", "Second"]);
  });
});
