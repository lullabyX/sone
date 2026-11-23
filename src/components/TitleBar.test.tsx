import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import TitleBar from "./TitleBar";

const win = vi.hoisted(() => ({
  isMaximized: vi.fn(() => Promise.resolve(false)),
  isFocused: vi.fn(() => Promise.resolve(true)),
  onResized: vi.fn(() => Promise.resolve(() => {})),
  onFocusChanged: vi.fn(() => Promise.resolve(() => {})),
  setFullscreen: vi.fn((_on: boolean) => Promise.resolve()),
  minimize: vi.fn(() => Promise.resolve()),
  maximize: vi.fn(() => Promise.resolve()),
  unmaximize: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

let fullscreen = false;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "is_window_fullscreen") return fullscreen;
    throw new Error(`unmocked ${cmd}`);
  });
});
afterEach(() => {
  cleanup();
  fullscreen = false;
});

it("offers Exit full screen while the window is fullscreen", async () => {
  fullscreen = true;
  render(<TitleBar />);
  fireEvent.click(await screen.findByLabelText("Exit full screen"));
  await waitFor(() => expect(win.setFullscreen).toHaveBeenCalledWith(false));
  expect(win.maximize).not.toHaveBeenCalled();
});

it("leaves fullscreen before minimizing", async () => {
  fullscreen = true;
  render(<TitleBar />);
  await screen.findByLabelText("Exit full screen");
  fireEvent.click(screen.getByLabelText("Minimize"));
  await waitFor(() => expect(win.minimize).toHaveBeenCalled());
  expect(win.setFullscreen).toHaveBeenCalledWith(false);
  expect(win.setFullscreen.mock.invocationCallOrder[0]).toBeLessThan(
    win.minimize.mock.invocationCallOrder[0],
  );
});

it("maximizes as before when not fullscreen", async () => {
  render(<TitleBar />);
  fireEvent.click(await screen.findByLabelText("Maximize"));
  await waitFor(() => expect(win.maximize).toHaveBeenCalled());
  expect(win.setFullscreen).not.toHaveBeenCalled();
});
