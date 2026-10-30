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
import { updateInfoAtom } from "../atoms/updates";

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockImplementation(() => Promise.resolve(undefined));
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

it("keeps the update check's answer for TV Settings", async () => {
  const info = { available: true, current: "1.0.0", latest: "1.1.0", url: "u" };
  vi.mocked(invoke).mockImplementation((cmd: string) =>
    Promise.resolve(cmd === "check_for_update" ? info : undefined),
  );
  const store = createStore();
  render(
    <Provider store={store}>
      <ToastProvider>
        <AppInitializer />
      </ToastProvider>
    </Provider>,
  );
  await act(async () => {});
  expect(store.get(updateInfoAtom)).toEqual(info);
});
