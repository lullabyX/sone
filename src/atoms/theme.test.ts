import { describe, it, expect, beforeEach, vi } from "vitest";
import { createStore } from "jotai";
import { THEME_STORAGE_KEY, PRESET_THEMES, isTheme } from "../lib/theme";

const OCEAN = { name: "Ocean", accent: "#3B82F6", bgBase: "#0E1118" };

// getOnInit freezes the atom's initial value at module-import time, so each
// case must seed localStorage and THEN import a fresh module instance.
async function freshThemeAtom() {
  vi.resetModules();
  return (await import("./theme")).themeAtom;
}

beforeEach(() => {
  localStorage.clear();
});

describe("themeAtom getOnInit contract", () => {
  it("holds the stored theme before anything mounts it", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(OCEAN));
    const store = createStore();
    expect(store.get(await freshThemeAtom())).toEqual(OCEAN);
  });

  it("falls back to the default preset when nothing is stored", async () => {
    const store = createStore();
    expect(store.get(await freshThemeAtom())).toEqual(PRESET_THEMES[0]);
  });

  // Each of these is valid JSON, so without a validator it would reach the
  // atom and make deriveTheme throw at module scope -- before render().
  for (const junk of [
    "null",
    "42",
    '"ocean"',
    "{}",
    '{"nope":1}',
    '{"name":"x","accent":"zz","bgBase":"#000000"}',
    "not json at all",
  ]) {
    it(`falls back to the default preset for stored ${junk}`, async () => {
      localStorage.setItem(THEME_STORAGE_KEY, junk);
      const store = createStore();
      expect(store.get(await freshThemeAtom())).toEqual(PRESET_THEMES[0]);
    });
  }
});

describe("isTheme", () => {
  it("accepts a well-formed theme", () => {
    expect(isTheme(OCEAN)).toBe(true);
    expect(isTheme({ name: "Custom", accent: "#fff", bgBase: "#abc" })).toBe(
      true,
    );
  });

  it("rejects malformed values", () => {
    expect(isTheme(null)).toBe(false);
    expect(isTheme(42)).toBe(false);
    expect(isTheme({})).toBe(false);
    expect(isTheme({ name: "x", accent: "#3B82F6" })).toBe(false);
    expect(isTheme({ name: "x", accent: "zz", bgBase: "#000000" })).toBe(false);
  });
});
