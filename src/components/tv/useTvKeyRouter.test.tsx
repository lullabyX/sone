import { afterEach, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { currentVideoAtom, videoExpandedAtom } from "../../atoms/video";
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
