import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
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

// The section renderer pulls in the whole media-card/playback tree. This suite
// is about what Home shows when it has NO sections, so a stub keeps the failure
// modes legible.
vi.mock("./HomeSection", () => ({
  default: ({ section }: { section: { title: string } }) => (
    <div data-testid="home-section">{section.title}</div>
  ),
}));

const okResponse = (sections: unknown[]) => ({
  home: { tabs: [], sections, cursor: null },
  isStale: false,
});

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
});

afterEach(cleanup);

describe("Home with no sections", () => {
  it("shows the failure and a way to retry when the feed request fails", async () => {
    getHomePage.mockRejectedValue({
      kind: "Api",
      message: { status: 400, body: "" },
    });

    await renderHome();

    expect(await screen.findByText(/couldn't load/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  it("renders the feed after a retry succeeds", async () => {
    getHomePage
      .mockRejectedValueOnce({ kind: "Network", message: "offline" })
      .mockResolvedValueOnce(
        okResponse([
          { title: "Mixes for you", sectionType: "HORIZONTAL_LIST", items: [] },
        ]),
      );

    await renderHome();

    const retry = await screen.findByRole("button", { name: /retry/i });
    fireEvent.click(retry);

    await waitFor(() =>
      expect(screen.getByTestId("home-section").textContent).toBe(
        "Mixes for you",
      ),
    );
    expect(screen.queryByText(/couldn't load/i)).toBeNull();
  });

  it("says the feed is empty rather than rendering a blank page", async () => {
    getHomePage.mockResolvedValue(okResponse([]));

    await renderHome();

    expect(await screen.findByText(/nothing to show/i)).toBeTruthy();
  });
});

describe("Home pagination", () => {
  it("does not re-request a cursor that already failed", async () => {
    getHomePage.mockResolvedValue({
      home: {
        tabs: [],
        sections: [
          { title: "Mixes for you", sectionType: "HORIZONTAL_LIST", items: [] },
        ],
        cursor: "cursor-1",
      },
      isStale: false,
    });
    getHomePageMore.mockRejectedValue({ kind: "Network", message: "offline" });

    // The sentinel stays on screen after the failure, so the observer is free
    // to fire again the moment loadingMore clears — that must not reach the API.
    const observers: Array<(entries: unknown[]) => void> = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (entries: unknown[]) => void) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );

    await renderHome();
    await screen.findByTestId("home-section");

    const fire = () =>
      observers.forEach((cb) => cb([{ isIntersecting: true }]));

    fire();
    await waitFor(() => expect(getHomePageMore).toHaveBeenCalledTimes(1));

    fire();
    fire();
    await waitFor(() => expect(getHomePageMore).toHaveBeenCalledTimes(1));

    vi.unstubAllGlobals();
  });
});
