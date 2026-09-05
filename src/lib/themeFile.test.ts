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

describe("applyExternalThemeFile (watcher push)", () => {
  const FOREST_FILE = {
    version: 1,
    preset: "Forest",
    custom: { accent: "#22C55E", background: "#0E1410" },
  };

  it("applies a change pushed by the watcher", async () => {
    const { applyExternalThemeFile } = await freshThemeFile();
    let applied: unknown = undefined;
    applyExternalThemeFile(
      FOREST_FILE,
      () => CUSTOM,
      (t) => (applied = t),
    );
    expect(applied).toEqual({
      name: "Forest",
      accent: "#22C55E",
      bgBase: "#0E1410",
    });
  });

  it("is a no-op when the payload matches the current theme", async () => {
    const { applyExternalThemeFile } = await freshThemeFile();
    let applied: unknown = undefined;
    applyExternalThemeFile(
      {
        version: 1,
        preset: "custom",
        custom: { accent: "#123456", background: "#654321" },
      },
      () => CUSTOM,
      (t) => (applied = t),
    );
    expect(applied).toBeUndefined();
  });

  it("ignores an unresolvable payload (never clobbers the live theme)", async () => {
    const { applyExternalThemeFile } = await freshThemeFile();
    let applied: unknown = undefined;
    for (const bad of [
      null,
      {
        version: 2,
        preset: "custom",
        custom: { accent: "#123456", background: "#654321" },
      },
      {
        version: 1,
        preset: "Nope",
        custom: { accent: "#123456", background: "#654321" },
      },
      {
        version: 1,
        preset: "custom",
        custom: { accent: "#ZZZ", background: "#654321" },
      },
    ]) {
      applyExternalThemeFile(
        bad as never,
        () => CUSTOM,
        (t) => (applied = t),
      );
    }
    expect(applied).toBeUndefined();
  });

  // The watcher sees SONE's own write too. That echo must not be written back,
  // or write -> watch -> apply -> write loops forever.
  it("does not write back an echo of SONE's own write", async () => {
    invokeMock.mockResolvedValue(undefined);
    const { syncThemeToFile, applyExternalThemeFile } = await freshThemeFile();

    // User picks Forest in Settings; write-through persists it.
    const forest = { name: "Forest", accent: "#22C55E", bgBase: "#0E1410" };
    await syncThemeToFile(forest);
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "theme_file_set"),
    ).toHaveLength(1);

    // The watcher reports that same write back to us.
    let live = forest;
    applyExternalThemeFile(
      FOREST_FILE,
      () => live,
      (t) => (live = t),
    );
    // No re-apply, and the guard still matches, so a further write is skipped.
    await syncThemeToFile(live);
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "theme_file_set"),
    ).toHaveLength(1);
  });

  // A watcher push arrives before any bootstrap, so lastPersisted starts empty.
  // Applying must arm the guard, or the resulting atom change echoes to disk.
  it("arms the write guard so applying does not trigger a write", async () => {
    invokeMock.mockResolvedValue(undefined);
    const { applyExternalThemeFile, syncThemeToFile } = await freshThemeFile();
    let live = CUSTOM;
    applyExternalThemeFile(
      FOREST_FILE,
      () => live,
      (t) => (live = t),
    );
    await syncThemeToFile(live); // the write-through echo of setCurrent
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "theme_file_set"),
    ).toHaveLength(0);
  });
});

// The write-through subscription in AppInitializer fires once on mount, when
// jotai's atomWithStorage hydrates themeAtom from localStorage. That echo must
// never reach the file.
async function simulateLaunchEcho(theme: typeof OCEAN) {
  const { syncThemeToFile } = await import("./themeFile");
  await syncThemeToFile(theme);
}

describe("recreateThemeFile (deleted while running)", () => {
  it("writes the live theme back even though the guard already matches", async () => {
    invokeMock.mockResolvedValue(undefined);
    const { syncThemeToFile, recreateThemeFile } = await freshThemeFile();

    await syncThemeToFile(OCEAN); // arms the guard
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "theme_file_set"),
    ).toHaveLength(1);

    // File deleted externally; the watcher reports it gone.
    await recreateThemeFile(OCEAN);
    const sets = invokeMock.mock.calls.filter((c) => c[0] === "theme_file_set");
    expect(sets).toHaveLength(2);
    expect(sets[1][1].file).toEqual({
      version: 1,
      preset: "Ocean",
      custom: { accent: "#3B82F6", background: "#0E1118" },
    });
  });

  it("re-arms the guard so the recreate does not echo back", async () => {
    invokeMock.mockResolvedValue(undefined);
    const { recreateThemeFile, syncThemeToFile } = await freshThemeFile();
    await recreateThemeFile(OCEAN);
    await syncThemeToFile(OCEAN);
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "theme_file_set"),
    ).toHaveLength(1);
  });
});

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

describe("bootstrapThemeFile pushes the file theme into the atom", () => {
  it("sets themeAtom on the default store when the file resolves", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(CUSTOM));
    vi.resetModules();
    const { getDefaultStore } = await import("jotai");
    const { themeAtom } = await import("../atoms/theme");
    const { bootstrapThemeFile } = await import("./themeFile");

    invokeMock.mockResolvedValue({
      version: 1,
      preset: "Ocean",
      custom: { accent: "#3B82F6", background: "#0E1118" },
    });
    await bootstrapThemeFile();

    expect(getDefaultStore().get(themeAtom)).toEqual({
      name: "Ocean",
      accent: "#3B82F6",
      bgBase: "#0E1118",
    });
  });

  it("arms the write guard before awaiting the backend", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(OCEAN));
    vi.resetModules();
    const { bootstrapThemeFile, syncThemeToFile } = await import("./themeFile");

    // A slow read: the write-through echo fires while the IPC is in flight.
    let release: (v: unknown) => void = () => {};
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "theme_file_get"
        ? new Promise((r) => (release = r))
        : Promise.resolve(),
    );
    const pending = bootstrapThemeFile();

    // Guard must already be armed, so this echo writes nothing.
    await syncThemeToFile(OCEAN);
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "theme_file_set"),
    ).toHaveLength(0);

    release({
      version: 1,
      preset: "Ocean",
      custom: { accent: "#3B82F6", background: "#0E1118" },
    });
    await pending;
  });

  it("survives a storage write that throws", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(CUSTOM));
    vi.resetModules();
    const { bootstrapThemeFile } = await import("./themeFile");
    const setItem = localStorage.setItem;
    localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    invokeMock.mockResolvedValue({
      version: 1,
      preset: "Ocean",
      custom: { accent: "#3B82F6", background: "#0E1118" },
    });
    try {
      await expect(bootstrapThemeFile()).resolves.toBeUndefined();
    } finally {
      localStorage.setItem = setItem;
    }
  });
});
