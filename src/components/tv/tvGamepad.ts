export interface PadInput {
  buttons: boolean[];
  axes: number[];
}

// Standard mapping, in button-index order.
const BUTTON_KEYS: [number, string][] = [
  [0, "Enter"],
  [1, "BrowserBack"],
  [3, "ContextMenu"],
  [4, "MediaTrackPrevious"],
  [5, "MediaTrackNext"],
  [6, "AudioVolumeDown"],
  [7, "AudioVolumeUp"],
  [8, "BrowserHome"],
  [9, "ContextMenu"],
  [12, "ArrowUp"],
  [13, "ArrowDown"],
  [14, "ArrowLeft"],
  [15, "ArrowRight"],
];
const STICK_PRESS = 0.5;
const STICK_HOLD = 0.35;
// The analog triggers count once pulled past halfway, so a resting finger
// doesn't turn the volume.
const TRIGGERS = new Set([6, 7]);
const TRIGGER_PRESS = 0.5;

/**
 * Every connected pad OR-ed into one: any press counts, the largest axis wins.
 * Some pads report the standard mapping but also put a trigger's analog value
 * on a stick axis (a DualSense on WebKitGTK: R2 on axis 1, -1 at rest). An
 * axis that reads fully on while a trigger is fully pulled is remembered in
 * `triggerAxes` (per pad) and ignored from then on.
 */
export function readPads(
  pads: readonly (Gamepad | null)[],
  triggerAxes?: Map<string, Set<number>>,
): PadInput {
  const input: PadInput = { buttons: [], axes: [] };
  for (const pad of pads) {
    if (!pad) continue;
    const padKey = `${pad.index}:${pad.id}`;
    let ignored = triggerAxes?.get(padKey);
    const pulled = [...TRIGGERS].some(
      (i) => (pad.buttons[i]?.value ?? 0) >= 0.9,
    );
    if (triggerAxes && pulled) {
      pad.axes.forEach((v, i) => {
        if (v < 0.9) return;
        if (!ignored) triggerAxes.set(padKey, (ignored = new Set()));
        ignored.add(i);
      });
    }
    pad.buttons.forEach((b, i) => {
      const on =
        TRIGGERS.has(i) && typeof b.value === "number"
          ? b.value >= TRIGGER_PRESS
          : b.pressed;
      input.buttons[i] = !!input.buttons[i] || on;
    });
    pad.axes.forEach((v, i) => {
      if (ignored?.has(i)) return;
      const cur = input.axes[i] ?? 0;
      input.axes[i] = Math.abs(v) > Math.abs(cur) ? v : cur;
    });
  }
  return input;
}

/** The keys the pad holds down; the left stick needs less to stay held than to press. */
export function heldKeys(input: PadInput, prev: Set<string>): Set<string> {
  const next = new Set<string>();
  for (const [i, key] of BUTTON_KEYS) if (input.buttons[i]) next.add(key);
  const stick = (v: number, neg: string, pos: string) => {
    const key = v < 0 ? neg : pos;
    if (Math.abs(v) >= (prev.has(key) ? STICK_HOLD : STICK_PRESS))
      next.add(key);
  };
  stick(input.axes[0] ?? 0, "ArrowLeft", "ArrowRight");
  stick(input.axes[1] ?? 0, "ArrowUp", "ArrowDown");
  return next;
}

export function padKeys(
  prev: Set<string>,
  next: Set<string>,
): { down: string[]; up: string[] } {
  return {
    down: [...next].filter((k) => !prev.has(k)),
    up: [...prev].filter((k) => !next.has(k)),
  };
}

/**
 * Sends a key to the focused element like a remote would. `code` stays
 * empty so no desktop shortcut matches. A synthetic Enter has no default
 * action, so an Enter nobody handled clicks the focused element itself.
 */
export function dispatchTvKey(
  type: "keydown" | "keyup",
  key: string,
  repeat = false,
): void {
  const target = document.activeElement ?? document.body;
  const unhandled = target.dispatchEvent(
    new KeyboardEvent(type, {
      key,
      code: "",
      bubbles: true,
      cancelable: true,
      repeat,
    }),
  );
  if (
    unhandled &&
    type === "keydown" &&
    key === "Enter" &&
    target instanceof HTMLElement &&
    target !== document.body
  ) {
    target.click();
  }
}
