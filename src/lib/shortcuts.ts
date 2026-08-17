import { atomWithStorage } from "jotai/utils";

export const ACTION_IDS = [
  "playPause",
  "nextTrack",
  "prevTrack",
  "volumeUp",
  "volumeDown",
  "muteToggle",
  "likeToggle",
  "toggleShuffle",
  "toggleRepeat",
  "focusSearch",
  "refreshData",
  "closeDrawer",
  "zoomIn",
  "zoomOut",
  "zoomReset",
  "toggleExclusive",
  "toggleBitPerfect",
  "toggleShortcuts",
] as const;

export type ActionId = (typeof ACTION_IDS)[number];

export type KeyCombo = {
  code: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
};

type ActionMeta = {
  id: ActionId;
  label: string;
  default: KeyCombo;
  repeatable?: boolean;
  // Not user-rebindable: always dispatched on `default`, shown read-only in the
  // shortcuts panel, and its combo is reserved against other actions.
  fixed?: boolean;
};

const c = (
  code: string,
  opts: Partial<Omit<KeyCombo, "code">> = {},
): KeyCombo => ({
  code,
  mod: opts.mod ?? false,
  shift: opts.shift ?? false,
  alt: opts.alt ?? false,
});

export const ACTION_REGISTRY: readonly ActionMeta[] = [
  { id: "playPause", label: "Play / Pause", default: c("Space") },
  {
    id: "nextTrack",
    label: "Next track",
    default: c("ArrowRight", { mod: true }),
    repeatable: false,
  },
  {
    id: "prevTrack",
    label: "Previous track",
    default: c("ArrowLeft", { mod: true }),
    repeatable: false,
  },
  { id: "volumeUp", label: "Volume up", default: c("ArrowUp", { mod: true }) },
  {
    id: "volumeDown",
    label: "Volume down",
    default: c("ArrowDown", { mod: true }),
  },
  {
    id: "muteToggle",
    label: "Mute / Unmute",
    default: c("KeyM"),
    repeatable: false,
  },
  {
    id: "likeToggle",
    label: "Like / Unlike current track",
    default: c("KeyL"),
    repeatable: false,
  },
  {
    id: "toggleShuffle",
    label: "Shuffle on / off",
    default: c("KeyS", { alt: true }),
    repeatable: false,
  },
  {
    id: "toggleRepeat",
    label: "Repeat off / all / one",
    default: c("KeyR", { alt: true }),
    repeatable: false,
  },
  {
    id: "focusSearch",
    label: "Focus search bar",
    default: c("KeyK", { mod: true }),
  },
  {
    id: "refreshData",
    label: "Refresh app data",
    default: c("KeyR", { mod: true, shift: true }),
    fixed: true,
  },
  {
    id: "closeDrawer",
    label: "Close now-playing drawer",
    default: c("Escape"),
  },
  { id: "zoomIn", label: "Zoom in", default: c("Equal", { mod: true }) },
  { id: "zoomOut", label: "Zoom out", default: c("Minus", { mod: true }) },
  {
    id: "zoomReset",
    label: "Reset zoom to 100%",
    default: c("Digit0", { mod: true }),
  },
  {
    id: "toggleExclusive",
    label: "Toggle exclusive output",
    default: c("KeyE", { mod: true }),
    repeatable: false,
  },
  {
    id: "toggleBitPerfect",
    label: "Toggle bit-perfect mode",
    default: c("KeyB", { mod: true }),
    repeatable: false,
  },
  {
    id: "toggleShortcuts",
    label: "Show keyboard shortcuts",
    default: c("Slash", { shift: true }),
  },
] as const;

export const ACTION_BY_ID: ReadonlyMap<ActionId, ActionMeta> = new Map(
  ACTION_REGISTRY.map((a) => [a.id, a]),
);

export const DEFAULT_BINDINGS: Record<ActionId, KeyCombo | null> =
  Object.fromEntries(ACTION_REGISTRY.map((a) => [a.id, a.default])) as Record<
    ActionId,
    KeyCombo | null
  >;

const RESERVED_COMBOS: readonly KeyCombo[] = [
  c("KeyR", { mod: true }),
  ...ACTION_REGISTRY.filter((a) => a.fixed).map((a) => a.default),
];

export function comboKey(combo: KeyCombo | null): string {
  if (!combo) return "";
  return `${combo.code}|${combo.mod ? "m" : ""}${combo.shift ? "s" : ""}${combo.alt ? "a" : ""}`;
}

export function comboEquals(a: KeyCombo | null, b: KeyCombo | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.code === b.code &&
    a.mod === b.mod &&
    a.shift === b.shift &&
    a.alt === b.alt
  );
}

const STORAGE_KEY_V1 = "sone.shortcuts.v1";
const STORAGE_KEY_V2 = "sone.shortcuts.v2";

