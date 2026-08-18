import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { useRef } from "react";
import { currentViewAtom } from "../atoms/navigation";
import {
  NAV_SESSION,
  clearAllOffsets,
  getOffset,
  saveOffset,
} from "../lib/scrollMemory";
import { useScrollRestoration } from "./useScrollRestoration";
import type { AppView } from "../types";

const observers: Array<() => void> = [];

class StubResizeObserver {
  constructor(private cb: () => void) {
    observers.push(() => this.cb());
  }
  observe() {}
  disconnect() {}
}

/** jsdom has no layout: scrollHeight/clientHeight are always 0 and scrollTop
 *  never clamps. Both are faked so the clamp path can be exercised. Re-faking
 *  carries the current scrollTop over, standing in for a real element whose
 *  offset survives its content growing. */
function fakeMetrics(
  el: HTMLElement,
  scrollHeight: number,
  clientHeight: number,
) {
  let top = el.scrollTop;
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, scrollHeight - clientHeight));
    },
  });
}

let container: HTMLDivElement | null = null;
let child: HTMLDivElement | null = null;

/** The container is pre-scrolled because refs attach before layout effects, so a
 *  restore that lands at the top has to actively reset a non-zero offset. */
function Harness({ scrollHeight }: { scrollHeight: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useScrollRestoration(ref);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (el && el !== container) {
          container = el;
          fakeMetrics(el, scrollHeight, 500);
          el.scrollTop = 900;
        }
      }}
    >
      <div
        ref={(el) => {
          if (el && el !== child) {
            child = el;
            fakeMetrics(el, 4000, 500);
          }
        }}
      />
    </div>
  );
}

function renderWith(view: AppView, scrollHeight: number) {
  const store = createStore();
  store.set(currentViewAtom, view);
  const utils = render(
    <Provider store={store}>
      <Harness scrollHeight={scrollHeight} />
    </Provider>,
  );
  return { store, ...utils };
}

const view = (navId: number): AppView => ({
  type: "favorites",
  __navId: navId,
  __navSession: NAV_SESSION,
});

describe("useScrollRestoration", () => {
  beforeEach(() => {
    observers.length = 0;
    container = null;
    child = null;
    clearAllOffsets();
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("lands at the top when the entry has no stored offset", () => {
    saveOffset("2:", 1200);
    renderWith(view(1), 4000);
    expect(container!.scrollTop).toBe(0);
  });

  it("ignores an offset stamped by a previous app run", () => {
    saveOffset("9:", 1200);
    const stale: AppView = {
      type: "favorites",
      __navId: 9,
      __navSession: "some-other-run",
    };
    renderWith(stale, 4000);
    expect(container!.scrollTop).toBe(0);
  });

  it("restores a stored offset when the content is already tall enough", () => {
    saveOffset("3:", 1200);
    renderWith(view(3), 4000);
    expect(container!.scrollTop).toBe(1200);
  });

  it("clamps while content is short, then reaches the target once it grows", () => {
    saveOffset("4:", 1200);
    renderWith(view(4), 700);
    expect(container!.scrollTop).toBe(200);

    fakeMetrics(container!, 4000, 500);
    observers.forEach((fire) => fire());
    expect(container!.scrollTop).toBe(1200);
  });

  it("stops chasing the target once the user scrolls", () => {
    saveOffset("5:", 1200);
    renderWith(view(5), 700);
    expect(container!.scrollTop).toBe(200);

    window.dispatchEvent(new Event("wheel"));
    fakeMetrics(container!, 4000, 500);
    observers.forEach((fire) => fire());
    expect(container!.scrollTop).toBe(200);
  });

  it("stops chasing the target when the user grabs the scrollbar", () => {
    saveOffset("10:", 1200);
    renderWith(view(10), 700);
    expect(container!.scrollTop).toBe(200);

    window.dispatchEvent(new Event("pointerdown"));
    fakeMetrics(container!, 4000, 500);
    observers.forEach((fire) => fire());
    expect(container!.scrollTop).toBe(200);
  });

  it("does not let a restore's own scroll events overwrite the stored offset", () => {
    saveOffset("6:", 1200);
    renderWith(view(6), 700);
    container!.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(getOffset("6:")).toBe(1200);
  });

  it("records a descendant scroller that never bubbles its scroll event", () => {
    renderWith(view(11), 4000);
    child!.scrollTop = 800;
    child!.dispatchEvent(new Event("scroll"));
    expect(getOffset("11:")).toBe(800);
  });

  it("records the offset after the restore has finished", () => {
    saveOffset("7:", 1200);
    renderWith(view(7), 4000);
    expect(container!.scrollTop).toBe(1200);

    container!.scrollTop = 1500;
    container!.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(getOffset("7:")).toBe(1500);
  });

  it("gives up after the settle timeout", () => {
    vi.useFakeTimers();
    saveOffset("8:", 1200);
    renderWith(view(8), 700);
    vi.advanceTimersByTime(3000);

    fakeMetrics(container!, 4000, 500);
    observers.forEach((fire) => fire());
    expect(container!.scrollTop).toBe(200);
  });
});
