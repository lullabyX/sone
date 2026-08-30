import type { PropsWithChildren } from "react";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { authTokensAtom } from "../atoms/auth";
import { feedUnseenCountAtom } from "../atoms/ui";
import { ToastProvider } from "../contexts/ToastContext";
import type { FeedResponse } from "../types";

const getFeed = vi.fn();
const markFeedSeen = vi.fn();
const navigateToMix = vi.fn();
const navigateToAlbum = vi.fn();

// Spread the real module rather than listing exports: opening the row context
// menu pulls MediaContextMenu in, whose own imports (fetchMediaTracks,
// AddToPlaylistMenu -> getAllPlaylists, ...) resolve lazily and would be
// undefined under a partial mock. Same reasoning as
// ViewAllPage.lovedTracks.test.tsx.
vi.mock("../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tidal")>()),
  getFeed: (...args: unknown[]) => getFeed(...args),
  markFeedSeen: (...args: unknown[]) => markFeedSeen(...args),
}));

vi.mock("../hooks/useNavigation", () => ({
  useNavigation: () => ({ navigateToMix, navigateToAlbum }),
}));

const playMedia = vi.fn();

vi.mock("../hooks/useMediaPlay", () => ({
  useMediaPlay: () => playMedia,
}));

import FeedPage from "./FeedPage";

/** FeedPage reads the user id from `authTokensAtom` and bails when it is absent,
 *  so every render needs a store with one set — the default atom value is null.
 *
 *  The unseen count is seeded nonzero and the store is returned so callers can
 *  assert the badge was actually cleared: `feedUnseenCountAtom` defaults to 0,
 *  so asserting against a fresh store would pass even with the clearing line
 *  deleted. */
function renderFeed() {
  const store = createStore();
  store.set(authTokensAtom, { user_id: 1 } as never);
  store.set(feedUnseenCountAtom, 3);
  // ToastProvider is required once a row menu opens: MediaContextMenu calls
  // useToast, which throws outside a provider.
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>
      <ToastProvider>{children}</ToastProvider>
    </Provider>
  );
  return { ...render(<FeedPage />, { wrapper }), store };
}

const RESPONSE: FeedResponse = {
  unseenCount: 0,
  items: [
    {
      kind: "mix",
      activityType: "NEW_HISTORY_MIX",
      occurredAt: "2026-08-01T00:00:00.000Z",
      seen: true,
      item: {
        id: "0011112222333344445555666677",
        mixType: "HISTORY_MONTHLY_MIX",
        title: "July 2026",
        subTitle: "Some Artist and more",
        images: {
          MEDIUM: {
            width: 533,
            height: 533,
            url: "https://example.invalid/a.jpg",
          },
        },
      },
    },
    {
      kind: "album",
      activityType: "NEW_ALBUM_RELEASE",
      occurredAt: "2026-06-05T00:00:00.000Z",
      seen: true,
      item: {
        id: 1234,
        title: "Some Single",
        type: "SINGLE",
        cover: "00000000-1111-2222-3333-444444444444",
        artists: [{ id: 9, name: "Some Artist" }],
      },
    },
    {
      kind: "unknown",
      activityType: "NEW_MYSTERY_THING",
      occurredAt: "2026-01-01T00:00:00.000Z",
      seen: true,
      item: { id: 7 },
    },
  ],
};

