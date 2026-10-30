import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { __resetHomeFeedForTests } from "../../hooks/useHomeFeed";
import TvHome from "./TvHome";
import { deferred, renderTv, setupTvTest } from "./tvTestUtils";

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
const empty = (title: string) => ({ title, sectionType: "ALBUM_LIST", items: [], hasMore: false });
const firstCardOf = (title: string) =>
  within(
    screen.getByRole("heading", { name: title }).closest("section")!,
  ).getAllByRole("button")[0];

it("pages in more rows only when focus nears the end, and keeps them across remounts", async () => {
  api.getHomePage.mockResolvedValue({ home: { tabs: [], sections: [s("A"), s("B"), s("C")], cursor: "c1" }, isStale: false });
  api.getHomePageMore.mockResolvedValue({ tabs: [], sections: [s("D")], cursor: "c2" });
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

it("a page whose last rows show no cards still offers Load more", async () => {
  api.getHomePage.mockResolvedValue({ home: { tabs: [], sections: [s("A"), empty("X"), empty("Y")], cursor: "c1" }, isStale: false });
  api.getHomePageMore.mockResolvedValue({ tabs: [], sections: [s("D")], cursor: null });
  renderTv(<TvHome />);
  await screen.findByText("A");
  act(() => firstCardOf("A").focus());
  expect(api.getHomePageMore).not.toHaveBeenCalled();
  const more = screen.getByRole("button", { name: "Load more" });
  act(() => more.focus());
  fireEvent.click(more);
  await screen.findByText("D");
  expect(api.getHomePageMore).toHaveBeenCalledWith("c1", "STATIC");
  expect(document.activeElement).toBe(firstCardOf("D"));
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

it("a failed page offers Try again, which asks for it again", async () => {
  api.getHomePage.mockResolvedValue({ home: { tabs: [], sections: [s("A"), s("B"), s("C")], cursor: "c1" }, isStale: false });
  api.getHomePageMore
    .mockRejectedValueOnce({ kind: "Network", message: "offline" })
    .mockResolvedValueOnce({ tabs: [], sections: [s("D")], cursor: null });
  renderTv(<TvHome />);
  await screen.findByText("A");
  act(() => firstCardOf("B").focus());
  expect(await screen.findByText("Couldn't load more")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  const again = screen.getByRole("button", { name: "Try again" });
  act(() => again.focus());
  fireEvent.click(again);
  await screen.findByText("D");
  expect(document.activeElement).toBe(firstCardOf("D"));
  expect(api.getHomePageMore).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.getHomePageMore).mock.lastCall![0]).toBe("c1");
  expect(screen.queryByText("Couldn't load more")).toBeNull();
});

it("holds a stale refresh back while focus is below the first row", async () => {
  const fresh = deferred<unknown>();
  api.getHomePage.mockResolvedValue({ home: { tabs: [], sections: [s("A"), s("B")], cursor: null }, isStale: true });
  api.refreshHomePage.mockReturnValue(fresh.promise);
  renderTv(<TvHome />);
  await screen.findByText("A");
  act(() => firstCardOf("B").focus());
  await act(async () => fresh.resolve({ tabs: [], sections: [s("Fresh")], cursor: null }));
  expect(screen.queryByText("Fresh")).toBeNull();
  expect(document.activeElement).toBe(firstCardOf("B"));
});

it("applies a stale refresh while focus is on the first row", async () => {
  const fresh = deferred<unknown>();
  api.getHomePage.mockResolvedValue({ home: { tabs: [], sections: [s("A"), s("B")], cursor: null }, isStale: true });
  api.refreshHomePage.mockReturnValue(fresh.promise);
  renderTv(<TvHome />);
  await screen.findByText("A");
  act(() => firstCardOf("A").focus());
  await act(async () => fresh.resolve({ tabs: [], sections: [s("Fresh")], cursor: null }));
  expect(await screen.findByText("Fresh")).toBeTruthy();
  expect(screen.queryByText("A")).toBeNull();
});
