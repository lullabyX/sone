import { beforeEach, expect, it } from "vitest";
import {
  addToSearchHistory,
  clearSearchHistory,
  loadSearchHistory,
  removeFromSearchHistory,
} from "./searchHistory";

const KEY = "sone.search-history";

beforeEach(() => localStorage.clear());

it("adds a trimmed query first, dropping a case-insensitive duplicate", () => {
  expect(addToSearchHistory(["a", "B"], " b ")).toEqual(["b", "a"]);
  expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["b", "a"]);
});

it("ignores a blank query", () => {
  expect(addToSearchHistory(["a"], "  ")).toEqual(["a"]);
  expect(localStorage.getItem(KEY)).toBeNull();
});

it("keeps the newest ten", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `q${i}`);
  const next = addToSearchHistory(ten, "new");
  expect(next).toEqual(["new", ...ten.slice(0, 9)]);
});

it("removes an exact match", () => {
  expect(removeFromSearchHistory(["b", "a"], "a")).toEqual(["b"]);
  expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["b"]);
});

it("clears", () => {
  expect(clearSearchHistory()).toEqual([]);
  expect(localStorage.getItem(KEY)).toBe("[]");
});

it("loads only strings, and nothing from bad JSON", () => {
  localStorage.setItem(KEY, JSON.stringify(["x", 3, "y"]));
  expect(loadSearchHistory()).toEqual(["x", "y"]);
  localStorage.setItem(KEY, "{oops");
  expect(loadSearchHistory()).toEqual([]);
  localStorage.setItem(KEY, JSON.stringify({ a: 1 }));
  expect(loadSearchHistory()).toEqual([]);
});
