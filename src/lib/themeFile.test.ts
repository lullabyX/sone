import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

async function freshThemeFile() {
  vi.resetModules();
  return await import("./themeFile");
}

const STORAGE_KEY = "sone.theme.v1";
const OCEAN = { name: "Ocean", accent: "#3B82F6", bgBase: "#0E1118" };
const CUSTOM = { name: "Custom", accent: "#123456", bgBase: "#654321" };

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
});

describe("bootstrapThemeFile (pre-render, §4)", () => {
  it("file wins: syncs the file's theme into localStorage", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(CUSTOM));
    const { bootstrapThemeFile } = await freshThemeFile();
    invokeMock
      .mockResolvedValueOnce({
        version: 1,
        preset: "Ocean",
        custom: { accent: "#3B82F6", background: "#0E1118" },
      })
      .mockResolvedValueOnce(undefined);
    await bootstrapThemeFile();

    expect(invokeMock).toHaveBeenCalledWith("theme_file_get");
    expect(invokeMock).not.toHaveBeenCalledWith(
      "theme_file_set",
      expect.anything(),
    );
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(OCEAN);
  });

  it("absent file is created eagerly with the current theme", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(CUSTOM));
    invokeMock
      .mockResolvedValueOnce(null) // file absent
      .mockResolvedValueOnce(undefined); // create

    const { bootstrapThemeFile } = await freshThemeFile();
    await bootstrapThemeFile();

    const setCall = invokeMock.mock.calls.find(
      (c) => c[0] === "theme_file_set",
    );
    expect(setCall).toBeDefined();
    expect(setCall![1]).toEqual({
      file: {
        version: 1,
        preset: "custom",
        custom: { accent: "#123456", background: "#654321" },
      },
    });
  });

  it("invalid file is left untouched; localStorage keeps the app theme", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(CUSTOM));
    invokeMock.mockRejectedValueOnce("unknown theme preset ...");

    const { bootstrapThemeFile } = await freshThemeFile();
    await bootstrapThemeFile();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("theme_file_get");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(CUSTOM);
  });

  it("equal file: no localStorage write", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(OCEAN));
    invokeMock.mockResolvedValueOnce({
      version: 1,
      preset: "Ocean",
      custom: { accent: "#3B82F6", background: "#0E1118" },
    });

    const { bootstrapThemeFile } = await freshThemeFile();
    await bootstrapThemeFile();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(OCEAN);
  });

  it("backend unavailable: degrades silently", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(OCEAN));
    invokeMock.mockRejectedValueOnce("ipc closed");

    const { bootstrapThemeFile } = await freshThemeFile();
    await expect(bootstrapThemeFile()).resolves.toBeUndefined();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(OCEAN);
  });
});

describe("syncThemeToFile (write-through, §5)", () => {
  it("persists a theme change", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const { syncThemeToFile } = await freshThemeFile();
    await syncThemeToFile(CUSTOM);
    expect(invokeMock).toHaveBeenCalledWith("theme_file_set", {
      file: {
        version: 1,
        preset: "custom",
        custom: { accent: "#123456", background: "#654321" },
      },
    });
  });

  it("skips no-op writes (echo of an already-persisted value)", async () => {
    invokeMock.mockResolvedValue(undefined);
    const { syncThemeToFile } = await freshThemeFile();
    await syncThemeToFile(OCEAN);
    await syncThemeToFile({ ...OCEAN }); // same theme, fresh object
    const setCalls = invokeMock.mock.calls.filter(
      (c) => c[0] === "theme_file_set",
    );
    expect(setCalls).toHaveLength(1);
  });

  it("swallows backend failures (localStorage-only mode)", async () => {
    invokeMock.mockRejectedValue("read-only fs");
    const { syncThemeToFile } = await freshThemeFile();
    await expect(syncThemeToFile(OCEAN)).resolves.toBeUndefined();
  });
});

