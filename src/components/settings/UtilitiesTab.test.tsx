import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    Promise.resolve(cmd === "get_enable_logging" ? true : undefined),
  ),
}));

import { invoke } from "@tauri-apps/api/core";
import { tvModeAtom } from "../../atoms/tv";
import UtilitiesTab from "./UtilitiesTab";

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockClear();
  localStorage.clear();
  sessionStorage.clear();
});

it("opens the log folder on the desktop", () => {
  render(
    <Provider store={createStore()}>
      <UtilitiesTab />
    </Provider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Open folder/ }));
  expect(invoke).toHaveBeenCalledWith("open_log_folder");
});

it("shows where the logs are but offers no file manager in TV mode", () => {
  const store = createStore();
  store.set(tvModeAtom, true);
  render(
    <Provider store={store}>
      <UtilitiesTab />
    </Provider>,
  );
  expect(screen.getByText("~/.config/sone/logs")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Open folder/ })).toBeNull();
});