// Frozen snapshot of the v1 defaults. Used only to tell "user customised this"
// apart from "user never touched this" when migrating.
const V1_DEFAULTS: Partial<Record<ActionId, KeyCombo>> = {
  playPause: c("Space"),
  nextTrack: c("ArrowRight", { mod: true }),
  prevTrack: c("ArrowLeft", { mod: true }),
  volumeUp: c("ArrowUp"),
  volumeDown: c("ArrowDown"),
  muteToggle: c("KeyM"),
  likeToggle: c("KeyL"),
  focusSearch: c("KeyS", { mod: true }),
  refreshData: c("KeyR", { mod: true, shift: true }),
  closeDrawer: c("Escape"),
  zoomIn: c("Equal", { mod: true }),
  zoomOut: c("Minus", { mod: true }),
  zoomReset: c("Digit0", { mod: true }),
  toggleExclusive: c("KeyE", { mod: true }),
  toggleBitPerfect: c("KeyB", { mod: true }),
  toggleShortcuts: c("Slash", { shift: true }),
};

function isKeyCombo(value: unknown): value is KeyCombo {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === "string" &&
    typeof v.mod === "boolean" &&
    typeof v.shift === "boolean" &&
    typeof v.alt === "boolean"
  );
}

export function migrateBindingsV1ToV2(
  v1Raw: string | null,
): Record<ActionId, KeyCombo | null> | null {
  if (!v1Raw) return null;

  let v1: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(v1Raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    v1 = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const fixed = new Map<ActionId, KeyCombo>();
  const customised = new Map<ActionId, KeyCombo | null>();
  const fromDefault = new Map<ActionId, KeyCombo | null>();

  for (const action of ACTION_REGISTRY) {
    if (action.fixed) {
      fixed.set(action.id, action.default);
      continue;
    }
    const previousDefault = V1_DEFAULTS[action.id];
    const raw = action.id in v1 ? v1[action.id] : undefined;
    // Anything that is not a well-formed combo counts as "not customised".
    const stored = raw === null || isKeyCombo(raw) ? raw : undefined;
    if (
      stored !== undefined &&
      previousDefault &&
      !comboEquals(stored, previousDefault)
    ) {
      customised.set(action.id, stored);
    } else {
      fromDefault.set(action.id, action.default);
    }
  }

  // Fixed actions claim their combo first since they can never be rebound, then
  // customisations; a later claim on a taken combo is dropped rather than
  // duplicating the binding.
  const result = {} as Record<ActionId, KeyCombo | null>;
  const claimed = new Set<string>();
  for (const [id, combo] of fixed) {
    result[id] = combo;
    claimed.add(comboKey(combo));
  }
  for (const source of [customised, fromDefault]) {
    for (const [id, combo] of source) {
      if (combo && claimed.has(comboKey(combo))) {
        result[id] = null;
        continue;
      }
      result[id] = combo;
      if (combo) claimed.add(comboKey(combo));
    }
  }
  return result;
}

function initBindingsStorage(): void {
  try {
    if (localStorage.getItem(STORAGE_KEY_V2) !== null) return;
    const migrated = migrateBindingsV1ToV2(
      localStorage.getItem(STORAGE_KEY_V1),
    );
    if (!migrated) return;
    localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(migrated));
  } catch {
    // Storage unavailable — fall through to defaults.
  }
}

initBindingsStorage();

export const shortcutsAtom = atomWithStorage<Record<ActionId, KeyCombo | null>>(
  STORAGE_KEY_V2,
  DEFAULT_BINDINGS,
);

export function isReserved(combo: KeyCombo): boolean {
  return RESERVED_COMBOS.some((r) => comboEquals(r, combo));
}

const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
]);

export function keyFromEvent(e: KeyboardEvent): KeyCombo | null {
  if (MODIFIER_CODES.has(e.code)) return null;
  return {
    code: e.code,
    mod: e.ctrlKey || e.metaKey,
    shift: e.shiftKey,
    alt: e.altKey,
  };
}

const CODE_DISPLAY: Record<string, string> = {
  Space: "Space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Del",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Equal: "=",
  Minus: "-",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
};

function codeDisplay(code: string): string {
  if (CODE_DISPLAY[code]) return CODE_DISPLAY[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num${code.slice(6)}`;
  if (/^F\d+$/.test(code)) return code;
  return code;
}

export function formatCombo(combo: KeyCombo | null): string {
  if (!combo) return "—";
  const parts: string[] = [];
  if (combo.mod) parts.push("Ctrl");
  if (combo.alt) parts.push("Alt");
  if (combo.shift) parts.push("Shift");
  parts.push(codeDisplay(combo.code));
  return parts.join(" + ");
}
