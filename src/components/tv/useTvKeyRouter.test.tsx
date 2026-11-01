import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { currentVideoAtom, videoExpandedAtom } from "../../atoms/video";
import { useShortcuts } from "../../hooks/useShortcuts";
import { DEFAULT_BINDINGS, shortcutsAtom } from "../../lib/shortcuts";
import { DISMISS_PRIORITY, registerDismissable } from "../../lib/dismissStack";
import type { TvKeyAction } from "./tvKeys";
import { useTvKeyRouter } from "./useTvKeyRouter";
import { pressKey, renderTv, setupTvTest, stubLayout, type TvStore } from "./tvTestUtils";

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
// The router treats focus on a zero-size element as lost.
let restoreLayout = () => {};
beforeEach(() => (restoreLayout = stubLayout()));
afterEach(() => { restoreLayout(); document.body.innerHTML = ""; });

it("prevents default and executes a key it routes", () => {
  const { execute, $ } = mount(SCREEN); $("b").focus();
  const e = pressKey($("b"), { key: "ArrowDown" });
  expect(execute).toHaveBeenCalledWith({ type: "move", dir: "down", enterSide: true }, e);
  expect(e.defaultPrevented).toBe(true);
});
it("treats focus on a hidden screen as lost and a screen with only disabled items as empty", () => {
  const { execute, $ } = mount(`<div id="root"><nav id="rail"><button>Home</button></nav><main>
    <div class="tv-screen hidden"><button id="old" data-tv-focusable>old</button></div>
    <div class="tv-screen"><button data-tv-focusable disabled>wait</button></div></main></div>`);
  $("old").focus();
  pressKey($("old"), { key: "ArrowDown" });
  pressKey($("old"), { key: "ArrowLeft" });
  expect(execute.mock.calls.map((c) => c[0])).toEqual([{ type: "swallow" }, { type: "focusRail" }]);
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
const VIDEO_VOL = `<div role="dialog"><video></video><div><button id="spk">spk</button>
  <input id="vol" type="range" aria-label="Volume" /></div><button title="Quality">Quality</button></div>`;
it("Right on the video's volume slider raises the volume instead of moving focus", () => {
  const { execute, $ } = mount(VIDEO_VOL, { store: videoShowing() }); $("vol").focus();
  const e = pressKey($("vol"), { key: "ArrowRight" });
  expect(execute).toHaveBeenCalledWith({ type: "media", command: { kind: "volume", by: 0.05 } }, e);
  expect(e.defaultPrevented).toBe(true);
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
let off = () => {};
afterEach(() => off());
it("Escape on a full-screen video minimises it instead of closing it", () => {
  const onClose = vi.fn();
  off = registerDismissable(DISMISS_PRIORITY.overlay, onClose);
  const { execute } = mount(VIDEO, { store: videoShowing() });
  pressKey(document.body, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  expect(execute).toHaveBeenCalledWith({ type: "videoBack" }, expect.any(KeyboardEvent));
});
it("Escape in a prompt over the settings sheet closes only the prompt", () => {
  const onClose = vi.fn();
  off = registerDismissable(DISMISS_PRIORITY.modal, onClose);
  const { execute } = mount(`${SCREEN}<div data-tv-modal data-tv-native></div><div data-tv-modal data-tv-prompt><input /></div>`);
  pressKey(document.body, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  expect(execute).toHaveBeenCalledWith({ type: "back" }, expect.any(KeyboardEvent));
});
const MENU = `<div data-tv-modal role="menu"><button id="m1" data-tv-focusable>one</button><button data-tv-focusable>two</button></div>`;
it("gives the keys to a layer shown over a full-screen video", () => {
  const onClose = vi.fn();
  off = registerDismissable(DISMISS_PRIORITY.overlay, onClose);
  const wakeVideo = vi.fn();
  const { execute, $ } = mount(`${SCREEN}${VIDEO}${MENU}`, { store: videoShowing(), wakeVideo });
  $("m1").focus();
  pressKey($("m1"), { key: "ArrowDown" });
  pressKey($("m1"), { key: "Escape" });
  pressKey($("m1"), { key: "BrowserBack" });
  expect(execute.mock.calls.map((c) => c[0])).toEqual([
    { type: "move", dir: "down", enterSide: true },
    { type: "back" },
    { type: "back" },
  ]);
  expect(onClose).not.toHaveBeenCalled();
  expect(wakeVideo).not.toHaveBeenCalled();
});
it("leaves the keys to the video over a layer inside a hidden screen", () => {
  const { execute } = mount(`<div class="hidden">${MENU}</div>${VIDEO}`, { store: videoShowing() });
  pressKey(document.body, { key: "Escape" });
  pressKey(document.body, { key: "ArrowLeft" });
  expect(execute.mock.calls.map((c) => c[0])).toEqual([
    { type: "videoBack" },
    { type: "videoSeek", by: -10 },
  ]);
});
it("holds the arrows while focus is lost on a screen loading its next page", () => {
  const { execute } = mount(`<div id="root"><nav id="rail"><button>Home</button></nav><main>
    <div class="tv-screen"><div data-tv-loading><button data-tv-focusable>row</button></div></div></main></div>`);
  pressKey(document.body, { key: "ArrowDown" });
  pressKey(document.body, { key: "ArrowLeft" });
  expect(execute.mock.calls.map((c) => c[0])).toEqual([{ type: "swallow" }, { type: "swallow" }]);
});
