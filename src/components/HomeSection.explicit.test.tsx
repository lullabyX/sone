import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../hooks/useNavigation", () => ({
  useNavigation: () => ({
    navigateToAlbum: vi.fn(),
    navigateToPlaylist: vi.fn(),
    navigateToFavorites: vi.fn(),
    navigateToViewAll: vi.fn(),
    navigateToArtist: vi.fn(),
    navigateToMix: vi.fn(),
  }),
}));

const playFromSource = vi.fn();
vi.mock("../hooks/usePlaybackActions", () => ({
  usePlaybackActions: () => ({ playFromSource }),
}));

vi.mock("../hooks/useMediaPlay", () => ({
  useMediaPlay: () => vi.fn(),
}));

vi.mock("../hooks/useFavorites", () => ({
  useFavorites: () => ({
    favoriteAlbumIds: new Set(),
    favoritePlaylistUuids: new Set(),
    followedArtistIds: new Set(),
    favoriteMixIds: new Set(),
    favoriteVideoIds: new Set(),
  }),
}));

import HomeSection from "./HomeSection";

const album = (id: number, title: string, explicit: boolean) => ({
  _itemType: "ALBUM",
  id,
  title,
  cover: "c",
  explicit,
  artists: [{ id: 1, name: "Artist" }],
});

function renderSection(section: unknown) {
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={createStore()}>{children}</Provider>
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<HomeSection section={section as any} />, { wrapper });
}

const cardFor = (title: string) =>
  screen.getByText(title).closest("div.p-3") as HTMLElement;

describe("home card rows — explicit badge", () => {
  afterEach(cleanup);

  it("badges only the explicit album in a horizontal album row", () => {
    renderSection({
      title: "Suggested new albums for you",
      sectionType: "ALBUM_LIST",
      items: [album(1, "ALOUD!", true), album(2, "Clean Record", false)],
      hasMore: false,
    });
    expect(cardFor("ALOUD!").textContent).toContain("ALOUD!E");
    expect(cardFor("Clean Record").textContent).not.toContain("Clean RecordE");
  });
});
