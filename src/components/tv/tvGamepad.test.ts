import { expect, it, vi } from "vitest";
import {
  dispatchTvKey,
  heldKeys,
  padKeys,
  readPads,
  type PadInput,
} from "./tvGamepad";
import { setupTvTest } from "./tvTestUtils";

setupTvTest();
const pad = (pressed: number[] = [], axes = [0, 0]): PadInput => ({
  buttons: Array.from({ length: 17 }, (_, i) => pressed.includes(i)),
  axes,
});
const stick = (y: number) => pad([], [0, y]);
function steps(...inputs: PadInput[]) {
  let held = new Set<string>();
  return inputs.map((input) => {
    const next = heldKeys(input, held);
    const d = padKeys(held, next);
    held = next;
    return d;
  });
}
const none = { down: [], up: [] };
it("maps buttons", () => {
  expect(steps(pad([0]), pad())).toEqual([
    { down: ["Enter"], up: [] },
    { down: [], up: ["Enter"] },
  ]);
  expect(steps(pad([1, 5]))).toEqual([
    { down: ["BrowserBack", "MediaTrackNext"], up: [] },
  ]);
  expect(steps(pad([13], [0, 0.9]))).toEqual([{ down: ["ArrowDown"], up: [] }]);
  expect(
    readPads([
      null,
      { buttons: [{ pressed: true }], axes: [0, 0] } as unknown as Gamepad,
    ]).buttons[0],
  ).toBe(true);
});
it("turns the volume with the triggers, once pulled past halfway", () => {
  expect(steps(pad([6]), pad([7]))).toEqual([
    { down: ["AudioVolumeDown"], up: [] },
    { down: ["AudioVolumeUp"], up: ["AudioVolumeDown"] },
  ]);
  const trigger = (value: number) =>
    readPads([
      {
        buttons: Array.from({ length: 8 }, (_, i) =>
          i === 7
            ? { pressed: value > 0.1, value }
            : { pressed: false, value: 0 },
        ),
        axes: [0, 0],
      } as unknown as Gamepad,
    ]).buttons[7];
  expect(trigger(0.3)).toBe(false);
  expect(trigger(0.6)).toBe(true);
});
// A DualSense on WebKitGTK reports "standard" but puts R2's analog value on
// axis 1 (the left stick's Y): -1 at rest, +1 pulled.
it("ignores an axis that turns out to be a trigger", () => {
  const ds = (r2: number, axis1: number) =>
    ({
      id: "DualSense",
      index: 0,
      buttons: Array.from({ length: 17 }, (_, i) =>
        i === 7
          ? { pressed: r2 > 0.1, value: r2 }
          : { pressed: false, value: 0 },
      ),
      axes: [0, axis1, 0, 0],
    }) as unknown as Gamepad;
  const triggerAxes = new Map<string, Set<number>>();
  let held = new Set<string>();
  const read = (r2: number, axis1: number) => {
    held = heldKeys(readPads([ds(r2, axis1)], triggerAxes), held);
    return [...held];
  };
  expect(read(0, 0)).toEqual([]);
  expect(read(1, 1)).toEqual(["AudioVolumeUp"]); // not ArrowDown
  expect(read(0, -1)).toEqual([]); // not a held ArrowUp
  expect(read(0, -1)).toEqual([]);
  // A real stick on a pad without that quirk still moves.
  expect([...heldKeys(readPads([ds(0, -0.9)], new Map()), new Set())]).toEqual([
    "ArrowUp",
  ]);
});
it("holds the stick with hysteresis", () => {
  expect(steps(stick(0.8), stick(0.4), stick(0.2))).toEqual([
    { down: ["ArrowDown"], up: [] },
    none,
    { down: [], up: ["ArrowDown"] },
  ]);
  expect(steps(stick(0.3), stick(0.4), stick(0.6))).toEqual([
    none,
    none,
    { down: ["ArrowDown"], up: [] },
  ]);
});
it("emulates activation for an unhandled Enter, not a handled one", () => {
  const b = document.createElement("button");
  const click = vi.fn();
  b.onclick = click;
  document.body.append(b);
  b.focus();
  dispatchTvKey("keydown", "Enter");
  expect(click).toHaveBeenCalledTimes(1);
  const eat = (e: Event) => e.preventDefault();
  window.addEventListener("keydown", eat);
  dispatchTvKey("keydown", "Enter");
  window.removeEventListener("keydown", eat);
  expect(click).toHaveBeenCalledTimes(1);
  b.remove();
});

it("the Create / View button opens the rail", () => {
  expect(steps(pad([8]))).toEqual([{ down: ["BrowserHome"], up: [] }]);
});
