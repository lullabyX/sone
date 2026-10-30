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
