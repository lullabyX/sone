import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";

const {
  isMaximized,
  isFocused,
  onResized,
  onFocusChanged,
  minimize,
  maximize,
  unmaximize,
  close,
} = vi.hoisted(() => ({
  isMaximized: vi.fn(),
  isFocused: vi.fn(),
  onResized: vi.fn(),
  onFocusChanged: vi.fn(),
  minimize: vi.fn(),
  maximize: vi.fn(),
  unmaximize: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized,
    isFocused,
    onResized,
    onFocusChanged,
    minimize,
    maximize,
    unmaximize,
    close,
  }),
}));

import TitleBar from "./TitleBar";

describe("TitleBar", () => {
  beforeEach(() => {
    cleanup();
    isMaximized.mockReset().mockResolvedValue(false);
    isFocused.mockReset().mockResolvedValue(true);
    minimize.mockReset().mockResolvedValue(undefined);
    maximize.mockReset().mockResolvedValue(undefined);
    unmaximize.mockReset().mockResolvedValue(undefined);
    close.mockReset().mockResolvedValue(undefined);
    onResized.mockReset().mockReturnValue(Promise.resolve(() => {}));
    onFocusChanged.mockReset().mockReturnValue(Promise.resolve(() => {}));
  });

  it("renders titlebar with SONE title", async () => {
    const { getByText } = render(<TitleBar />);
    expect(getByText("SONE")).toBeDefined();
  });

  it("keeps controls outside the root drag-region", async () => {
    const { container, getByRole } = render(<TitleBar />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute("data-tauri-drag-region")).toBeNull();

    const maxBtn = getByRole("button", { name: /maximize/i });
    expect(maxBtn.closest("[data-tauri-drag-region]")).toBeNull();
  });

  it("triggers minimize on minimize button click", async () => {
    const { getByRole } = render(<TitleBar />);
    const minBtn = getByRole("button", { name: /minimize/i });
    fireEvent.click(minBtn);
    expect(minimize).toHaveBeenCalledTimes(1);
  });

  it("toggles maximize when unmaximized", async () => {
    isMaximized.mockResolvedValue(false);
    const { getByRole } = render(<TitleBar />);
    const maxBtn = getByRole("button", { name: /maximize/i });

    fireEvent.click(maxBtn);
    await waitFor(() => {
      expect(maximize).toHaveBeenCalledTimes(1);
    });
  });

  it("toggles unmaximize when already maximized", async () => {
    isMaximized.mockResolvedValue(true);
    const { getByRole } = render(<TitleBar />);

    await waitFor(() => {
      expect(getByRole("button", { name: /restore/i })).toBeDefined();
    });

    const restoreBtn = getByRole("button", { name: /restore/i });
    fireEvent.click(restoreBtn);

    await waitFor(() => {
      expect(unmaximize).toHaveBeenCalledTimes(1);
    });
  });

  it("triggers close on close button click", async () => {
    const { getByRole } = render(<TitleBar />);
    const closeBtn = getByRole("button", { name: /close/i });
    fireEvent.click(closeBtn);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
