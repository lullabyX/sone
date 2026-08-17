import { describe, it, expect, vi } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { useEscapeDismiss } from "./useEscapeDismiss";
import { DISMISS_PRIORITY } from "../lib/dismissStack";

function escape() {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
}

describe("useEscapeDismiss", () => {
  it("dismisses while active", () => {
    const onClose = vi.fn();
    renderHook(() => useEscapeDismiss(true, onClose));
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("does not register while inactive", () => {
    const onClose = vi.fn();
    renderHook(() => useEscapeDismiss(false, onClose));
    escape();
    expect(onClose).not.toHaveBeenCalled();
    cleanup();
  });

  it("registers and unregisters as active flips", () => {
    const onClose = vi.fn();
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useEscapeDismiss(active, onClose),
      { initialProps: { active: false } },
    );

    rerender({ active: true });
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender({ active: false });
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("unregisters on unmount", () => {
    const onClose = vi.fn();
    const { unmount } = renderHook(() => useEscapeDismiss(true, onClose));
    unmount();
    escape();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls the latest callback without re-registering", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ cb }: { cb: () => void }) =>
        useEscapeDismiss(true, cb, DISMISS_PRIORITY.modal),
      { initialProps: { cb: first } },
    );

    rerender({ cb: second });
    escape();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    cleanup();
  });

  it("keeps its place in the stack when the callback identity changes", () => {
    const lower = vi.fn();
    const top = vi.fn();
    const { rerender } = renderHook(
      ({ cb }: { cb: () => void }) => {
        useEscapeDismiss(true, cb, DISMISS_PRIORITY.modal);
        useEscapeDismiss(true, top, DISMISS_PRIORITY.modal);
      },
      { initialProps: { cb: lower } },
    );

    rerender({ cb: vi.fn() });
    escape();
    expect(top).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
    cleanup();
  });

  it("respects the priority argument", () => {
    const menu = vi.fn();
    const drawer = vi.fn();
    renderHook(() => useEscapeDismiss(true, drawer, DISMISS_PRIORITY.drawer));
    renderHook(() =>
      useEscapeDismiss(true, menu, DISMISS_PRIORITY.contextMenu),
    );
    escape();
    expect(menu).toHaveBeenCalledTimes(1);
    expect(drawer).not.toHaveBeenCalled();
    cleanup();
  });
});
