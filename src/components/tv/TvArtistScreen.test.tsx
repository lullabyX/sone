import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import type { ArtistPageData } from "../../types";
import TvArtistScreen from "./TvArtistScreen";
import { mkTrack, range, renderTv, setupTvTest } from "./tvTestUtils";

setupTvTest();
const api = vi.hoisted(() => ({
  getArtistPage: vi.fn(
    (_id: number): Promise<ArtistPageData> => new Promise(() => {}),
  ),
}));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()),
  ...api,
}));

beforeEach(() => {
  for (const m of Object.values(api)) m.mockReset();
});

it("plays every top track, shows all track sections and the biography", async () => {
  const T = range(3).map((i) => mkTrack(i + 1));
  const t9 = mkTrack(9);
  api.getArtistPage.mockResolvedValue({
    artistName: "X",
    topTracks: T,
    bio: "One<br/>Two",
    bioSource: "Src",
    sections: [
      { type: "TRACK_LIST", title: "Popular tracks", items: T, apiPath: "v" },
      { type: "TRACK_LIST", title: "Appears on", items: [t9] },
      {
        type: "ALBUM_LIST",
        title: "Albums",
        items: [{ id: 50, title: "Loud", cover: "c", explicit: true }],
      },
    ],
  } as ArtistPageData);
  const { nav } = renderTv(<TvArtistScreen view={{ type: "artist", id: 9 }} />);
  expect(await screen.findByText("Appears on")).toBeTruthy();
  expect(screen.getByText("Popular tracks")).toBeTruthy();
  expect(screen.getAllByText("T2")).toHaveLength(1);
  expect(screen.queryByText("Top tracks")).toBeNull();

  const calls = vi.mocked(nav.playSource).mock;
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  expect(calls.lastCall![0]).toMatchObject({
    meta: { type: "artist", id: 9, name: "X" },
    loaded: T,
    nextOffset: 0,
    dedupe: true,
  });
  expect(calls.lastCall![0].fetchPage).toEqual(expect.any(Function));
  expect(calls.lastCall![1]).toBeUndefined();
  expect(nav.openNowPlaying).not.toHaveBeenCalled();
  expect(
    within(screen.getByText("Loud").closest("button")!).getByText("E"),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Shuffle" }));
  expect(calls.lastCall![0]).toMatchObject({ loaded: T, dedupe: true });
  expect(calls.lastCall![1]).toEqual({ shuffle: true });

  fireEvent.click(screen.getByText("T2").closest("button")!);
  expect(calls.lastCall![0]).toMatchObject({ loaded: T, dedupe: true });
  expect(calls.lastCall![1]).toEqual({ startAt: T[1] });

  fireEvent.click(screen.getByText("T9").closest("button")!);
  expect(calls.lastCall![0]).toMatchObject({ loaded: [t9] });
  expect(calls.lastCall![0].fetchPage).toBeUndefined();
  expect(calls.lastCall![1]).toEqual({ startAt: t9 });

  fireEvent.click(screen.getByRole("button", { name: "Biography" }));
  expect(vi.mocked(nav.openMenu).mock.lastCall![0]).toMatchObject({
    title: "Biography",
    wide: true,
    subtitle: "Artist bio from Src",
    items: [
      { label: "One", multiline: true },
      { label: "Two", multiline: true },
    ],
  });
});

it("shows only the first 10 rows of a track section", async () => {
  const T = range(12).map((i) => mkTrack(i + 1));
  api.getArtistPage.mockResolvedValue({
    artistName: "X",
    topTracks: T,
    sections: [{ type: "TRACK_LIST", title: "Popular tracks", items: T }],
  } as ArtistPageData);
  renderTv(<TvArtistScreen view={{ type: "artist", id: 9 }} />);
  expect(await screen.findByText("T10")).toBeTruthy();
  expect(screen.queryByText("T11")).toBeNull();
});

it("View all opens the artist's top tracks", async () => {
  const T = range(3).map((i) => mkTrack(i + 1));
  api.getArtistPage.mockResolvedValue({
    artistName: "X",
    topTracks: T,
    sections: [
      { type: "TRACK_LIST", title: "Popular tracks", items: T, apiPath: "v" },
      { type: "TRACK_LIST", title: "Appears on", items: [mkTrack(9)] },
    ],
  } as ArtistPageData);
  const { nav } = renderTv(<TvArtistScreen view={{ type: "artist", id: 9 }} />);
  expect(await screen.findByText("Appears on")).toBeTruthy();
  const viewAll = screen.getAllByRole("button", { name: "View all" });
  expect(viewAll).toHaveLength(1);
  expect(viewAll[0].closest("section")!.textContent).toContain(
    "Popular tracks",
  );
  fireEvent.click(viewAll[0]);
  expect(nav.push).toHaveBeenCalledWith({
    type: "artistTracks",
    artistId: 9,
    name: "X",
  });
});

it("says when the artist has nothing", async () => {
  api.getArtistPage.mockResolvedValue({
    artistName: "X",
    topTracks: [],
    sections: [],
  });
  renderTv(<TvArtistScreen view={{ type: "artist", id: 9 }} />);
  expect(
    await screen.findByText(
      "This artist doesn't have any tracks or albums yet.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Shuffle" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Biography" })).toBeNull();
});
