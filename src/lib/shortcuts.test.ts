import { describe, it, expect } from "vitest";
import {
  migrateBindingsV1ToV2,
  isReserved,
  ACTION_BY_ID,
  comboEquals,
  type KeyCombo,
} from "./shortcuts";

const combo = (
  code: string,
  opts: Partial<Omit<KeyCombo, "code">> = {},
): KeyCombo => ({
  code,
  mod: opts.mod ?? false,
  shift: opts.shift ?? false,
  alt: opts.alt ?? false,
});

// A full v1 map at v1 defaults, i.e. a user who never customised anything.
const V1_PRISTINE = {
  playPause: combo("Space"),
  nextTrack: combo("ArrowRight", { mod: true }),
  prevTrack: combo("ArrowLeft", { mod: true }),
  volumeUp: combo("ArrowUp"),
  volumeDown: combo("ArrowDown"),
  muteToggle: combo("KeyM"),
  likeToggle: combo("KeyL"),
  focusSearch: combo("KeyS", { mod: true }),
  refreshData: combo("KeyR", { mod: true, shift: true }),
  closeDrawer: combo("Escape"),
  zoomIn: combo("Equal", { mod: true }),
  zoomOut: combo("Minus", { mod: true }),
  zoomReset: combo("Digit0", { mod: true }),
  toggleExclusive: combo("KeyE", { mod: true }),
  toggleBitPerfect: combo("KeyB", { mod: true }),
  toggleShortcuts: combo("Slash", { shift: true }),
};

const migrate = (v1: unknown) => migrateBindingsV1ToV2(JSON.stringify(v1));

describe("migrateBindingsV1ToV2", () => {
  it("returns null when there is no v1 map", () => {
    expect(migrateBindingsV1ToV2(null)).toBeNull();
  });

  it("returns null for unparseable v1 data instead of throwing", () => {
    expect(migrateBindingsV1ToV2("{not json")).toBeNull();
    expect(migrateBindingsV1ToV2("null")).toBeNull();
    expect(migrateBindingsV1ToV2('"a string"')).toBeNull();
  });

  it("moves uncustomised volume keys onto the new Ctrl+arrow defaults", () => {
    const v2 = migrate(V1_PRISTINE)!;
    expect(comboEquals(v2.volumeUp, combo("ArrowUp", { mod: true }))).toBe(
      true,
    );
    expect(comboEquals(v2.volumeDown, combo("ArrowDown", { mod: true }))).toBe(
      true,
    );
  });

  it("moves uncustomised search onto Ctrl+K", () => {
    const v2 = migrate(V1_PRISTINE)!;
    expect(comboEquals(v2.focusSearch, combo("KeyK", { mod: true }))).toBe(
      true,
    );
  });

  it("preserves a customised binding", () => {
    const v2 = migrate({ ...V1_PRISTINE, volumeUp: combo("F5") })!;
    expect(comboEquals(v2.volumeUp, combo("F5"))).toBe(true);
  });

  it("preserves an explicitly unbound action", () => {
    const v2 = migrate({ ...V1_PRISTINE, likeToggle: null })!;
    expect(v2.likeToggle).toBeNull();
  });

  it("adds the new shuffle and repeat actions on Alt+S / Alt+R", () => {
    const v2 = migrate(V1_PRISTINE)!;
    expect(comboEquals(v2.toggleShuffle, combo("KeyS", { alt: true }))).toBe(
      true,
    );
    expect(comboEquals(v2.toggleRepeat, combo("KeyR", { alt: true }))).toBe(
      true,
    );
  });

  it("keeps closeDrawer in Part 1", () => {
    const v2 = migrate(V1_PRISTINE)!;
    expect(comboEquals(v2.closeDrawer, combo("Escape"))).toBe(true);
  });

  it("forces a fixed action back to its default even if v1 moved it", () => {
    const v2 = migrate({ ...V1_PRISTINE, refreshData: combo("F1") })!;
    expect(
      comboEquals(v2.refreshData, combo("KeyR", { mod: true, shift: true })),
    ).toBe(true);
  });

  it("lets a customisation win a collision and unbinds the new default", () => {
    const v2 = migrate({
      ...V1_PRISTINE,
      nextTrack: combo("KeyK", { mod: true }),
    })!;
    expect(comboEquals(v2.nextTrack, combo("KeyK", { mod: true }))).toBe(true);
    expect(v2.focusSearch).toBeNull();
  });

  it("never emits the same combo twice", () => {
    const v2 = migrate(V1_PRISTINE)!;
    const keys = Object.values(v2)
      .filter((c): c is KeyCombo => c !== null)
      .map((c) => `${c.code}|${c.mod}${c.shift}${c.alt}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("fixed actions", () => {
  it("marks refreshData fixed", () => {
    expect(ACTION_BY_ID.get("refreshData")?.fixed).toBe(true);
  });

  it("reserves a fixed action's combo and Ctrl+R", () => {
    expect(isReserved(combo("KeyR", { mod: true, shift: true }))).toBe(true);
    expect(isReserved(combo("KeyR", { mod: true }))).toBe(true);
  });

  it("does not reserve combos that are merely in use", () => {
    expect(isReserved(combo("KeyK", { mod: true }))).toBe(false);
  });
});
