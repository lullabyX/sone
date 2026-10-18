import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
import { allowAiAtom } from "../atoms/playback";

const track = (id: number, title: string, ai: boolean) => ({
  _itemType: "TRACK",
  id,
  title,
  duration: 159,
  ai,
  artists: [{ id: 61693947, name: "The Velvet Sundown" }],
  album: { id: id + 1000, title, cover: "c" },
});

const aiTrack = track(442725746, "Dust and Silence", true);
const plainTrack = track(1, "Highway Star", false);

const uploads = {
  title: "Uploads for you",
  sectionType: "TRACK_LIST",
  items: [aiTrack, plainTrack],
  hasMore: false,
};

function renderSection(section: unknown, allowAi = true) {
  const store = createStore();
  store.set(allowAiAtom, allowAi);
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>{children}</Provider>
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<HomeSection section={section as any} />, { wrapper });
}

const rowFor = (title: string) =>
  screen.getByText(title).closest("div.p-2") as HTMLElement;

describe("home sections — AI label", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it("badges only the AI track in a track row section", () => {
    renderSection(uploads);
    expect(screen.getAllByLabelText("AI-generated")).toHaveLength(1);
    expect(rowFor("Dust and Silence").textContent).toContain("AI");
    expect(rowFor("Highway Star").textContent).not.toContain("AI");
  });

  it("greys out and refuses the AI track when AI content is off", () => {
    renderSection(uploads, false);
    const blocked = rowFor("Dust and Silence");
    expect(blocked.className).toContain("opacity-50");
    fireEvent.click(blocked);
    expect(playFromSource).not.toHaveBeenCalled();
    fireEvent.click(rowFor("Highway Star"));
    expect(playFromSource).toHaveBeenCalledTimes(1);
  });

  it("badges an AI album in the compact grid", () => {
    renderSection({
      title: "Recently played",
      sectionType: "ALBUM_LIST",
      items: [
        {
          _itemType: "ALBUM",
          id: 442725737,
          title: "Dust and Silence",
          cover: "c",
          ai: true,
          artists: [{ id: 61693947, name: "The Velvet Sundown" }],
        },
        plainTrack,
      ],
      hasMore: false,
    });
    expect(screen.getAllByLabelText("AI-generated")).toHaveLength(1);
  });
});
