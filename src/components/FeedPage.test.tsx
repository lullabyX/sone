import type { PropsWithChildren } from "react";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { authTokensAtom } from "../atoms/auth";
import type { FeedResponse } from "../types";

const getFeed = vi.fn();
const navigateToMix = vi.fn();
const navigateToAlbum = vi.fn();

vi.mock("../api/tidal", () => ({
  getFeed: (...args: unknown[]) => getFeed(...args),
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
 *  so every render needs a store with one set — the default atom value is null. */
function renderFeed() {
  const store = createStore();
  store.set(authTokensAtom, { user_id: 1 } as never);
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>{children}</Provider>
  );
  return render(<FeedPage />, { wrapper });
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

    // The unknown payload has no title of its own, so the row shows the mix and
    // album rows as clickable and leaves the third inert: exactly two rows carry
    // the cursor-pointer affordance.
    const clickable = document.querySelectorAll("div.group.cursor-pointer");
    expect(clickable.length).toBe(2);
    // Same two rows carry a play button; the inert one contributes none.
    // `queryAll` rather than `query`, which throws on more than one match.
    expect(screen.queryAllByLabelText(/^Play /).length).toBe(2);
  });

  it("renders an empty state when there are no items", async () => {
    getFeed.mockResolvedValue({ items: [], unseenCount: 0 });
    renderFeed();
    await waitFor(() =>
      expect(screen.getByText(/nothing here yet/i)).toBeTruthy(),
    );
  });
});