describe("handleThemeFocusChange (window display, §6)", () => {
  it("does nothing when focused is false", async () => {
    invokeMock.mockResolvedValue(null);
    const { handleThemeFocusChange } = await freshThemeFile();
    let applied: unknown = undefined;
    await handleThemeFocusChange(
      false,
      () => CUSTOM,
      (t) => (applied = t),
    );
    expect(invokeMock).not.toHaveBeenCalled();
    expect(applied).toBeUndefined();
  });

  it("applies an external change on focused:true", async () => {
    invokeMock.mockResolvedValueOnce({
      version: 1,
      preset: "Forest",
      custom: { accent: "#22C55E", background: "#0E1410" },
    });
    const { handleThemeFocusChange } = await freshThemeFile();
    let applied: unknown = undefined;
    await handleThemeFocusChange(
      true,
      () => CUSTOM,
      (t) => (applied = t),
    );
    expect(applied).toEqual({
      name: "Forest",
      accent: "#22C55E",
      bgBase: "#0E1410",
    });
  });

  it("is a no-op when the file matches the current theme", async () => {
    invokeMock.mockResolvedValue({
      version: 1,
      preset: "custom",
      custom: { accent: "#123456", background: "#654321" },
    });
    const { handleThemeFocusChange } = await freshThemeFile();
    let applied: unknown = undefined;
    await handleThemeFocusChange(
      true,
      () => CUSTOM,
      (t) => (applied = t),
    );
    expect(applied).toBeUndefined();
    expect(invokeMock).toHaveBeenCalledTimes(1); // read only, no write
  });

  it("recreates a deleted file from the live theme", async () => {
    invokeMock
      .mockResolvedValueOnce(null) // deleted externally
      .mockResolvedValueOnce(undefined); // recreate
    const { handleThemeFocusChange } = await freshThemeFile();
    await handleThemeFocusChange(
      true,
      () => CUSTOM,
      () => {},
    );
    const setCall = invokeMock.mock.calls.find(
      (c) => c[0] === "theme_file_set",
    );
    expect(setCall).toBeDefined();
    expect(setCall![1].file.preset).toBe("custom");
  });

  it("ignores an invalid file (never clobbers)", async () => {
    invokeMock.mockRejectedValueOnce("bad hex");
    const { handleThemeFocusChange } = await freshThemeFile();
    let applied: unknown = undefined;
    await handleThemeFocusChange(
      true,
      () => CUSTOM,
      (t) => (applied = t),
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(applied).toBeUndefined();
  });
});

// The write-through subscription in AppInitializer fires once on mount, when
// jotai's atomWithStorage hydrates themeAtom from localStorage. That echo must
// never reach the file.
async function simulateLaunchEcho(theme: typeof OCEAN) {
  const { syncThemeToFile } = await import("./themeFile");
  await syncThemeToFile(theme);
}

describe("startup echo must not touch theme.json", () => {
  it("no write when the file already agrees with localStorage", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(OCEAN));
    const mod = await freshThemeFile();
    invokeMock.mockResolvedValue({
      version: 1,
      preset: "Ocean",
      custom: { accent: "#3B82F6", background: "#0E1118" },
    });
    await mod.bootstrapThemeFile();
    invokeMock.mockClear();

    await simulateLaunchEcho(OCEAN);
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "theme_file_set"),
    ).toHaveLength(0);
  });

  it("no write when the file names a preset but localStorage says Custom", async () => {
    // Colors agree, so bootstrap's themesEqual check finds nothing to do --
    // but the stored `name` still disagrees with the file's `preset`.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ name: "Custom", accent: "#3B82F6", bgBase: "#0E1118" }),
    );
    const mod = await freshThemeFile();
    invokeMock.mockResolvedValue({
      version: 1,
      preset: "Ocean",
      custom: { accent: "#3B82F6", background: "#0E1118" },
    });
    await mod.bootstrapThemeFile();
    invokeMock.mockClear();

    await simulateLaunchEcho(OCEAN);
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "theme_file_set"),
    ).toHaveLength(0);
  });

  it("never overwrites a file that failed to parse", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(CUSTOM));
    const mod = await freshThemeFile();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "theme_file_get"
        ? Promise.reject('invalid accent color "#ZZZ"')
        : Promise.resolve(),
    );
    await mod.bootstrapThemeFile();
    invokeMock.mockClear();

    await simulateLaunchEcho(CUSTOM);
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "theme_file_set"),
    ).toHaveLength(0);
  });

  it("a real theme change still repairs an unreadable file", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(CUSTOM));
    const mod = await freshThemeFile();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "theme_file_get" ? Promise.reject("bad hex") : Promise.resolve(),
    );
    await mod.bootstrapThemeFile();
    invokeMock.mockClear();

    await mod.syncThemeToFile(OCEAN); // user picks a preset in Settings
    const sets = invokeMock.mock.calls.filter((c) => c[0] === "theme_file_set");
    expect(sets).toHaveLength(1);
    expect(sets[0][1].file.preset).toBe("Ocean");
  });
});
