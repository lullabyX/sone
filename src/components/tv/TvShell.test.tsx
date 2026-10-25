import { beforeEach, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { createStore } from "jotai";
import { useLayoutEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isPlayingAtom } from "../../atoms/playback";
import { maximizedPlayerAtom } from "../../atoms/ui";
import {
  currentVideoAtom,
  videoFullscreenAtom,
  videoPlayingAtom,
} from "../../atoms/video";
import type { TidalVideo } from "../../types";
import TvShell from "./TvShell";
import { mockInvoke, renderTv, setupTvTest, type TvStore } from "./tvTestUtils";

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
beforeEach(() => {
  store = createStore();
  win.isFullscreen.mockImplementation(() => Promise.resolve(false));
  mockInvoke({
    inhibit_idle: () => undefined,
    uninhibit_idle: () => undefined,
  });
});
const flush = () => act(async () => {});
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
  win.isFullscreen.mockResolvedValue(true);
  const r = shell();
  await flush();
  r.unmount();
  await flush();
  expect(win.setFullscreen).not.toHaveBeenCalledWith(false);
});

it("restores correctly when it exits before entry finished", async () => {
  let res!: (v: boolean) => void;
  win.isFullscreen.mockReturnValue(new Promise<boolean>((r) => (res = r)));
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
  win.isFullscreen.mockResolvedValue(true);
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
  shell();
  await flush();
  window.dispatchEvent(new Event("resize"));
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  expect(win.setFullscreen.mock.calls.filter((c) => c[0] === true).length).toBe(
    2,
  );
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

it("inhibits idle while audio or a video plays, and releases after", async () => {
  shell();
  act(() => store.set(isPlayingAtom, true));
  await flush();
  expect(invoke).toHaveBeenCalledWith("inhibit_idle", { holder: "tv" });
  act(() => store.set(isPlayingAtom, false));
  await flush();
  expect(invoke).toHaveBeenLastCalledWith("uninhibit_idle", { holder: "tv" });
  act(() => {
    store.set(currentVideoAtom, { id: 1 } as TidalVideo);
    store.set(videoPlayingAtom, true);
  });
  await flush();
  expect(invoke).toHaveBeenLastCalledWith("inhibit_idle", { holder: "tv" });
});
it("a stale videoPlaying after the video closed does not inhibit", async () => {
  store.set(videoPlayingAtom, true); // currentVideoAtom stays null
  shell();
  await flush();
  expect(invoke).not.toHaveBeenCalledWith("inhibit_idle", expect.anything());
});
