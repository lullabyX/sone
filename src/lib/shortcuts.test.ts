import { describe, it, expect } from "vitest";
import {
  migrateBindingsV1ToV2,
  isReserved,
  ACTION_BY_ID,
  ACTION_REGISTRY,
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

  it("drops closeDrawer now that the dismissal stack owns Escape", () => {
    const v2 = migrate(V1_PRISTINE)! as Record<string, unknown>;
    expect("closeDrawer" in v2).toBe(false);
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

  it("adopts the new defaults for ids absent from a partial v1 map", () => {
    const partial: Record<string, unknown> = { ...V1_PRISTINE };
    delete partial.volumeUp;
    delete partial.volumeDown;
    delete partial.focusSearch;
    delete partial.muteToggle;
    const v2 = migrate(partial)!;
    expect(comboEquals(v2.volumeUp, combo("ArrowUp", { mod: true }))).toBe(
      true,
    );
    expect(comboEquals(v2.volumeDown, combo("ArrowDown", { mod: true }))).toBe(
      true,
    );
    expect(comboEquals(v2.focusSearch, combo("KeyK", { mod: true }))).toBe(
      true,
    );
    expect(comboEquals(v2.muteToggle, combo("KeyM"))).toBe(true);
  });

  it("keeps a fixed action bound when a v1 customisation collides with it", () => {
    const v2 = migrate({
      ...V1_PRISTINE,
      zoomIn: combo("KeyR", { mod: true, shift: true }),
    })!;
    expect(
      comboEquals(v2.refreshData, combo("KeyR", { mod: true, shift: true })),
    ).toBe(true);
    expect(comboEquals(v2.zoomIn, combo("Equal", { mod: true }))).toBe(true);
  });

  it("treats a v1 binding on a stack-owned key as uncustomised", () => {
    const v2 = migrate({ ...V1_PRISTINE, zoomOut: combo("Escape") })!;
    expect(comboEquals(v2.zoomOut, combo("Minus", { mod: true }))).toBe(true);
  });

  it("treats a v1 binding on Ctrl+R as uncustomised", () => {
    const v2 = migrate({
      ...V1_PRISTINE,
      likeToggle: combo("KeyR", { mod: true }),
    })!;
    expect(comboEquals(v2.likeToggle, combo("KeyL"))).toBe(true);
  });

  it("treats corrupt v1 entries as uncustomised", () => {
    const v2 = migrate({
      ...V1_PRISTINE,
      volumeUp: 5,
      muteToggle: "x",
      likeToggle: { code: "KeyL" },
      zoomIn: [],
    })!;
    expect(comboEquals(v2.volumeUp, combo("ArrowUp", { mod: true }))).toBe(
      true,
    );
    expect(comboEquals(v2.muteToggle, combo("KeyM"))).toBe(true);
    expect(comboEquals(v2.likeToggle, combo("KeyL"))).toBe(true);
    expect(comboEquals(v2.zoomIn, combo("Equal", { mod: true }))).toBe(true);
  });

  it("never emits the same combo twice", () => {
    const colliding: Record<string, unknown> = {
      ...V1_PRISTINE,
      nextTrack: combo("KeyK", { mod: true }),
      prevTrack: combo("ArrowUp", { mod: true }),
      volumeDown: combo("KeyS", { alt: true }),
      zoomIn: combo("KeyR", { mod: true, shift: true }),
    };
    delete colliding.focusSearch;

    for (const v1 of [V1_PRISTINE, colliding]) {
      const keys = Object.values(migrate(v1)!)
        .filter((c): c is KeyCombo => c !== null)
        .map((c) => `${c.code}|${c.mod}${c.shift}${c.alt}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
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

  it("reserves the keys the dismissal stack owns", () => {
    expect(isReserved(combo("Escape"))).toBe(true);
  });

  it("never ships a rebindable action whose default is reserved", () => {
    for (const action of ACTION_REGISTRY) {
      if (action.fixed) continue;
      expect(isReserved(action.default)).toBe(false);
    }
  });
});
