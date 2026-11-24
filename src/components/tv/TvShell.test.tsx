import { beforeEach, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { createStore } from "jotai";
import { useLayoutEffect } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  tvOverscanAtom,
  tvTextSizeAtom,
  tvVolumeOnTvAtom,
} from "../../atoms/tv";
import { maximizedPlayerAtom } from "../../atoms/ui";
import { videoFullscreenAtom } from "../../atoms/video";
import TvShell from "./TvShell";
import { mockInvoke, renderTv, setupTvTest, type TvStore } from "./tvTestUtils";

// What the window manager says (`is_window_fullscreen`), apart from the
// window API's isFullscreen(), which on Linux is only the last request.
const wmFullscreen = vi.hoisted(() => vi.fn(() => Promise.resolve(false)));
const win = vi.hoisted(() => ({
  isFullscreen: vi.fn(() => Promise.resolve(false)),
  setFullscreen: vi.fn((_on: boolean) => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: vi.fn(() => Promise.resolve(null)) },
}));
setupTvTest();
let store: TvStore;
// Window calls chain one after another, so let every step run.
const flush = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
beforeEach(async () => {
  // The last case's exit lands before this one starts counting calls.
  await flush();
  wmFullscreen.mockClear();
  win.setFullscreen.mockClear();
  store = createStore();
  wmFullscreen.mockImplementation(() => Promise.resolve(false));
  win.isFullscreen.mockImplementation(() => Promise.resolve(false));
  win.setFullscreen.mockImplementation(() => Promise.resolve());
  mockInvoke({
    is_window_fullscreen: () => wmFullscreen(),
  });
});
const fullscreenCalls = () => win.setFullscreen.mock.calls.map((c) => c[0]);
const A = () => <p>A</p>;
const B = () => <p>B</p>;
const shell = (child = <A />) =>
  renderTv(<TvShell>{child}</TvShell>, { store });

it("applies tv-mode before children's layout effects, removes it on exit", () => {
  let seen = false;
  function Child() {
    useLayoutEffect(() => {
      seen = document.documentElement.classList.contains("tv-mode");
    }, []);
    return null;
  }
  const r = shell(<Child />);
  expect(seen).toBe(true);
  r.unmount();
  expect(document.documentElement.classList.contains("tv-mode")).toBe(false);
});

it("goes fullscreen and restores a windowed window on exit", async () => {
  const r = shell();
  await flush();
  expect(win.setFullscreen).toHaveBeenLastCalledWith(true);
  r.unmount();
  await flush();
  expect(win.setFullscreen).toHaveBeenLastCalledWith(false);
});

it("leaves a window that was fullscreen before fullscreen on exit", async () => {
  wmFullscreen.mockResolvedValue(true);
  const r = shell();
  await flush();
  r.unmount();
  await flush();
  expect(win.setFullscreen).not.toHaveBeenCalledWith(false);
});

// After a reload inside TV mode the window is in TV mode's own fullscreen.
it("goes by the window manager, not an earlier fullscreen request", async () => {
  // A player asked for fullscreen, then the window left it without a request.
  win.isFullscreen.mockResolvedValue(true);
  const r = shell();
  await flush();
  r.unmount();
  await flush();
  expect(win.setFullscreen).toHaveBeenLastCalledWith(false);
});

it("a reload inside TV mode still restores a windowed window on exit", async () => {
  const before = shell();
  await flush();
  const saved = Object.entries(sessionStorage);
  expect(saved.length).toBe(1);
  // The reload: the page goes without running cleanups, sessionStorage stays.
  before.unmount();
  await flush();
  for (const [k, v] of saved) sessionStorage.setItem(k, v);
  wmFullscreen.mockResolvedValue(true);
  wmFullscreen.mockClear();
  win.setFullscreen.mockClear();

  const after = shell();
  await flush();
  expect(wmFullscreen).not.toHaveBeenCalled();
  after.unmount();
  await flush();
  expect(fullscreenCalls()).toEqual([true, false]);
  expect(sessionStorage.length).toBe(0);
});

it("decides again in the next TV session", async () => {
  const first = shell();
  await flush();
  first.unmount();
  await flush();
  wmFullscreen.mockResolvedValue(true);
  win.setFullscreen.mockClear();
  const second = shell();
  await flush();
  second.unmount();
  await flush();
  expect(fullscreenCalls()).toEqual([true]);
});

it("restores correctly when it exits before entry finished", async () => {
  let res!: (v: boolean) => void;
  wmFullscreen.mockReturnValue(new Promise<boolean>((r) => (res = r)));
  const r = shell();
  r.unmount();
  await act(async () => res(false));
  expect(win.setFullscreen.mock.calls.map((c) => c[0])).toEqual([true, false]);
});

