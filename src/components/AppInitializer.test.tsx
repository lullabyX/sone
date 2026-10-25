import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { invoke } from "@tauri-apps/api/core";

const handlers = vi.hoisted(
  () => ({}) as Record<string, (e: { payload: unknown }) => void>,
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    handlers[name] = cb;
    return Promise.resolve(() => {});
  }),
}));
vi.mock("@tauri-apps/api/window", () => {
  const noop = () => Promise.resolve(() => {});
  const win = {
    setFullscreen: vi.fn(() => Promise.resolve()),
    isFullscreen: vi.fn(() => Promise.resolve(false)),
    onCloseRequested: vi.fn(noop),
    listen: vi.fn(noop),
    onFocusChanged: vi.fn(noop),
    onResized: vi.fn(noop),
  };
  return { getCurrentWindow: () => win };
});
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: vi.fn(() => Promise.resolve(null)),
  onOpenUrl: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../hooks/useOverlayBridge", () => ({ useOverlayBridge: () => {} }));
vi.mock("../hooks/useMcpBridge", () => ({ useMcpBridge: () => {} }));

import { AppInitializer } from "./AppInitializer";
import { ToastProvider } from "../contexts/ToastContext";
import { maximizedPlayerAtom } from "../atoms/ui";

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

it("MPRIS SetFullscreen opens the maximized player and the state is reported back", async () => {
  const store = createStore();
  render(
    <Provider store={store}>
      <ToastProvider>
        <AppInitializer />
      </ToastProvider>
    </Provider>,
  );
  await act(async () => {});
  expect(invoke).toHaveBeenCalledWith("update_mpris_fullscreen", {
    fullscreen: false,
  });
  act(() => handlers["mpris:set-fullscreen"]({ payload: true }));
  expect(store.get(maximizedPlayerAtom)).toBe(true);
  expect(invoke).toHaveBeenLastCalledWith("update_mpris_fullscreen", {
    fullscreen: true,
  });
});
