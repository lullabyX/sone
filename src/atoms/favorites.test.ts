import { beforeEach, expect, it, vi } from "vitest";
import { createStore } from "jotai";

// getOnInit reads storage when the atom module is evaluated, so each case
// seeds localStorage and then imports a fresh module instance.
beforeEach(() => {
  localStorage.clear();
});

it("trackSortPrefsAtom holds the stored prefs before anything mounts it", async () => {
  localStorage.setItem(
    "sone.trackSortPrefs.v1",
    JSON.stringify({ p: { order: "NAME", direction: "ASC" } }),
  );
  vi.resetModules();
  const { trackSortPrefsAtom } = await import("./favorites");
  expect(createStore().get(trackSortPrefsAtom)).toEqual({
    p: { order: "NAME", direction: "ASC" },
  });
});

it("trackSortPrefsAtom is empty when nothing is stored", async () => {
  vi.resetModules();
  const { trackSortPrefsAtom } = await import("./favorites");
  expect(createStore().get(trackSortPrefsAtom)).toEqual({});
});

it("library sort atoms hold the stored sort before anything mounts them", async () => {
  const stored = { order: "NAME", direction: "ASC" };
  for (const key of [
    "sone.albumSort.v1",
    "sone.artistSort.v1",
    "sone.mixSort.v1",
    "sone.playlistSort.v1",
  ]) {
    localStorage.setItem(key, JSON.stringify(stored));
  }
  vi.resetModules();
  const m = await import("./favorites");
  const store = createStore();
  expect(store.get(m.albumSortAtom)).toEqual(stored);
  expect(store.get(m.artistSortAtom)).toEqual(stored);
  expect(store.get(m.mixSortAtom)).toEqual(stored);
  expect(store.get(m.playlistSortAtom)).toEqual(stored);
});
