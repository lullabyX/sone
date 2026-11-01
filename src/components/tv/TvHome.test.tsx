import { beforeEach, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { __resetHomeFeedForTests } from "../../hooks/useHomeFeed";
import TvHome from "./TvHome";
import { deferred, renderTv, setupTvTest, stubLayout } from "./tvTestUtils";

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
const empty = (title: string) => ({
  title,
  sectionType: "ALBUM_LIST",
  items: [],
  hasMore: false,
});
const firstCardOf = (title: string) =>
  within(
    screen.getByRole("heading", { name: title }).closest("section")!,
  ).getAllByRole("button")[0];

it("pages in more rows only when focus nears the end, and keeps them across remounts", async () => {
  api.getHomePage.mockResolvedValue({
    home: { tabs: [], sections: [s("A"), s("B"), s("C")], cursor: "c1" },
    isStale: false,
  });
  api.getHomePageMore.mockResolvedValue({
    tabs: [],
    sections: [s("D")],
    cursor: "c2",
  });
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
  api.refreshHomePage.mockResolvedValue({
    tabs,
    sections: [s("Fresh")],
    cursor: null,
  });
  renderTv(<TvHome />);
  expect(await screen.findByText("Fresh")).toBeTruthy();
  expect(screen.queryByText("Old")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Music" }));
  expect(await screen.findByText("Beats")).toBeTruthy();
  expect(screen.queryByText("Fresh")).toBeNull();
});

it("badges explicit cards in Home rows, as the desktop", async () => {
  api.getHomePage.mockResolvedValue({
    home: {
      tabs: [],
      sections: [
        {
          title: "New",
          sectionType: "ALBUM_LIST",
          items: [{ id: 99, title: "Loud", cover: "c", explicit: true }],
          hasMore: false,
        },
      ],
      cursor: null,
    },
    isStale: false,
  });
  renderTv(<TvHome />);
  expect(
    within((await screen.findByText("Loud")).closest("button")!).getByText("E"),
  ).toBeTruthy();
});

it("a page whose last rows show no cards still offers Load more", async () => {
  api.getHomePage.mockResolvedValue({
    home: {
      tabs: [],
      sections: [s("A"), empty("X"), empty("Y")],
      cursor: "c1",
    },
    isStale: false,
  });
  api.getHomePageMore.mockResolvedValue({
    tabs: [],
    sections: [s("D")],
    cursor: null,
  });
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
  api.getHomePage.mockResolvedValue({
    home: { tabs: [], sections: [s("A"), s("B"), s("C")], cursor: "c1" },
    isStale: false,
  });
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
  api.getHomePage.mockResolvedValue({
    home: { tabs: [], sections: [s("A"), s("B")], cursor: null },
    isStale: true,
  });
  api.refreshHomePage.mockReturnValue(fresh.promise);
  renderTv(<TvHome />);
  await screen.findByText("A");
  act(() => firstCardOf("B").focus());
  await act(async () =>
    fresh.resolve({ tabs: [], sections: [s("Fresh")], cursor: null }),
  );
  expect(screen.queryByText("Fresh")).toBeNull();
  expect(document.activeElement).toBe(firstCardOf("B"));
});

it("applies a stale refresh while focus is on the first row", async () => {
  const fresh = deferred<unknown>();
  api.getHomePage.mockResolvedValue({
    home: { tabs: [], sections: [s("A"), s("B")], cursor: null },
    isStale: true,
  });
  api.refreshHomePage.mockReturnValue(fresh.promise);
  renderTv(<TvHome />);
  await screen.findByText("A");
  act(() => firstCardOf("A").focus());
  await act(async () =>
    fresh.resolve({ tabs: [], sections: [s("Fresh")], cursor: null }),
  );
  expect(await screen.findByText("Fresh")).toBeTruthy();
  expect(screen.queryByText("A")).toBeNull();
});

it("while covered, holds a stale refresh back when focus was last below the first row", async () => {
  const fresh = deferred<unknown>();
  api.getHomePage.mockResolvedValue({
    home: { tabs: [], sections: [s("A"), s("B")], cursor: null },
    isStale: true,
  });
  api.refreshHomePage.mockReturnValue(fresh.promise);
  renderTv(<TvHome />, { active: false });
  await screen.findByText("A");
  act(() => firstCardOf("B").focus());
  act(() => (document.activeElement as HTMLElement).blur());
  await act(async () =>
    fresh.resolve({ tabs: [], sections: [s("Fresh")], cursor: null }),
  );
  expect(screen.queryByText("Fresh")).toBeNull();
  expect(screen.getByText("B")).toBeTruthy();
});

it("while covered, applies a stale refresh when focus was last on the first row", async () => {
  const fresh = deferred<unknown>();
  api.getHomePage.mockResolvedValue({
    home: { tabs: [], sections: [s("A"), s("B")], cursor: null },
    isStale: true,
  });
  api.refreshHomePage.mockReturnValue(fresh.promise);
  renderTv(<TvHome />, { active: false });
  await screen.findByText("A");
  act(() => firstCardOf("A").focus());
  act(() => (document.activeElement as HTMLElement).blur());
  await act(async () =>
    fresh.resolve({ tabs: [], sections: [s("Fresh")], cursor: null }),
  );
  expect(await screen.findByText("Fresh")).toBeTruthy();
});

it("a page that failed on one tab shows no error while it loads again after another tab paged", async () => {
  const tabs = [
    { tabType: "STATIC", name: "For You" },
    { tabType: "MUSIC", name: "Music" },
  ];
  api.getHomePage.mockImplementation(async (feedType?: string) =>
    feedType === "MUSIC"
      ? {
          home: { tabs, sections: [s("M1"), s("M2"), s("M3")], cursor: "m1" },
          isStale: false,
        }
      : {
          home: { tabs, sections: [s("A"), s("B")], cursor: "c1" },
          isStale: false,
        },
  );
  const again = deferred<unknown>();
  api.getHomePageMore
    .mockRejectedValueOnce({ kind: "Network", message: "offline" })
    .mockResolvedValueOnce({ tabs: [], sections: [s("M4")], cursor: null })
    .mockReturnValueOnce(again.promise);
  renderTv(<TvHome />);
  await screen.findByText("A");
  act(() => firstCardOf("B").focus());
  expect(await screen.findByText("Couldn't load more")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Music" }));
  await screen.findByText("M3");
  act(() => firstCardOf("M3").focus());
  await screen.findByText("M4");

  fireEvent.click(screen.getByRole("button", { name: "For You" }));
  await screen.findByText("B");
  act(() => firstCardOf("B").focus());
  await waitFor(() => expect(api.getHomePageMore).toHaveBeenCalledTimes(3));
  expect(screen.getByRole("status", { name: "Loading more" })).toBeTruthy();
  expect(screen.queryByText("Couldn't load more")).toBeNull();
});

const myTracks = { id: "tidal://my-collection/tracks", title: "My Tracks" };
const pl1 = { uuid: "u1", title: "Road", squareImage: "i" };
const alb1 = { id: 3, title: "Blue", cover: "c" };

it("shows shortcuts as a quick-access grid led by My Tracks", async () => {
  api.getHomePage.mockResolvedValue({
    home: {
      tabs: [],
      cursor: null,
      sections: [
        {
          title: "Shortcuts",
          sectionType: "SHORTCUT_LIST",
          items: [myTracks, pl1, alb1],
        },
        s("Row"),
      ],
    },
    isStale: false,
  });
  renderTv(<TvHome />);
  const grid = await screen.findByTestId("tv-quick-access");
  expect(
    within(grid)
      .getAllByRole("button")
      .map((b) => b.textContent),
  ).toEqual(["My Tracks", "Road", "Blue"]);
  expect(grid.querySelector("[data-tv-autofocus]")!.textContent).toBe(
    "My Tracks",
  );
  expect(screen.queryByRole("heading", { name: "Shortcuts" })).toBeNull();
});

it("a quick-access track plays with only the shown tracks queued", async () => {
  const tracks = Array.from({ length: 9 }, (_, i) => ({
    id: 900 + i,
    title: `Song ${i}`,
    duration: 100,
    artist: { id: 1, name: "X" },
    album: { id: 2, title: "Y", cover: "c" },
  }));
  api.getHomePage.mockResolvedValue({
    home: {
      tabs: [],
      cursor: null,
      sections: [
        { title: "Shortcuts", sectionType: "SHORTCUT_LIST", items: tracks },
      ],
    },
    isStale: false,
  });
  const r = renderTv(<TvHome />);
  const grid = await screen.findByTestId("tv-quick-access");
  expect(within(grid).getAllByRole("button")).toHaveLength(8);
  fireEvent.click(within(grid).getByText("Song 2"));
  const [action, context] = vi.mocked(r.nav.run).mock.lastCall!;
  expect(action).toMatchObject({ kind: "playTrack", track: { id: 902 } });
  expect(context!.tracks!.map((t) => t.id)).toEqual([
    900, 901, 902, 903, 904, 905, 906,
  ]);
});

it("opens My Tracks and shortcuts from the quick-access grid", async () => {
  api.getHomePage.mockResolvedValue({
    home: {
      tabs: [],
      cursor: null,
      sections: [
        {
          title: "Shortcuts",
          sectionType: "SHORTCUT_LIST",
          items: [myTracks, pl1],
        },
      ],
    },
    isStale: false,
  });
  const r = renderTv(<TvHome />);
  const grid = await screen.findByTestId("tv-quick-access");
  fireEvent.click(within(grid).getByText("My Tracks"));
  expect(vi.mocked(r.nav.run).mock.lastCall![0]).toEqual({
    kind: "open",
    view: { type: "favorites" },
  });
  fireEvent.click(within(grid).getByText("Road"));
  expect(vi.mocked(r.nav.run).mock.lastCall![0]).toMatchObject({
    kind: "open",
    view: { type: "playlist", uuid: "u1" },
  });
  expect(
    within(grid)
      .getByText("Road")
      .closest("button")!
      .hasAttribute("data-tv-has-menu"),
  ).toBe(true);
  expect(
    within(grid)
      .getByText("My Tracks")
      .closest("button")!
      .hasAttribute("data-tv-has-menu"),
  ).toBe(false);
});

it("hands focus from Load more to the first new row below the quick access", async () => {
  api.getHomePage.mockResolvedValue({
    home: {
      tabs: [],
      cursor: "c1",
      sections: [
        { title: "Shortcuts", sectionType: "SHORTCUT_LIST", items: [pl1] },
        s("A"),
      ],
    },
    isStale: false,
  });
  api.getHomePageMore.mockResolvedValue({
    tabs: [],
    sections: [s("D")],
    cursor: null,
  });
  renderTv(<TvHome />);
  const more = await screen.findByRole("button", { name: "Load more" });
  act(() => more.focus());
  fireEvent.click(more);
  await screen.findByText("D");
  expect(document.activeElement).toBe(firstCardOf("D"));
});

it("focuses My Tracks on entry but leaves focus on a tab it switches to", async () => {
  const restore = stubLayout();
  try {
    const tabs = [
      { tabType: "STATIC", name: "For You" },
      { tabType: "MUSIC", name: "Music" },
    ];
    const shortcuts = {
      title: "Shortcuts",
      sectionType: "SHORTCUT_LIST",
      items: [pl1],
    };
    api.getHomePage.mockImplementation(async (feedType?: string) =>
      feedType === "MUSIC"
        ? {
            home: { tabs, sections: [s("Beats")], cursor: null },
            isStale: false,
          }
        : {
            home: { tabs, sections: [shortcuts, s("Mine")], cursor: null },
            isStale: false,
          },
    );
    renderTv(<TvHome />);
    const grid = await screen.findByTestId("tv-quick-access");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(grid).getByText("My Tracks").closest("button"),
      ),
    );
    const music = screen.getByRole("button", { name: "Music" });
    act(() => music.focus());
    fireEvent.click(music);
    await screen.findByText("Beats");
    expect(screen.queryByTestId("tv-quick-access")).toBeNull();
    const forYou = screen.getByRole("button", { name: "For You" });
    act(() => forYou.focus());
    fireEvent.click(forYou);
    await screen.findByTestId("tv-quick-access");
    await act(
      () => new Promise((r) => requestAnimationFrame(() => r(undefined))),
    );
    expect(document.activeElement).toBe(forYou);
  } finally {
    restore();
  }
});
