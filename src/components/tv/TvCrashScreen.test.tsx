import { expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { createStore } from "jotai";
import { currentVideoAtom, videoPlayingAtom } from "../../atoms/video";
import type { TidalVideo } from "../../types";
import TvCrashScreen from "./TvCrashScreen";
import { renderTv, setupTvTest, stubLayout } from "./tvTestUtils";

setupTvTest();

it("focuses Reload, the arrows reach Exit TV mode, Enter repeat is swallowed", () => {
  const restore = stubLayout();
  try {
    const onExit = vi.fn();
    renderTv(<TvCrashScreen onReload={() => {}} onExit={onExit} />);
    const reload = screen.getByRole("button", { name: "Reload" });
    const exit = screen.getByRole("button", { name: "Exit TV mode" });
    reload.setAttribute("data-box", "0,0,100,40");
    exit.setAttribute("data-box", "110,0,100,40");
    expect(document.activeElement).toBe(reload);
    const ev = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(exit);
    const rep = new KeyboardEvent("keydown", {
      key: "Enter",
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(rep);
    expect(rep.defaultPrevented).toBe(true);
    fireEvent.click(document.activeElement!);
    expect(onExit).toHaveBeenCalled();
  } finally {
    restore();
  }
});

it("closes a playing video so it cannot cover the buttons", () => {
  const store = createStore();
  store.set(currentVideoAtom, { id: 1 } as TidalVideo);
  store.set(videoPlayingAtom, true);
  renderTv(<TvCrashScreen onReload={() => {}} onExit={() => {}} />, { store });
  expect(store.get(currentVideoAtom)).toBeNull();
  expect(store.get(videoPlayingAtom)).toBe(false);
});
