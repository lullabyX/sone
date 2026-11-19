import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

const api = vi.hoisted(() => ({
  getHomePage: vi.fn(),
  refreshHomePage: vi.fn(),
  getHomePageMore: vi.fn(),
  invalidateCache: vi.fn(),
}));

vi.mock("../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tidal")>()),
  ...api,
}));

import {
  useHomeFeed,
  resetHomeFeed,
  __resetHomeFeedForTests,
} from "./useHomeFeed";

function later<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let nextId = 1;
const s = (title: string) => ({
  title,
  sectionType: "ALBUM_LIST",
  items: [{ id: nextId++, title: `${title} album`, cover: "c" }],
  hasMore: false,
});
const page = (sections: unknown[], cursor: string | null, isStale = false) => ({
  home: { tabs: [], sections, cursor },
  isStale,
});
const titles = (r: { current: { sections: { title: string }[] } }) =>
  r.current.sections.map((x) => x.title);

beforeEach(() => {
  for (const m of Object.values(api)) m.mockReset();
  __resetHomeFeedForTests();
});

afterEach(cleanup);

describe("useHomeFeed", () => {
  it("replaces a stale feed with the refreshed one", async () => {
    api.getHomePage.mockResolvedValue({
      home: { tabs: [], sections: [s("Old")], cursor: "c" },
      isStale: true,
    });
    api.refreshHomePage.mockResolvedValue({
      tabs: [],
      sections: [s("New")],
      cursor: "c2",
    });
    const { result } = renderHook(() => useHomeFeed("tv"));
    await waitFor(() =>
      expect(result.current.sections.map((x) => x.title)).toEqual(["New"]),
    );
  });

  it("keeps paginated sections; allowReplace never blocks the first load", async () => {
    api.getHomePage.mockResolvedValue(page([s("Old")], "c"));
    api.getHomePageMore.mockResolvedValue({
      tabs: [],
      sections: [s("More")],
      cursor: "c2",
    });
    const first = renderHook(() => useHomeFeed("tv"));
    await waitFor(() => expect(titles(first.result)).toEqual(["Old"]));
    act(() => first.result.current.loadMore());
    await waitFor(() => expect(titles(first.result)).toEqual(["Old", "More"]));

    api.getHomePage.mockResolvedValue(page([s("Newer")], "n"));
    act(() => first.result.current.revalidate(true));
    await act(async () => {});
    expect(titles(first.result)).toEqual(["Old", "More"]);
    first.unmount();

    __resetHomeFeedForTests();
    api.getHomePage.mockResolvedValue(page([s("Old")], "c", true));
    api.refreshHomePage.mockResolvedValue({
      tabs: [],
      sections: [s("New")],
      cursor: "c2",
    });
    const { result } = renderHook(() =>
      useHomeFeed("tv", { allowReplace: () => false }),
    );
    await waitFor(() => expect(titles(result)).toEqual(["Old"]));
    await waitFor(() => expect(api.refreshHomePage).toHaveBeenCalled());
    await act(async () => {});
    expect(titles(result)).toEqual(["Old"]);
  });

  it("revalidate(true) skips the five-minute minimum", async () => {
    api.getHomePage.mockResolvedValue(page([s("Old")], "c"));
    const { result } = renderHook(() => useHomeFeed("tv"));
    await waitFor(() => expect(titles(result)).toEqual(["Old"]));

    api.getHomePage.mockResolvedValue(page([s("Newer")], "n"));
    act(() => result.current.revalidate());
    await act(async () => {});
    expect(titles(result)).toEqual(["Old"]);

    act(() => result.current.revalidate(true));
    await waitFor(() => expect(titles(result)).toEqual(["Newer"]));
    expect(api.invalidateCache).toHaveBeenCalledWith("home");
  });

  it("requests a failed cursor once and a cursor once per commit", async () => {
    api.getHomePage.mockResolvedValue(page([s("Old")], "c"));
    api.getHomePageMore.mockRejectedValueOnce({
      kind: "Network",
      message: "offline",
    });
    const first = renderHook(() => useHomeFeed("tv"));
    await waitFor(() => expect(first.result.current.cursor).toBe("c"));
    act(() => first.result.current.loadMore());
    await waitFor(() => expect(first.result.current.loadingMore).toBe(false));
    act(() => first.result.current.loadMore());
    await act(async () => {});
    expect(api.getHomePageMore).toHaveBeenCalledTimes(1);
    first.unmount();

    __resetHomeFeedForTests();
    api.getHomePageMore.mockReset();
    api.getHomePageMore.mockResolvedValue({
      tabs: [],
      sections: [s("More")],
      cursor: null,
    });
    api.getHomePage.mockResolvedValue(page([s("Old")], "fresh"));
    const { result } = renderHook(() => useHomeFeed("tv"));
    await waitFor(() => expect(result.current.cursor).toBe("fresh"));
    act(() => {
      result.current.loadMore();
      result.current.loadMore();
    });
    await waitFor(() => expect(titles(result)).toEqual(["Old", "More"]));
    expect(api.getHomePageMore).toHaveBeenCalledTimes(1);
    expect(api.getHomePageMore).toHaveBeenLastCalledWith("fresh", "STATIC");
  });

  it("retryMore asks again for the page that failed", async () => {
    api.getHomePage.mockResolvedValue(page([s("Old")], "c"));
    api.getHomePageMore
      .mockRejectedValueOnce({ kind: "Network", message: "offline" })
      .mockResolvedValueOnce({ tabs: [], sections: [s("More")], cursor: null });
    const { result } = renderHook(() => useHomeFeed("tv"));
    await waitFor(() => expect(result.current.cursor).toBe("c"));
    expect(result.current.moreError).toBe(false);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.moreError).toBe(true));

    act(() => result.current.retryMore());
    await waitFor(() => expect(titles(result)).toEqual(["Old", "More"]));
    expect(result.current.moreError).toBe(false);
    expect(api.getHomePageMore).toHaveBeenCalledTimes(2);
    expect(api.getHomePageMore).toHaveBeenLastCalledWith("c", "STATIC");
  });

  it("TV and desktop keep separate tabs and pages", async () => {
    const tabs = [
      { name: "For You", tabType: "STATIC" },
      { name: "Music", tabType: "MUSIC" },
    ];
    api.getHomePage.mockImplementation(async (feedType: string) => ({
      home: {
        tabs,
        sections: [s(feedType === "MUSIC" ? "Music hits" : "For you")],
        cursor: feedType === "MUSIC" ? "m1" : "s1",
      },
      isStale: false,
    }));
    api.getHomePageMore.mockResolvedValue({
      tabs: [],
      sections: [s("More")],
      cursor: null,
    });

    const tv = renderHook(() => useHomeFeed("tv"));
    await waitFor(() => expect(tv.result.current.tabs).toEqual(tabs));
    act(() => tv.result.current.selectTab("MUSIC"));
    await waitFor(() => expect(titles(tv.result)).toEqual(["Music hits"]));
    act(() => tv.result.current.loadMore());
    await waitFor(() =>
      expect(titles(tv.result)).toEqual(["Music hits", "More"]),
    );

    const desktop = renderHook(() => useHomeFeed("desktop"));
    await waitFor(() => expect(titles(desktop.result)).toEqual(["For you"]));
    expect(desktop.result.current.activeType).toBe("STATIC");
    expect(desktop.result.current.tabs).toEqual(tabs);
    expect(titles(tv.result)).toEqual(["Music hits", "More"]);
    expect(tv.result.current.activeType).toBe("MUSIC");
  });

  it("a remount after Load more keeps the paged rows over a fresh load", async () => {
    api.getHomePage.mockResolvedValue(page([s("Old")], "c"));
    api.getHomePageMore.mockResolvedValue({
      tabs: [],
      sections: [s("More")],
      cursor: null,
    });
    const first = renderHook(() => useHomeFeed("tv"));
    await waitFor(() => expect(titles(first.result)).toEqual(["Old"]));
    act(() => first.result.current.loadMore());
    await waitFor(() => expect(titles(first.result)).toEqual(["Old", "More"]));
    first.unmount();

    api.getHomePage.mockResolvedValue(page([s("Newer")], "n"));
    const { result } = renderHook(() => useHomeFeed("tv"));
    await waitFor(() => expect(api.getHomePage).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(titles(result)).toEqual(["Old", "More"]);
  });

  it("a stale refresh that lands after Load more leaves the paged rows", async () => {
    const fresh = later<unknown>();
    api.getHomePage.mockResolvedValue(page([s("Old")], "c", true));
    api.refreshHomePage.mockReturnValue(fresh.promise);
    api.getHomePageMore.mockResolvedValue({
      tabs: [],
      sections: [s("More")],
      cursor: null,
    });
    const { result } = renderHook(() => useHomeFeed("tv"));
    await waitFor(() => expect(api.refreshHomePage).toHaveBeenCalled());
    act(() => result.current.loadMore());
    await waitFor(() => expect(titles(result)).toEqual(["Old", "More"]));
    await act(async () =>
      fresh.resolve({ tabs: [], sections: [s("New")], cursor: "c2" }),
    );
    expect(titles(result)).toEqual(["Old", "More"]);
  });

  it("resetHomeFeed drops the feed, and a request from before it lands nowhere", async () => {
    const before = later<unknown>();
    api.getHomePage.mockReturnValueOnce(before.promise);
    const first = renderHook(() => useHomeFeed("tv"));
    first.unmount();
    resetHomeFeed();
    await act(async () => before.resolve(page([s("Previous")], "p")));

    api.getHomePage.mockResolvedValue(page([s("Next")], null));
    const { result } = renderHook(() => useHomeFeed("tv"));
    expect(result.current.loading).toBe(true);
    expect(titles(result)).toEqual([]);
    await waitFor(() => expect(titles(result)).toEqual(["Next"]));
  });

  it("resetHomeFeed lets a paged feed load afresh", async () => {
    api.getHomePage.mockResolvedValue(page([s("Old")], "c"));
    api.getHomePageMore.mockResolvedValue({
      tabs: [],
      sections: [s("More")],
      cursor: null,
    });
    const first = renderHook(() => useHomeFeed("tv"));
    await waitFor(() => expect(titles(first.result)).toEqual(["Old"]));
    act(() => first.result.current.loadMore());
    await waitFor(() => expect(titles(first.result)).toEqual(["Old", "More"]));
    first.unmount();

    resetHomeFeed();
    api.getHomePage.mockResolvedValue(page([s("Other account")], null));
    const { result } = renderHook(() => useHomeFeed("tv"));
    await waitFor(() => expect(titles(result)).toEqual(["Other account"]));
  });

  it("a page loaded on another tab clears a failed page's error with its cursor", async () => {
    const tabs = [
      { name: "For You", tabType: "STATIC" },
      { name: "Music", tabType: "MUSIC" },
    ];
    api.getHomePage.mockImplementation(async (feedType: string) => ({
      home: {
        tabs,
        sections: [s(feedType)],
        cursor: feedType === "MUSIC" ? "m1" : "s1",
      },
      isStale: false,
    }));
    api.getHomePageMore
      .mockRejectedValueOnce({ kind: "Network", message: "offline" })
      .mockResolvedValueOnce({ tabs: [], sections: [s("More")], cursor: null });
    const { result } = renderHook(() => useHomeFeed("tv"));
    await waitFor(() => expect(result.current.cursor).toBe("s1"));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.moreError).toBe(true));

    act(() => result.current.selectTab("MUSIC"));
    await waitFor(() => expect(result.current.cursor).toBe("m1"));
    act(() => result.current.loadMore());
    await waitFor(() => expect(titles(result)).toEqual(["MUSIC", "More"]));

    act(() => result.current.selectTab("STATIC"));
    expect(result.current.cursor).toBe("s1");
    expect(result.current.moreError).toBe(false);
  });
});
