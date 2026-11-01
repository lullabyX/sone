import { expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { createStore } from "jotai";
import { useShortcuts } from "../../hooks/useShortcuts";
import { currentVideoAtom, videoExpandedAtom } from "../../atoms/video";
import TvKeyboard from "./TvKeyboard";
import { pressKey, renderTv, setupTvTest, type TvStore } from "./tvTestUtils";

setupTvTest();
function Shortcuts(p: { muteToggle: () => void; playPause: () => void }) { useShortcuts(p); return null; }
function setup(empty?: boolean, store?: TvStore) {
  const onChange = vi.fn(), muteToggle = vi.fn(), playPause = vi.fn();
  renderTv(<><Shortcuts muteToggle={muteToggle} playPause={playPause} />
    <TvKeyboard onChange={onChange} empty={empty} /><button>outside</button></>, { store });
  return { onChange, muteToggle, playPause, key: screen.getByText("a"), outside: screen.getByText("outside") };
}
it("does not fire desktop shortcuts while typing on it", () => {
  const { key, onChange, muteToggle, playPause } = setup();
  key.focus();
  pressKey(key, { key: "m", code: "KeyM" });
  pressKey(key, { key: " ", code: "Space" });
  expect(onChange).toHaveBeenCalledTimes(2);
  expect(muteToggle).not.toHaveBeenCalled();
  expect(playPause).not.toHaveBeenCalled();
});
it("leaves Backspace alone when focus is elsewhere", () => {
  const { outside, onChange } = setup();
  outside.focus();
  expect(pressKey(outside, { key: "Backspace" }).defaultPrevented).toBe(false);
  expect(onChange).not.toHaveBeenCalled();
});
it("passes Backspace on when empty, swallows its auto-repeat", () => {
  const { key } = setup(true);
  key.focus();
  expect(pressKey(key, { key: "Backspace" }).defaultPrevented).toBe(false);
  expect(pressKey(key, { key: "Backspace", repeat: true }).defaultPrevented).toBe(true);
});
it("stands down while a video is full screen", () => {
  const store = createStore();
  store.set(currentVideoAtom, { id: 1 } as never);
  store.set(videoExpandedAtom, true);
  const { key } = setup(false, store);
  key.focus();
  expect(pressKey(key, { key: "Backspace" }).defaultPrevented).toBe(false);
});
it("types capitals and symbols", () => {
  const onChange = vi.fn();
  renderTv(<TvKeyboard onChange={onChange} />);
  const apply = (t: string) => onChange.mock.lastCall![0](t);
  fireEvent.click(screen.getByLabelText("Shift"));
  fireEvent.click(screen.getByText("A"));
  expect(apply("")).toBe("A");
  fireEvent.click(screen.getByLabelText("Symbols"));
  fireEvent.click(screen.getByText("."));
  expect(apply("x")).toBe("x.");
  expect(screen.getByLabelText("Letters")).toBeTruthy();
});
it("keeps focus on the toggle key across a case or layer switch", () => {
  renderTv(<TvKeyboard onChange={vi.fn()} />);
  const shift = screen.getByLabelText("Shift");
  shift.focus();
  fireEvent.click(shift);
  expect(document.activeElement).toBe(shift);
  expect(shift.getAttribute("aria-pressed")).toBe("true");
  const layer = screen.getByLabelText("Symbols");
  layer.focus();
  fireEvent.click(layer);
  expect(document.activeElement).toBe(layer);
  expect(layer.getAttribute("aria-label")).toBe("Letters");
});
it("has a Search key only when asked", () => {
  const onSubmit = vi.fn();
  const { unmount } = renderTv(<TvKeyboard onChange={vi.fn()} onSubmit={onSubmit} />);
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  unmount();
  renderTv(<TvKeyboard onChange={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
});
