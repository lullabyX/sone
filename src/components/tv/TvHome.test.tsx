import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { __resetHomeFeedForTests } from "../../hooks/useHomeFeed";
import TvHome from "./TvHome";
import { renderTv, setupTvTest } from "./tvTestUtils";

setupTvTest();
const api = vi.hoisted(() => ({
  getHomePage: vi.fn(),
  getHomePageMore: vi.fn(),
  refreshHomePage: vi.fn(),
  invalidateCache: vi.fn(),
}));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()),
  ...api,
}));

beforeEach(() => {
  for (const m of Object.values(api)) m.mockReset();
  __resetHomeFeedForTests();
});

let nextId = 1;
const s = (title: string) => ({
  title,
  sectionType: "ALBUM_LIST",
  items: [{ id: nextId++, title: `${title} album`, cover: "c" }],
  hasMore: false,
});
const firstCardOf = (title: string) =>
  within(
    screen.getByRole("heading", { name: title }).closest("section")!,
  ).getAllByRole("button")[0];

it("pages in more rows only when focus nears the end, and keeps them across remounts", async () => {
  api.getHomePage.mockResolvedValue({ home: { tabs: [], sections: [s("A"), s("B"), s("C")], cursor: "c1" }, isStale: false });
  api.getHomePageMore.mockResolvedValue({ tabs: [], sections: [s("D")], cursor: null });
  const r = renderTv(<TvHome />);
  await screen.findByText("A");
  expect(api.getHomePageMore).not.toHaveBeenCalled();
  act(() => firstCardOf("B").focus());
  await screen.findByText("D");
  expect(api.getHomePageMore).toHaveBeenCalledWith("c1", "STATIC");
  r.unmount();
  renderTv(<TvHome />);
  expect(await screen.findByText("D")).toBeTruthy();
  expect(api.getHomePageMore).toHaveBeenCalledTimes(1);
});

it("refreshes a stale feed and switches tabs", async () => {
  const tabs = [
    { tabType: "STATIC", name: "For You" },
    { tabType: "MUSIC", name: "Music" },
  ];
  api.getHomePage.mockImplementation(async (feedType?: string) =>
    feedType === "MUSIC"
      ? { home: { tabs, sections: [s("Beats")], cursor: null }, isStale: false }
      : { home: { tabs, sections: [s("Old")], cursor: null }, isStale: true },
  );
  api.refreshHomePage.mockResolvedValue({ tabs, sections: [s("Fresh")], cursor: null });
  renderTv(<TvHome />);
  expect(await screen.findByText("Fresh")).toBeTruthy();
  expect(screen.queryByText("Old")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Music" }));
  expect(await screen.findByText("Beats")).toBeTruthy();
  expect(screen.queryByText("Fresh")).toBeNull();
});

it("badges explicit cards in Home rows, as the desktop", async () => {
  api.getHomePage.mockResolvedValue({ home: { tabs: [], sections: [{ title: "New", sectionType: "ALBUM_LIST", items: [{ id: 99, title: "Loud", cover: "c", explicit: true }], hasMore: false }], cursor: null }, isStale: false });
  renderTv(<TvHome />);
  expect(within((await screen.findByText("Loud")).closest("button")!).getByText("E")).toBeTruthy();
});
