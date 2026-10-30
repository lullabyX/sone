import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setupTvTest } from "./tvTestUtils";
import { useTvGamepad } from "./useTvGamepad";

setupTvTest();
const padObj = (pressed: number[]) => ({ connected: true, mapping: "standard",
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })), axes: [0, 0] });
let current: ReturnType<typeof padObj>;
let seen: [string, string, boolean][];
const spy = (e: KeyboardEvent) => seen.push([e.type, e.key, e.repeat]);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  seen = []; current = padObj([]);
  Object.defineProperty(navigator, "getGamepads", { value: vi.fn(() => [current]), configurable: true });
  window.addEventListener("keydown", spy); window.addEventListener("keyup", spy);
});
afterEach(() => {
  window.removeEventListener("keydown", spy); window.removeEventListener("keyup", spy);
  delete (navigator as { getGamepads?: unknown }).getGamepads;
});
it("repeats a held d-pad, then releases it", () => {
  renderHook(() => useTvGamepad(true));
  current = padObj([13]);
  act(() => { window.dispatchEvent(new Event("gamepadconnected")); vi.advanceTimersByTime(20); });
  act(() => vi.advanceTimersByTime(400 + 120));
  expect(seen).toEqual([["keydown", "ArrowDown", false], ["keydown", "ArrowDown", true], ["keydown", "ArrowDown", true]]);
  current = padObj([]);
  act(() => vi.advanceTimersByTime(500));
  expect(seen.slice(3)).toEqual([["keyup", "ArrowDown", false]]);
});
it("releases held keys on unmount", () => {
  const { unmount } = renderHook(() => useTvGamepad(true));
  current = padObj([0]);
  act(() => { window.dispatchEvent(new Event("gamepadconnected")); vi.advanceTimersByTime(20); });
  unmount();
  expect(seen).toEqual([["keydown", "Enter", false], ["keyup", "Enter", false]]);
});
it("does nothing without gamepad support", () => {
  delete (navigator as { getGamepads?: unknown }).getGamepads;
  const add = vi.spyOn(window, "addEventListener");
  renderHook(() => useTvGamepad(true));
  expect(add).not.toHaveBeenCalledWith("gamepadconnected", expect.anything());
  add.mockRestore();
});
