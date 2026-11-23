import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { maximizedPlayerAtom } from "../atoms/ui";
import { videoFullscreenAtom } from "../atoms/video";
import { tvModeAtom } from "../atoms/tv";
import { useFullscreenEscape } from "./useFullscreenEscape";

const win = vi.hoisted(() => ({
  setFullscreen: vi.fn((_on: boolean) => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

let fullscreen = true;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "is_window_fullscreen") return fullscreen;
    throw new Error(`unmocked ${cmd}`);
  });
});
afterEach(() => {
  cleanup();
  fullscreen = true;
});

function Probe() {
  useFullscreenEscape();
  return null;
}

type Store = ReturnType<typeof createStore>;

async function pressEscape(setup?: (s: Store) => void) {
  const store = createStore();
  setup?.(store);
  render(
    <Provider store={store}>
      <Probe />
    </Provider>,
  );
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

it("Escape leaves a fullscreen nothing else owns", async () => {
  await pressEscape();
  expect(win.setFullscreen).toHaveBeenCalledWith(false);
});

it("does nothing when the window is not fullscreen", async () => {
  fullscreen = false;
  await pressEscape();
  expect(win.setFullscreen).not.toHaveBeenCalled();
});

it.each([
  ["TV mode", (s: Store) => s.set(tvModeAtom, true)],
  ["the maximized player", (s: Store) => s.set(maximizedPlayerAtom, true)],
  ["a fullscreen video", (s: Store) => s.set(videoFullscreenAtom, true)],
] as const)("leaves fullscreen to %s", async (_name, own) => {
  await pressEscape(own);
  expect(win.setFullscreen).not.toHaveBeenCalled();
});
