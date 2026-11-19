import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { Provider, createStore } from "jotai";

const mini = vi.hoisted(() => ({
  hide: vi.fn(() => Promise.resolve()),
  show: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: vi.fn(() => Promise.resolve(mini)) },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setFullscreen: vi.fn(() => Promise.resolve()),
    isFullscreen: vi.fn(() => Promise.resolve(false)),
  }),
}));

import MaximizedPlayer from "./MaximizedPlayer";

afterEach(cleanup);

it("hides an open miniplayer while shown and brings it back after", async () => {
  const r = render(
    <Provider store={createStore()}>
      <MaximizedPlayer />
    </Provider>,
  );
  await act(async () => {});
  expect(mini.hide).toHaveBeenCalledTimes(1);
  r.unmount();
  await act(async () => {});
  expect(mini.show).toHaveBeenCalledTimes(1);
});