describe("FeedPage", () => {
  // There is no vitest setup file, so RTL's automatic cleanup is never
  // registered: without this each render stacks in document.body and the
  // single-match queries below find duplicates from earlier tests.
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    getFeed.mockResolvedValue(RESPONSE);
    markFeedSeen.mockResolvedValue(undefined);
  });

  it("renders a row per item with a bucket heading", async () => {
    renderFeed();
    await waitFor(() => expect(screen.getByText("July 2026")).toBeTruthy());
    expect(screen.getByText("Some Single")).toBeTruthy();
  });

  it("never emits an empty image src", async () => {
    const { container } = renderFeed();
    await waitFor(() => expect(screen.getByText("July 2026")).toBeTruthy());
    for (const img of Array.from(container.querySelectorAll("img"))) {
      expect(img.getAttribute("src")).toBeTruthy();
    }
  });

  it("renders the unknown row without making it clickable", async () => {
    renderFeed();
    await waitFor(() => expect(screen.getByText("July 2026")).toBeTruthy());

    // The unknown payload renders no title and no subtitle, so assert the row
    // count directly: without this the tests would pass just as well against an
    // implementation that dropped unknown kinds from the list entirely.
    const rows = document.querySelectorAll("div.group");
    expect(rows.length).toBe(3);

    // Inertness has to be tested through behaviour, not through a styling class:
    // a row wired to `handleOpen` but missing `cursor-pointer` would still call
    // `navigateToAlbum(NaN)` and open a blank page.
    fireEvent.click(rows[2]);
    expect(navigateToMix).not.toHaveBeenCalled();
    expect(navigateToAlbum).not.toHaveBeenCalled();

    // Only the mix and album rows carry a play button; the inert one has none.
    // `queryAll` rather than `query`, which throws on more than one match.
    expect(screen.queryAllByLabelText(/^Play /).length).toBe(2);
  });

  it("opens the context menu from the row's three-dot button", async () => {
    renderFeed();
    await waitFor(() => expect(screen.getByText("July 2026")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("More options for Some Single"));

    // "Play now" is MediaContextMenu's first entry, so its presence proves the
    // real menu mounted rather than a placeholder.
    await waitFor(() => expect(screen.getByText("Play now")).toBeTruthy());
  });

  it("opens the context menu on right-click", async () => {
    renderFeed();
    await waitFor(() => expect(screen.getByText("July 2026")).toBeTruthy());

    const rows = document.querySelectorAll("div.group");
    fireEvent.contextMenu(rows[1]);

    await waitFor(() => expect(screen.getByText("Play now")).toBeTruthy());
  });

  it("does not navigate when the three-dot button is clicked", async () => {
    renderFeed();
    await waitFor(() => expect(screen.getByText("July 2026")).toBeTruthy());

    // The button sits inside the row, so without stopPropagation the row's own
    // click handler would fire and navigate away behind the menu.
    fireEvent.click(screen.getByLabelText("More options for Some Single"));

    expect(navigateToAlbum).not.toHaveBeenCalled();
    expect(navigateToMix).not.toHaveBeenCalled();
  });

  it("gives the unknown row no three-dot button and no menu", async () => {
    renderFeed();
    await waitFor(() => expect(screen.getByText("July 2026")).toBeTruthy());

    // Query by title, not by aria-label: the unknown payload has no title, so
    // its label is "More options for " and Testing Library's whitespace
    // normalisation trims it — a /^More options for / regex silently stops
    // matching and the assertion passes even when the button is rendered.
    expect(screen.queryAllByTitle("More options").length).toBe(2);

    fireEvent.contextMenu(document.querySelectorAll("div.group")[2]);
    expect(screen.queryByText("Play now")).toBeNull();
  });

  it("renders an empty state when there are no items", async () => {
    getFeed.mockResolvedValue({ items: [], unseenCount: 0 });
    renderFeed();
    await waitFor(() =>
      expect(screen.getByText(/nothing here yet/i)).toBeTruthy(),
    );
  });

  it("marks the feed seen and clears the badge on mount", async () => {
    const { store } = renderFeed();
    await waitFor(() => expect(markFeedSeen).toHaveBeenCalledWith(1));
    // Clearing the badge is the half of this feature the user actually sees,
    // and it is optimistic — it must not wait on the request above.
    expect(store.get(feedUnseenCountAtom)).toBe(0);
  });

  // Mark-seen lives in its own effect rather than inside `getFeed`'s `.then`,
  // precisely so a failed load cannot leave the sidebar dot stuck on. Folding
  // the two effects together would still pass every other test in this file.
  it("marks the feed seen and clears the badge even when the fetch fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    getFeed.mockRejectedValue(new Error("boom"));

    const { store } = renderFeed();

    // Assert the failure actually surfaced, so this cannot silently degrade
    // into a second copy of the happy-path test.
    await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
    await waitFor(() => expect(markFeedSeen).toHaveBeenCalledWith(1));
    expect(store.get(feedUnseenCountAtom)).toBe(0);

    consoleError.mockRestore();
  });
});
