import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";

import { useShortcuts } from "./useShortcuts";
import { shortcutsAtom, DEFAULT_BINDINGS } from "../lib/shortcuts";

function press(init: KeyboardEventInit) {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { ...init, bubbles: true }),
  );
}

function mount(
  dispatch: Parameters<typeof useShortcuts>[0],
  bindings = DEFAULT_BINDINGS,
) {
  const store = createStore();
  store.set(shortcutsAtom, bindings);
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>{children}</Provider>
  );
  renderHook(() => useShortcuts(dispatch), { wrapper });
}

describe("useShortcuts", () => {
  beforeEach(() => cleanup());

  it("fires volume up on Ctrl+ArrowUp", () => {
    const volumeUp = vi.fn();
    mount({ volumeUp });
    press({ code: "ArrowUp", ctrlKey: true });
    expect(volumeUp).toHaveBeenCalledTimes(1);
  });

  it("ignores a bare ArrowUp so it can scroll", () => {
    const volumeUp = vi.fn();
    mount({ volumeUp });
    press({ code: "ArrowUp" });
    expect(volumeUp).not.toHaveBeenCalled();
  });

  it("fires search on Ctrl+K and not on Ctrl+S", () => {
    const focusSearch = vi.fn();
    mount({ focusSearch });
    press({ code: "KeyS", ctrlKey: true });
    expect(focusSearch).not.toHaveBeenCalled();
    press({ code: "KeyK", ctrlKey: true });
    expect(focusSearch).toHaveBeenCalledTimes(1);
  });

  it("fires shuffle on Alt+S and repeat on Alt+R", () => {
    const toggleShuffle = vi.fn();
    const toggleRepeat = vi.fn();
    mount({ toggleShuffle, toggleRepeat });
    press({ code: "KeyS", altKey: true });
    press({ code: "KeyR", altKey: true });
    expect(toggleShuffle).toHaveBeenCalledTimes(1);
    expect(toggleRepeat).toHaveBeenCalledTimes(1);
  });

  it("dispatches a fixed action on its default even when storage moved it", () => {
    const refreshData = vi.fn();
    mount(
      { refreshData },
      {
        ...DEFAULT_BINDINGS,
        refreshData: { code: "F1", mod: false, shift: false, alt: false },
      },
    );
    press({ code: "F1" });
    expect(refreshData).not.toHaveBeenCalled();
    press({ code: "KeyR", ctrlKey: true, shiftKey: true });
    expect(refreshData).toHaveBeenCalledTimes(1);
  });

  it("keeps a fixed combo when a later-sorting action stores it", () => {
    const refreshData = vi.fn();
    const volumeUp = vi.fn();
    mount(
      { refreshData, volumeUp },
      {
        ...DEFAULT_BINDINGS,
        volumeUp: { code: "KeyR", mod: true, shift: true, alt: false },
      },
    );
    press({ code: "KeyR", ctrlKey: true, shiftKey: true });
    expect(refreshData).toHaveBeenCalledTimes(1);
    expect(volumeUp).not.toHaveBeenCalled();
  });

  it("dispatches a fixed action even when storage cleared its binding", () => {
    const refreshData = vi.fn();
    mount({ refreshData }, { ...DEFAULT_BINDINGS, refreshData: null });
    press({ code: "KeyR", ctrlKey: true, shiftKey: true });
    expect(refreshData).toHaveBeenCalledTimes(1);
  });
});
