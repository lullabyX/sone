import { expect, it, vi } from "vitest";
import { dispatchTvKey, heldKeys, padKeys, readPads, type PadInput } from "./tvGamepad";
import { setupTvTest } from "./tvTestUtils";

setupTvTest();
const pad = (pressed: number[] = [], axes = [0, 0]): PadInput =>
  ({ buttons: Array.from({ length: 17 }, (_, i) => pressed.includes(i)), axes });
const stick = (y: number) => pad([], [0, y]);
function steps(...inputs: PadInput[]) {
  let held = new Set<string>();
  return inputs.map((input) => { const next = heldKeys(input, held); const d = padKeys(held, next); held = next; return d; });
}
const none = { down: [], up: [] };
it("maps buttons", () => {
  expect(steps(pad([0]), pad())).toEqual([{ down: ["Enter"], up: [] }, { down: [], up: ["Enter"] }]);
  expect(steps(pad([1, 5]))).toEqual([{ down: ["BrowserBack", "MediaTrackNext"], up: [] }]);
  expect(steps(pad([13], [0, 0.9]))).toEqual([{ down: ["ArrowDown"], up: [] }]);
  expect(readPads([null, { buttons: [{ pressed: true }], axes: [0, 0] } as unknown as Gamepad]).buttons[0]).toBe(true);
});
it("holds the stick with hysteresis", () => {
  expect(steps(stick(0.8), stick(0.4), stick(0.2))).toEqual([{ down: ["ArrowDown"], up: [] }, none, { down: [], up: ["ArrowDown"] }]);
  expect(steps(stick(0.3), stick(0.4), stick(0.6))).toEqual([none, none, { down: ["ArrowDown"], up: [] }]);
});
it("emulates activation for an unhandled Enter, not a handled one", () => {
  const b = document.createElement("button"); const click = vi.fn(); b.onclick = click;
  document.body.append(b); b.focus();
  dispatchTvKey("keydown", "Enter");
  expect(click).toHaveBeenCalledTimes(1);
  const eat = (e: Event) => e.preventDefault();
  window.addEventListener("keydown", eat);
  dispatchTvKey("keydown", "Enter");
  window.removeEventListener("keydown", eat);
  expect(click).toHaveBeenCalledTimes(1);
  b.remove();
});
