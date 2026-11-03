import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("../hooks/useMediaPlay", () => ({
  useMediaPlay: () => vi.fn(),
}));

import CardScrollSection from "./CardScrollSection";

const noop = () => {};

function renderSection(items: unknown[]) {
  return render(
    <CardScrollSection
      section={{ title: "Albums", type: "ALBUM_LIST", items }}
      artistId={42}
      onCardClick={noop}
      onContextMenu={noop}
      favoriteAlbumIds={new Set()}
      addFavoriteAlbum={noop}
      removeFavoriteAlbum={noop}
      favoritePlaylistUuids={new Set()}
      addFavoritePlaylist={noop}
      removeFavoritePlaylist={noop}
      followedArtistIds={new Set()}
      followArtist={noop}
      unfollowArtist={noop}
      favoriteMixIds={new Set()}
      addFavoriteMix={noop}
      removeFavoriteMix={noop}
    />,
  );
}

const badges = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("span")).filter(
    (el) => el.textContent === "E",
  );

describe("CardScrollSection album cards", () => {
  const album = {
    id: 1,
    title: "Diorama",
    type: "ALBUM",
    releaseDate: "2026-06-28",
    artists: [{ id: 42, name: "HOOKUPS" }],
  };

  it("shows the explicit badge and release year on an explicit album", () => {
    const { container } = renderSection([{ ...album, explicit: true }]);
    expect(badges(container)).toHaveLength(1);
    expect(container.textContent).toContain("2026 · Album");
  });

  it("shows no badge on a clean album", () => {
    const { container } = renderSection([{ ...album, explicit: false }]);
    expect(badges(container)).toHaveLength(0);
  });
});
