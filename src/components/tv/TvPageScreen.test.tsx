import { beforeEach, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import type { HomePageResponse } from "../../types";
import TvPageScreen from "./TvPageScreen";
import { renderTv, setupTvTest } from "./tvTestUtils";

setupTvTest();
const api = vi.hoisted(() => ({
  getPageSection: vi.fn(
    (_apiPath: string): Promise<HomePageResponse> => new Promise(() => {}),
  ),
}));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()),
  ...api,
}));

beforeEach(() => {
  for (const m of Object.values(api)) m.mockReset();
});

const loud = { id: 5, title: "Loud", cover: "c", explicit: true };

it("Explore rows badge explicit albums, as the desktop's sub-page rows", async () => {
  api.getPageSection.mockResolvedValue({
    tabs: [],
    sections: [
      {
        title: "New albums",
        sectionType: "ALBUM_LIST",
        items: [loud],
        hasMore: false,
      },
      {
        title: "More",
        sectionType: "ALBUM_LIST",
        items: [{ id: 6, title: "Quiet", cover: "c" }],
        hasMore: false,
      },
    ],
  } as HomePageResponse);
  renderTv(<TvPageScreen title="Pop" apiPath="pages/pop" />);
  expect(
    within((await screen.findByText("Loud")).closest("button")!).getByText("E"),
  ).toBeTruthy();
});

it("a View all grid goes without, as the desktop's", async () => {
  api.getPageSection.mockResolvedValue({
    tabs: [],
    sections: [
      {
        title: "New albums",
        sectionType: "ALBUM_LIST",
        items: [loud],
        hasMore: false,
      },
    ],
  } as HomePageResponse);
  renderTv(<TvPageScreen title="New albums" apiPath="pages/x" all />);
  expect(
    within((await screen.findByText("Loud")).closest("button")!).queryByText(
      "E",
    ),
  ).toBeNull();
});
