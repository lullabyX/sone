import { describe, it, expect } from "vitest";
import {
  PRESET_THEMES,
  normalizeHex,
  resolveThemeFile,
  themeToFile,
  themesEqual,
  type Theme,
  type ThemeFile,
} from "./theme";

const CUSTOM: Theme = { name: "Custom", accent: "#123456", bgBase: "#654321" };

describe("normalizeHex", () => {
  it("accepts #RRGGBB and uppercases", () => {
    expect(normalizeHex("#3b82f6")).toBe("#3B82F6");
  });

  it("expands #RGB", () => {
    expect(normalizeHex("#fff")).toBe("#FFFFFF");
    expect(normalizeHex("#a1b")).toBe("#AA11BB");
  });

  it("rejects malformed input", () => {
    expect(normalizeHex("3B82F6")).toBeNull();
    expect(normalizeHex("#3B82F")).toBeNull();
    expect(normalizeHex("#GGGGGG")).toBeNull();
    expect(normalizeHex("")).toBeNull();
    expect(normalizeHex("#1234567")).toBeNull();
  });
});

describe("themeToFile", () => {
  it("emits the preset name when colors exactly match a preset", () => {
    const f = themeToFile(PRESET_THEMES[3] as Theme); // Ocean
    expect(f).toEqual({
      version: 1,
      preset: "Ocean",
      custom: { accent: "#3B82F6", background: "#0E1118" },
    });
  });

  it("is case-insensitive when matching a preset's colors", () => {
    const f = themeToFile({
      name: "Ocean",
      accent: "#3b82f6",
      bgBase: "#0e1118",
    });
    expect(f.preset).toBe("Ocean");
    expect(f.custom.accent).toBe("#3B82F6");
  });

  it("leaves a Custom theme custom even on a preset's exact colors", () => {
    const f = themeToFile({
      name: "Custom",
      accent: "#3b82f6",
      bgBase: "#0e1118",
    });
    expect(f.preset).toBe("custom");
    expect(f.custom.accent).toBe("#3B82F6");
  });

  it("falls back to custom", () => {
    const f = themeToFile(CUSTOM);
    expect(f).toEqual({
      version: 1,
      preset: "custom",
      custom: { accent: "#123456", background: "#654321" },
    });
  });

  it("expands #RGB on write", () => {
    const f = themeToFile({ name: "Custom", accent: "#fff", bgBase: "#abc" });
    expect(f.custom).toEqual({ accent: "#FFFFFF", background: "#AABBCC" });
  });
});

describe("resolveThemeFile", () => {
  it("resolves a custom file to its colors", () => {
    const t = resolveThemeFile({
      preset: "custom",
      custom: { accent: "#123456", background: "#654321" },
    });
    expect(t).toEqual({ name: "Custom", accent: "#123456", bgBase: "#654321" });
  });

  it("treats a missing version as 1", () => {
    const t = resolveThemeFile({
      preset: "custom",
      custom: { accent: "#123456", background: "#654321" },
    });
    expect(t).not.toBeNull();
  });

  it("expands #RGB", () => {
    const t = resolveThemeFile({
      version: 1,
      preset: "custom",
      custom: { accent: "#fff", background: "#000" },
    });
    expect(t).toEqual({ name: "Custom", accent: "#FFFFFF", bgBase: "#000000" });
  });

  it("lets the named preset win over mismatched custom colors", () => {
    const t = resolveThemeFile({
      version: 1,
      preset: "Ocean",
      custom: { accent: "#111111", background: "#222222" },
    });
    expect(t).toEqual({ name: "Ocean", accent: "#3B82F6", bgBase: "#0E1118" });
  });

  it("round-trips every preset", () => {
    for (const preset of PRESET_THEMES) {
      const file = themeToFile(preset);
      expect(file.preset).toBe(preset.name);
      const resolved = resolveThemeFile(file);
      expect(resolved).not.toBeNull();
      expect(themesEqual(resolved!, preset)).toBe(true);
    }
  });

  it("round-trips custom", () => {
    const resolved = resolveThemeFile(themeToFile(CUSTOM));
    expect(resolved).toEqual(CUSTOM);
  });

  it("rejects unknown versions", () => {
    expect(
      resolveThemeFile({
        version: 2,
        preset: "custom",
        custom: { accent: "#123456", background: "#654321" },
      }),
    ).toBeNull();
  });

  it("rejects unknown presets (case-sensitive)", () => {
    const base: ThemeFile = {
      preset: "ocean",
      custom: { accent: "#3B82F6", background: "#0E1118" },
    };
    expect(resolveThemeFile(base)).toBeNull();
    base.preset = "Solarized";
    expect(resolveThemeFile(base)).toBeNull();
  });

  it("rejects malformed hex", () => {
    expect(
      resolveThemeFile({
        preset: "custom",
        custom: { accent: "#GGG", background: "#654321" },
      }),
    ).toBeNull();
    expect(
      resolveThemeFile({
        preset: "custom",
        custom: { accent: "#12345", background: "#654321" },
      }),
    ).toBeNull();
  });

  it("rejects missing or malformed custom", () => {
    expect(
      resolveThemeFile({ preset: "custom" } as unknown as ThemeFile),
    ).toBeNull();
    expect(
      resolveThemeFile({
        preset: "custom",
        custom: { accent: "#123456" },
      } as unknown as ThemeFile),
    ).toBeNull();
    expect(resolveThemeFile(null)).toBeNull();
    expect(resolveThemeFile("garbage" as unknown as ThemeFile)).toBeNull();
  });
});

describe("themesEqual", () => {
  it("ignores name and case", () => {
    expect(
      themesEqual(
        { name: "Ocean", accent: "#3b82f6", bgBase: "#0e1118" },
        { name: "Custom", accent: "#3B82F6", bgBase: "#0E1118" },
      ),
    ).toBe(true);
  });

  it("distinguishes different colors", () => {
    expect(
      themesEqual(
        { name: "a", accent: "#111111", bgBase: "#000000" },
        { name: "b", accent: "#111111", bgBase: "#000001" },
      ),
    ).toBe(false);
  });
});

describe("themeToFile round-trip fidelity", () => {
  const roundTrip = (f: ThemeFile) => themeToFile(resolveThemeFile(f)!);

  it("keeps preset:'custom' when the colors happen to equal a preset", () => {
    const file: ThemeFile = {
      version: 1,
      preset: "custom",
      custom: { accent: "#3B82F6", background: "#0E1118" }, // == Ocean
    };
    expect(roundTrip(file)).toEqual(file);
  });

  it("keeps a named preset", () => {
    const file: ThemeFile = {
      version: 1,
      preset: "Forest",
      custom: { accent: "#22C55E", background: "#0E1410" },
    };
    expect(roundTrip(file)).toEqual(file);
  });

  it("does not trust a theme name whose colors no longer match the preset", () => {
    // A stale localStorage entry claiming to be Ocean with edited colors is
    // a custom theme, not Ocean.
    expect(
      themeToFile({ name: "Ocean", accent: "#FF00AA", bgBase: "#101010" }),
    ).toEqual({
      version: 1,
      preset: "custom",
      custom: { accent: "#FF00AA", background: "#101010" },
    });
  });
});
