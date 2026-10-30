import { afterEach, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { currentVideoAtom, videoExpandedAtom } from "../../atoms/video";
import { useShortcuts } from "../../hooks/useShortcuts";
import { DEFAULT_BINDINGS, shortcutsAtom } from "../../lib/shortcuts";
import type { TvKeyAction } from "./tvKeys";
import { useTvKeyRouter } from "./useTvKeyRouter";
import { pressKey, renderTv, setupTvTest, type TvStore } from "./tvTestUtils";

setupTvTest();
const rootRef = { current: null as HTMLElement | null };
const railRef = { current: null as HTMLElement | null };
function Router(p: { execute: (a: TvKeyAction, e: KeyboardEvent) => void; wakeVideo?: () => void }) {
  useTvKeyRouter({ rootRef, railRef, holding: () => false, execute: p.execute, wakeVideo: p.wakeVideo ?? (() => {}) });
  return null;
}
const SCREEN = `<div id="root"><nav id="rail"><button>Home</button></nav><main><div class="tv-screen"><button id="b" data-tv-focusable>b</button></div></main></div>`;
const VIDEO = `<div role="dialog"><video></video><button title="Previous">prev</button><button>play</button>
  <button title="Quality">Quality</button><div><button id="q1">1080p</button></div></div>`;
function mount(html: string, opts: { store?: TvStore; wakeVideo?: () => void } = {}) {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  rootRef.current = host.querySelector("#root");
  railRef.current = host.querySelector("#rail");
  const execute = vi.fn();
  renderTv(<Router execute={execute} wakeVideo={opts.wakeVideo} />, { store: opts.store });
  return { execute, $: (id: string) => host.querySelector<HTMLElement>(`#${id}`)! };
}
function videoShowing(): TvStore {
  const store = createStore();
  store.set(currentVideoAtom, { id: 1 } as never);
  store.set(videoExpandedAtom, true);
  return store;
}
afterEach(() => { document.body.innerHTML = ""; });

it("prevents default and executes a key it routes", () => {
  const { execute, $ } = mount(SCREEN); $("b").focus();
  const e = pressKey($("b"), { key: "ArrowDown" });
  expect(execute).toHaveBeenCalledWith({ type: "move", dir: "down", enterSide: true }, e);
  expect(e.defaultPrevented).toBe(true);
});
it("leaves a key an element already handled", () => {
  const { execute, $ } = mount(SCREEN); $("b").focus();
  const eat = (e: Event) => e.preventDefault();
  window.addEventListener("keydown", eat, true);
  pressKey($("b"), { key: "ArrowDown" });
  window.removeEventListener("keydown", eat, true);
  expect(execute).not.toHaveBeenCalled();
});
it("wakes the video controls on any unmodified key", () => {
  const wakeVideo = vi.fn();
  const { execute } = mount(VIDEO, { store: videoShowing(), wakeVideo });
  pressKey(document.body, { key: "a" });
  pressKey(document.body, { key: "a", ctrlKey: true });
  expect(wakeVideo).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
});
it("lets Enter on a quality choice click natively, then refocuses", () => {
  const { execute, $ } = mount(VIDEO, { store: videoShowing() }); $("q1").focus();
  const e = pressKey($("q1"), { key: "Enter" });
  expect(execute).toHaveBeenCalledWith({ type: "videoNativeEnter" }, e);
  expect(e.defaultPrevented).toBe(false);
});
// useShortcuts must register FIRST, as AppInitializer's does in the app.
// Mount it in its own render before the router: in one component, jotai's storage onMount re-sets
// shortcutsAtom and useShortcuts re-registers after the router, which hides the bug.
const bare = (code: string) => ({ code, mod: false, shift: false, alt: false });
function Shortcuts(p: { d: Parameters<typeof useShortcuts>[0] }) { useShortcuts(p.d); return null; }
it("keeps rebound desktop shortcuts off TV navigation keys", () => {
  const store = createStore();
  store.set(shortcutsAtom, { ...DEFAULT_BINDINGS, volumeDown: bare("ArrowDown"), nextTrack: bare("Enter"), prevTrack: bare("Backspace") });
  const d = { volumeDown: vi.fn(), nextTrack: vi.fn(), prevTrack: vi.fn(), muteToggle: vi.fn() };
  renderTv(<Shortcuts d={d} />, { store });
  const { execute, $ } = mount(SCREEN, { store });
  const b = $("b"); b.focus();
  pressKey(b, { key: "ArrowDown", code: "ArrowDown" });
  const enter = pressKey(b, { key: "Enter", code: "Enter" });
  pressKey(b, { key: "Backspace", code: "Backspace" });
  pressKey(b, { key: "m", code: "KeyM" });
  expect(d.volumeDown).not.toHaveBeenCalled();
  expect(d.nextTrack).not.toHaveBeenCalled();
  expect(d.prevTrack).not.toHaveBeenCalled();
  expect(enter.defaultPrevented).toBe(false);          // the native click still happens
  expect(d.muteToggle).toHaveBeenCalledTimes(1);       // keys TV leaves alone still reach the desktop
  expect(execute).toHaveBeenCalledWith({ type: "move", dir: "down", enterSide: true }, expect.any(KeyboardEvent));
  expect(execute).toHaveBeenCalledWith({ type: "back" }, expect.any(KeyboardEvent));
});
