import { beforeEach, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { maximizedPlayerAtom } from "../atoms/ui";
import { tvModeAtom } from "../atoms/tv";
import { mockInvoke, setupTvTest } from "../components/tv/tvTestUtils";
import { useMprisFullscreen } from "./useMprisFullscreen";

const handlers = vi.hoisted(
  () => ({}) as Record<string, (e: { payload: unknown }) => void>,
);
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    handlers[name] = cb;
    return Promise.resolve(() => {});
  }),
}));
setupTvTest();
beforeEach(() => mockInvoke({ update_mpris_fullscreen: () => undefined }));

function Host() {
  useMprisFullscreen();
  return null;
}

const mount = async (store: ReturnType<typeof createStore>) => {
  render(
    <Provider store={store}>
      <Host />
    </Provider>,
  );
  await act(async () => {});
};

it("reports fullscreen while TV mode is on", async () => {
  const store = createStore();
  await mount(store);
  act(() => store.set(tvModeAtom, true));
  expect(invoke).toHaveBeenLastCalledWith("update_mpris_fullscreen", {
    fullscreen: true,
  });
});

it("ignores MPRIS set-fullscreen in TV mode", async () => {
  const store = createStore();
  store.set(tvModeAtom, true);
  await mount(store);
  act(() => handlers["mpris:set-fullscreen"]({ payload: true }));
  expect(store.get(maximizedPlayerAtom)).toBe(false);
  expect(invoke).toHaveBeenLastCalledWith("update_mpris_fullscreen", {
    fullscreen: true,
  });
});

it("on the desktop it still opens the maximized player", async () => {
  const store = createStore();
  await mount(store);
  act(() => handlers["mpris:set-fullscreen"]({ payload: true }));
  expect(store.get(maximizedPlayerAtom)).toBe(true);
});
