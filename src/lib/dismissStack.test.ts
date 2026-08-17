import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { registerDismissable, DISMISS_PRIORITY } from "./dismissStack";

function escape() {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
}

describe("dismissStack", () => {
  let cleanups: Array<() => void>;

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(() => {
    // Never leak an entry into the next test — the stack is module state.
    cleanups.forEach((fn) => fn());
    cleanup();
  });

  const register = (priority: number, onClose: () => void) => {
    const off = registerDismissable(priority, onClose);
    cleanups.push(off);
    return off;
  };

  it("dismisses the only entry", () => {
    const onClose = vi.fn();
    register(DISMISS_PRIORITY.modal, onClose);
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores keys other than Escape", () => {
    const onClose = vi.fn();
    register(DISMISS_PRIORITY.modal, onClose);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("dismisses only the most recent of two equal priorities", () => {
    const first = vi.fn();
    const second = vi.fn();
    register(DISMISS_PRIORITY.modal, first);
    register(DISMISS_PRIORITY.modal, second);
    escape();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("prefers higher priority over more recent registration", () => {
    const menu = vi.fn();
    const drawer = vi.fn();
    register(DISMISS_PRIORITY.contextMenu, menu);
    register(DISMISS_PRIORITY.drawer, drawer);
    escape();
    expect(menu).toHaveBeenCalledTimes(1);
    expect(drawer).not.toHaveBeenCalled();
  });

  it("falls through to the next layer after the top one unregisters", () => {
    const menu = vi.fn();
    const drawer = vi.fn();
    const offMenu = register(DISMISS_PRIORITY.contextMenu, menu);
    register(DISMISS_PRIORITY.drawer, drawer);
    offMenu();
    escape();
    expect(drawer).toHaveBeenCalledTimes(1);
    expect(menu).not.toHaveBeenCalled();
  });

  it("closes exactly one layer per keypress", () => {
    const a = vi.fn();
    const b = vi.fn();
    register(DISMISS_PRIORITY.modal, a);
    register(DISMISS_PRIORITY.overlay, b);
    escape();
    expect(a.mock.calls.length + b.mock.calls.length).toBe(1);
  });

  it("attaches one listener and detaches it when empty", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");

    const offA = registerDismissable(DISMISS_PRIORITY.modal, () => {});
    const offB = registerDismissable(DISMISS_PRIORITY.modal, () => {});
    const addCalls = add.mock.calls.filter(([type]) => type === "keydown");
    expect(addCalls).toHaveLength(1);

    offA();
    expect(
      remove.mock.calls.filter(([type]) => type === "keydown"),
    ).toHaveLength(0);

    offB();
    expect(
      remove.mock.calls.filter(([type]) => type === "keydown"),
    ).toHaveLength(1);

    add.mockRestore();
    remove.mockRestore();
  });

  it("does nothing when the stack is empty", () => {
    expect(() => escape()).not.toThrow();
  });

  // A focused input owns Escape by calling stopPropagation in its React
  // onKeyDown (see SearchBar). React attaches below window, so the key never
  // reaches the stack — which only holds while the stack listens on bubble.
  const renderInput = (onKeyDown: (e: React.KeyboardEvent) => void) => {
    const { container } = render(React.createElement("input", { onKeyDown }));
    return container.querySelector("input")!;
  };

  it("dismisses when a focused element lets the key bubble", () => {
    const onClose = vi.fn();
    register(DISMISS_PRIORITY.drawer, onClose);
    fireEvent.keyDown(
      renderInput(() => {}),
      { key: "Escape" },
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss when a focused element stops propagation", () => {
    const onClose = vi.fn();
    register(DISMISS_PRIORITY.drawer, onClose);
    fireEvent.keyDown(
      renderInput((e) => e.stopPropagation()),
      { key: "Escape" },
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("tolerates a repeated unregister across a drain and reattach", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const stale = vi.fn();
    const live = vi.fn();

    const offStale = registerDismissable(DISMISS_PRIORITY.modal, stale);
    offStale();
    expect(() => offStale()).not.toThrow();

    // The stack drained and reattached — the stale unregister must not detach it.
    register(DISMISS_PRIORITY.modal, live);
    offStale();
    escape();
    expect(live).toHaveBeenCalledTimes(1);
    expect(stale).not.toHaveBeenCalled();
    expect(
      remove.mock.calls.filter(([type]) => type === "keydown"),
    ).toHaveLength(1);

    remove.mockRestore();
  });
});
