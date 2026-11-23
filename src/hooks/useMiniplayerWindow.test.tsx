import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useHideMiniplayer } from "./useMiniplayerWindow";

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: vi.fn() },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

const miniplayer = () => {
  const calls: string[] = [];
  const win = {
    calls,
    hide: vi.fn(async () => void calls.push("hide")),
    show: vi.fn(async () => void calls.push("show")),
  };
  vi.mocked(WebviewWindow.getByLabel).mockResolvedValue(win as never);
  return win;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(WebviewWindow.getByLabel).mockReset();
});

it("hides an open miniplayer and shows it again afterwards", async () => {
  const win = miniplayer();
  const { unmount } = renderHook(() => useHideMiniplayer());
  await flush();
  expect(win.calls).toEqual(["hide"]);
  unmount();
  await flush();
  expect(win.calls).toEqual(["hide", "show"]);
});

it("shows nothing when no miniplayer was open", async () => {
  vi.mocked(WebviewWindow.getByLabel).mockResolvedValue(null);
  const { unmount } = renderHook(() => useHideMiniplayer());
  await flush();
  unmount();
  await flush();
  expect(WebviewWindow.getByLabel).toHaveBeenCalledTimes(1);
});

it("leaving before the miniplayer was found still shows it after hiding", async () => {
  const win = miniplayer();
  let found!: (w: unknown) => void;
  vi.mocked(WebviewWindow.getByLabel).mockImplementationOnce(
    () => new Promise((res) => (found = res)) as never,
  );
  const { unmount } = renderHook(() => useHideMiniplayer());
  unmount();
  await act(async () => found(win));
  await flush();
  expect(win.calls).toEqual(["hide", "show"]);
});

it("logs a refused hide or show instead of throwing", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const win = miniplayer();
  win.hide.mockRejectedValueOnce("window.hide not allowed");
  win.show.mockRejectedValueOnce("window.show not allowed");
  const { unmount } = renderHook(() => useHideMiniplayer());
  await flush();
  unmount();
  await flush();
  expect(log.mock.calls.map((c) => c[1])).toEqual([
    "window.hide not allowed",
    "window.show not allowed",
  ]);
});
