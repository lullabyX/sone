import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { SearchResults } from "../../types";
import TvSearch from "./TvSearch";
import { menuForElement } from "./tvMenu";
import { deferred, mkTrack, pressKey, renderTv, setupTvTest, stubLayout } from "./tvTestUtils";

setupTvTest();
const searchTidal = vi.hoisted(() =>
  vi.fn((_query: string, _limit?: number): Promise<SearchResults> => new Promise(() => {})));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()), searchTidal }));
beforeEach(() => { searchTidal.mockReset(); });
const stored = () => JSON.parse(localStorage.getItem("sone.search-history") ?? "[]");
const oneTrack = () => ({ tracks: [mkTrack(1)], artists: [], albums: [], playlists: [], videos: [] }) as unknown as SearchResults;
it("does not pull typing out of an open prompt", () => {
  renderTv(<><TvSearch /><div data-tv-modal><button>ok</button></div></>);
  const ok = screen.getByText("ok");
  ok.focus();
  pressKey(ok, { key: "a" });
  expect(document.activeElement).toBe(ok);
  expect((screen.getByPlaceholderText("Search TIDAL") as HTMLInputElement).value).toBe("");
});
it("shows recent searches and re-runs one", async () => {
  localStorage.setItem("sone.search-history", JSON.stringify(["miles davis"]));
  renderTv(<TvSearch />);
  fireEvent.click(await screen.findByRole("button", { name: "miles davis" }));
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("miles davis");
});
it("shows no recent searches when there are none", () => {
  renderTv(<TvSearch />);
  expect(screen.queryByText("Recent searches")).toBeNull();
  expect(screen.queryByRole("button", { name: "Clear recent searches" })).toBeNull();
});
// Recent-search queries are words of several letters: the on-screen keyboard is always rendered, and its letter keys
// are buttons named "a", "b", …, so one-letter queries would match those keys.
it("removes a recent search from its menu", async () => {
  localStorage.setItem("sone.search-history", JSON.stringify(["jazz", "blues"]));
  renderTv(<TvSearch />);
  const spec = menuForElement(await screen.findByRole("button", { name: "jazz" }))!();
  const remove = spec.items.find((i) => i.label === "Remove from recent searches")!;
  act(() => void remove.onSelect!());
  expect(screen.queryByRole("button", { name: "jazz" })).toBeNull();
  expect(screen.getByRole("button", { name: "blues" })).toBeTruthy();
  expect(stored()).toEqual(["blues"]);
});
it("keeps focus in the list after a removal, and on the keys once it is empty", async () => {
  const restore = stubLayout();
  try {
    localStorage.setItem("sone.search-history", JSON.stringify(["jazz", "blues"]));
    const { nav } = renderTv(<TvSearch />);
    const jazz = await screen.findByRole("button", { name: "jazz" });
    jazz.focus();
    act(() => void menuForElement(jazz)!().items[0].onSelect!());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "blues" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear recent searches" }));
    act(() => void vi.mocked(nav.openMenu).mock.lastCall![0].items[1].onSelect!());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "a" }));
  } finally {
    restore();
  }
});
it("records a search only when it is committed", async () => {
  vi.mocked(searchTidal).mockResolvedValueOnce(oneTrack());
  const { nav } = renderTv(<TvSearch />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "abc" } });
  const card = (await screen.findByText("T1")).closest("button")!;
  expect(stored()).toEqual([]);
  fireEvent.click(card);
  expect(stored()).toEqual(["abc"]);
  expect(nav.run).toHaveBeenCalled();
});
it("the keyboard's Search key records the query", () => {
  renderTv(<TvSearch />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "xyz" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(stored()).toEqual(["xyz"]);
});
it("Enter in the search box records the query, but not while composing", () => {
  renderTv(<TvSearch />);
  const box = screen.getByRole("textbox");
  fireEvent.change(box, { target: { value: "jazz" } });
  fireEvent.keyDown(box, { key: "Enter", isComposing: true });
  expect(stored()).toEqual([]);
  fireEvent.keyDown(box, { key: "Enter" });
  fireEvent.keyDown(box, { key: "Enter", repeat: true });
  expect(stored()).toEqual(["jazz"]);
});
it("clears recent searches after a confirmation that leads with Cancel", async () => {
  localStorage.setItem("sone.search-history", JSON.stringify(["jazz", "blues"]));
  const { nav } = renderTv(<TvSearch />);
  fireEvent.click(await screen.findByRole("button", { name: "Clear recent searches" }));
  const spec = vi.mocked(nav.openMenu).mock.lastCall![0];
  expect(spec.items.map((i) => i.label)).toEqual(["Cancel", "Clear"]);
  act(() => void spec.items[1].onSelect!());
  expect(screen.queryByRole("button", { name: "jazz" })).toBeNull();
  expect(stored()).toEqual([]);
});
it("the Search key moves focus to the first result, now or once it arrives", async () => {
  const restore = stubLayout();
  try {
    vi.mocked(searchTidal).mockResolvedValueOnce(oneTrack());
    renderTv(<TvSearch />);
    const box = screen.getByRole("textbox");
    const key = screen.getByRole("button", { name: "Search" });
    fireEvent.change(box, { target: { value: "abc" } });
    const card = (await screen.findByText("T1")).closest("button")!;
    key.focus();
    fireEvent.click(key);
    expect(document.activeElement).toBe(card);

    const later = deferred<SearchResults>();
    vi.mocked(searchTidal).mockReturnValueOnce(later.promise);
    fireEvent.change(box, { target: { value: "abcd" } });
    key.focus();
    fireEvent.click(key);
    expect(document.activeElement).toBe(key);
    await waitFor(() => expect(searchTidal).toHaveBeenCalledTimes(2));
    await act(async () => later.resolve({ ...oneTrack(), tracks: [mkTrack(2)] }));
    expect(document.activeElement).toBe(screen.getByText("T2").closest("button"));
  } finally {
    restore();
  }
});
it("a late result leaves focus alone once the user has moved on", async () => {
  const restore = stubLayout();
  try {
    const later = deferred<SearchResults>();
    vi.mocked(searchTidal).mockReturnValueOnce(later.promise);
    renderTv(<TvSearch />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "abc" } });
    const key = screen.getByRole("button", { name: "Search" });
    key.focus();
    fireEvent.click(key);
    const other = screen.getByText("b");
    other.focus();
    await waitFor(() => expect(searchTidal).toHaveBeenCalledTimes(1));
    await act(async () => later.resolve(oneTrack()));
    await screen.findByText("T1");
    expect(document.activeElement).toBe(other);
  } finally {
    restore();
  }
});
it("picking a recent search moves focus to the Search key, recording nothing yet", async () => {
  localStorage.setItem("sone.search-history", JSON.stringify(["jazz", "miles davis"]));
  renderTv(<TvSearch />);
  const recent = await screen.findByRole("button", { name: "miles davis" });
  recent.focus();
  fireEvent.click(recent);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Search" }));
  expect(stored()).toEqual(["jazz", "miles davis"]);
});
