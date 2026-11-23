import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const nav = vi.hoisted(() => ({
  navigateToAlbum: vi.fn(),
  navigateToArtist: vi.fn(),
  navigateToSearch: vi.fn(),
  navigateToPlaylist: vi.fn(),
}));
vi.mock("../hooks/useNavigation", () => ({ useNavigation: () => nav }));
vi.mock("../hooks/usePlaybackActions", () => ({
  usePlaybackActions: () => ({ playSingle: vi.fn() }),
}));
vi.mock("../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tidal")>()),
  getSuggestions: vi.fn(async () => ({ textSuggestions: [], directHits: [] })),
}));

import SearchBar from "./SearchBar";

const KEY = "sone.search-history";
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null");

function renderBar() {
  render(
    <Provider store={createStore()}>
      <SearchBar />
    </Provider>,
  );
  return screen.getByPlaceholderText("Search") as HTMLInputElement;
}

beforeEach(() => {
  localStorage.clear();
  for (const fn of Object.values(nav)) fn.mockClear();
});
afterEach(cleanup);

it("lists the five newest stored searches when the box is focused", () => {
  localStorage.setItem(
    KEY,
    JSON.stringify(["a", "b", 3, "c", "d", "e", "f", "g"]),
  );
  fireEvent.focus(renderBar());
  expect(screen.getByText("Recent searches")).toBeTruthy();
  for (const q of ["a", "b", "c", "d", "e"]) {
    expect(screen.getByRole("button", { name: q })).toBeTruthy();
  }
  expect(screen.queryByRole("button", { name: "f" })).toBeNull();
});

it("Enter records the trimmed query first, without a differently cased copy", () => {
  localStorage.setItem(KEY, JSON.stringify(["Queen", "abba"]));
  const input = renderBar();
  fireEvent.change(input, { target: { value: "  queen " } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(stored()).toEqual(["queen", "abba"]);
  expect(nav.navigateToSearch).toHaveBeenCalledWith("queen");
});

it("keeps the ten newest searches", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `q${i}`);
  localStorage.setItem(KEY, JSON.stringify(ten));
  const input = renderBar();
  fireEvent.change(input, { target: { value: "new" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(stored()).toEqual(["new", ...ten.slice(0, 9)]);
});

it("picking a recent search moves it to the top and searches it", () => {
  localStorage.setItem(KEY, JSON.stringify(["a", "b"]));
  fireEvent.focus(renderBar());
  fireEvent.click(screen.getByRole("button", { name: "b" }));
  expect(stored()).toEqual(["b", "a"]);
  expect(nav.navigateToSearch).toHaveBeenCalledWith("b");
});

it("Remove drops a recent search from the list and from storage", () => {
  localStorage.setItem(KEY, JSON.stringify(["a", "b"]));
  fireEvent.focus(renderBar());
  fireEvent.click(screen.getAllByTitle("Remove")[1]);
  expect(stored()).toEqual(["a"]);
  expect(screen.queryByRole("button", { name: "b" })).toBeNull();
  expect(nav.navigateToSearch).not.toHaveBeenCalled();
});
