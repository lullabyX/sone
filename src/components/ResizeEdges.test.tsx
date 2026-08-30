import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";

const { isMaximized, isFullscreen, onResized, startResizeDragging } =
  vi.hoisted(() => ({
    isMaximized: vi.fn(),
    isFullscreen: vi.fn(),
    onResized: vi.fn(),
    startResizeDragging: vi.fn(),
  }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized,
    isFullscreen,
    onResized,
    startResizeDragging,
  }),
}));

import ResizeEdges from "./ResizeEdges";

let resizeHandler: (() => void) | null = null;

function setWindowState({
  maximized,
  fullscreen,
}: {
  maximized: boolean;
  fullscreen: boolean;
}) {
  isMaximized.mockResolvedValue(maximized);
  isFullscreen.mockResolvedValue(fullscreen);
}

describe("ResizeEdges", () => {
  beforeEach(() => {
    cleanup();
    isMaximized.mockReset();
    isFullscreen.mockReset();
    startResizeDragging.mockReset();
    resizeHandler = null;
    onResized.mockReset();
    onResized.mockImplementation((handler: () => void) => {
      resizeHandler = handler;
      return Promise.resolve(() => {});
    });
  });

  it("renders all eight grab zones while windowed", async () => {
    setWindowState({ maximized: false, fullscreen: false });
    const { container } = render(<ResizeEdges />);
    await waitFor(() =>
      expect(container.querySelectorAll("[data-resize-edge]")).toHaveLength(8),
    );
  });

  it("sizes the east zone from the right prop", async () => {
    setWindowState({ maximized: false, fullscreen: false });
    const { container } = render(<ResizeEdges right={2} />);
    const east = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(
        '[data-resize-edge="East"]',
      );
      if (!el) throw new Error("east zone not rendered");
      return el;
    });
    expect(east.style.width).toBe("2px");
  });

  it("renders nothing while maximized", async () => {
    setWindowState({ maximized: true, fullscreen: false });
    const { container } = render(<ResizeEdges />);
    await waitFor(() => expect(isMaximized).toHaveBeenCalled());
    expect(container.querySelectorAll("[data-resize-edge]")).toHaveLength(0);
  });

  it("renders nothing while fullscreen", async () => {
    setWindowState({ maximized: false, fullscreen: true });
    const { container } = render(<ResizeEdges />);
    await waitFor(() => expect(isFullscreen).toHaveBeenCalled());
    expect(container.querySelectorAll("[data-resize-edge]")).toHaveLength(0);
  });

  it("drops the zones when the window is maximized later", async () => {
    setWindowState({ maximized: false, fullscreen: false });
    const { container } = render(<ResizeEdges />);
    await waitFor(() =>
      expect(container.querySelectorAll("[data-resize-edge]")).toHaveLength(8),
    );

    setWindowState({ maximized: true, fullscreen: false });
    await act(async () => {
      resizeHandler?.();
    });

    await waitFor(() =>
      expect(container.querySelectorAll("[data-resize-edge]")).toHaveLength(0),
    );
  });
});
