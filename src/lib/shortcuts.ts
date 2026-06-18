import { atomWithStorage } from "jotai/utils";

export const ACTION_IDS = [
  "playPause",
  "nextTrack",
  "prevTrack",
  "volumeUp",
  "volumeDown",
  "muteToggle",
  "likeToggle",
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
  { id: "volumeUp", label: "Volume up", default: c("ArrowUp") },
  { id: "volumeDown", label: "Volume down", default: c("ArrowDown") },
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
    id: "focusSearch",
    label: "Focus search bar",
    default: c("KeyS", { mod: true }),
  },
  {
    id: "refreshData",
    label: "Refresh app data",
    default: c("KeyR", { mod: true, shift: true }),
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

const RESERVED_COMBOS: readonly KeyCombo[] = [c("KeyR", { mod: true })];

export const shortcutsAtom = atomWithStorage<Record<ActionId, KeyCombo | null>>(
  "sone.shortcuts.v1",
  DEFAULT_BINDINGS,
);

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