it("swapping the TV surface (login <-> app) never touches fullscreen", async () => {
  const r = shell(<A />);
  await flush();
  const n = win.setFullscreen.mock.calls.length;
  r.rerender(
    <TvShell>
      <B />
    </TvShell>,
  );
  await flush();
  expect(win.setFullscreen.mock.calls.length).toBe(n);
});

it("does not restore fullscreen that belonged to the maximized player or a video", async () => {
  store.set(maximizedPlayerAtom, true);
  store.set(videoFullscreenAtom, true);
  wmFullscreen.mockResolvedValue(true);
  const r = shell();
  await flush();
  expect(store.get(maximizedPlayerAtom)).toBe(false);
  expect(store.get(videoFullscreenAtom)).toBe(false);
  r.unmount();
  await flush();
  expect(win.setFullscreen).toHaveBeenLastCalledWith(false);
});

it("puts fullscreen back when the window leaves it", async () => {
  vi.useFakeTimers();
  // The WM shortcut leaves isFullscreen() saying true.
  win.isFullscreen.mockResolvedValue(true);
  shell();
  await flush();
  window.dispatchEvent(new Event("resize"));
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  await flush();
  expect(fullscreenCalls()).toEqual([true, true]);
});

it("puts nothing back once TV mode is left", async () => {
  vi.useFakeTimers();
  const r = shell();
  await flush();
  window.dispatchEvent(new Event("resize"));
  r.unmount();
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  await flush();
  expect(fullscreenCalls()).toEqual([true, false]);
});

it("leaves fullscreen only after a put-back already on its way", async () => {
  vi.useFakeTimers();
  let land!: () => void;
  const r = shell();
  await flush();
  win.setFullscreen.mockImplementationOnce(
    () => new Promise<void>((res) => (land = res)),
  );
  window.dispatchEvent(new Event("focus"));
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  await flush();
  r.unmount();
  await flush();
  expect(fullscreenCalls()).toEqual([true, true]);
  await act(async () => land());
  await flush();
  expect(fullscreenCalls()).toEqual([true, true, false]);
});

it("hides the pointer after 2.5 s of no mouse movement", () => {
  vi.useFakeTimers();
  const r = shell();
  act(() => {
    vi.advanceTimersByTime(2500);
  });
  expect(document.documentElement.classList.contains("tv-cursor-hidden")).toBe(
    true,
  );
  r.unmount();
  expect(document.documentElement.classList.contains("tv-cursor-hidden")).toBe(
    false,
  );
});

it("the safe area is not a stacking context", () => {
  const { container } = shell();
  expect(
    container.querySelector(".tv-safe")!.getAttribute("style") ?? "",
  ).not.toMatch(/contain|transform|z-index/);
});

it("hides an open miniplayer while in TV mode and brings it back on exit", async () => {
  const mini = { hide: vi.fn(), show: vi.fn() };
  vi.mocked(WebviewWindow.getByLabel).mockResolvedValue(mini as never);
  const r = shell();
  await flush();
  expect(mini.hide).toHaveBeenCalled();
  r.unmount();
  await flush();
  expect(mini.show).toHaveBeenCalled();
});

it("scales the whole interface by the text size setting", () => {
  const scale = () =>
    document.documentElement.style.getPropertyValue("--tv-text-scale");
  const { unmount } = shell();
  expect(scale()).toBe("1");
  act(() => store.set(tvTextSizeAtom, "large"));
  expect(scale()).toBe("1.2");
  unmount();
  expect(scale()).toBe("");
});

it("marks the page while the TV's remote sets the volume", () => {
  const html = document.documentElement;
  const { unmount } = shell();
  expect(html.hasAttribute("data-tv-volume-on-tv")).toBe(false);
  act(() => store.set(tvVolumeOnTvAtom, true));
  expect(html.hasAttribute("data-tv-volume-on-tv")).toBe(true);
  unmount();
  expect(html.hasAttribute("data-tv-volume-on-tv")).toBe(false);
});

it("pads the TV surface by the screen margin and publishes it", () => {
  store.set(tvOverscanAtom, { x: 4, y: 2.5 });
  const { container, unmount } = shell();
  expect(
    (container.querySelector(".tv-shell") as HTMLElement).style.padding,
  ).toBe("2.5vh 4vw");
  expect(document.documentElement.style.getPropertyValue("--tv-safe-x")).toBe(
    "4vw",
  );
  expect(document.documentElement.style.getPropertyValue("--tv-safe-y")).toBe(
    "2.5vh",
  );
  unmount();
  expect(document.documentElement.style.getPropertyValue("--tv-safe-x")).toBe(
    "",
  );
  expect(document.documentElement.style.getPropertyValue("--tv-safe-y")).toBe(
    "",
  );
});
