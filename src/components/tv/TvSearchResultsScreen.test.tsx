import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import type { SearchResults, TidalVideo } from "../../types";
import TvSearchResultsScreen from "./TvSearchResultsScreen";
import { mkTrack, range, renderTv, setupTvTest } from "./tvTestUtils";

setupTvTest();
const api = vi.hoisted(() => ({
  searchTidal: vi.fn(
    (_query: string, _limit?: number): Promise<SearchResults> =>
      new Promise(() => {}),
  ),
}));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()),
  ...api,
}));

beforeEach(() => {
  for (const m of Object.values(api)) m.mockReset();
});

const results = (over: Partial<SearchResults>) =>
  ({
    tracks: [],
    artists: [],
    albums: [],
    playlists: [],
    videos: [],
    ...over,
  }) as SearchResults;
const stored = () =>
  JSON.parse(localStorage.getItem("sone.search-history") ?? "[]");

it("shows every result of one kind", async () => {
  api.searchTidal.mockResolvedValueOnce(
    results({ tracks: range(30).map((i) => mkTrack(i + 1)) }),
  );
  const { nav } = renderTv(
    <TvSearchResultsScreen query="x" what="tracks" title="Tracks" />,
  );
  await screen.findByText("T5");
  expect(api.searchTidal).toHaveBeenCalledWith("x", 50);
  expect(screen.getByRole("heading", { name: "Tracks" })).toBeTruthy();
  expect(screen.getAllByRole("button")).toHaveLength(30);
  fireEvent.click(screen.getByText("T5").closest("button")!);
  const [action, queue] = vi.mocked(nav.run).mock.lastCall!;
  expect(action).toMatchObject({ kind: "playTrack", track: { id: 5 } });
  expect(queue).toMatchObject({ type: "search", name: "Search: x", id: "x" });
  expect(queue!.tracks).toHaveLength(30);
  expect(stored()).toEqual(["x"]);
});

it("queues videos and badges explicit albums", async () => {
  const vid = (i: number) =>
    ({ id: i, title: `Video ${i}`, imageId: "v", duration: 60 }) as TidalVideo;
  api.searchTidal.mockResolvedValueOnce(results({ videos: [vid(1), vid(2)] }));
  const { nav, unmount } = renderTv(
    <TvSearchResultsScreen query="x" what="videos" title="Videos" />,
  );
  fireEvent.click((await screen.findByText("Video 2")).closest("button")!);
  const [action, queue] = vi.mocked(nav.run).mock.lastCall!;
  expect(action).toMatchObject({
    kind: "playTrack",
    track: { id: 2, itemType: "video" },
  });
  expect(queue!.tracks.map((t) => t.id)).toEqual([1, 2]);
  unmount();

  api.searchTidal.mockResolvedValueOnce(
    results({
      albums: [
        { id: 4, title: "LP", cover: "c", explicit: true },
      ] as SearchResults["albums"],
    }),
  );
  renderTv(<TvSearchResultsScreen query="x" what="albums" title="Albums" />);
  expect(
    within((await screen.findByText("LP")).closest("button")!).getByText("E"),
  ).toBeTruthy();
});
