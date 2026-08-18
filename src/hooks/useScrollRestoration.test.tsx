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
/** The real observer reports growth for whatever it was told to watch, so the
 *  stub records that set: re-attaching after a subtree swap is the behaviour
 *  under test, not an implementation detail. */
const observed = new Set<Element>();

class StubResizeObserver {
  constructor(private cb: () => void) {
    observers.push(() => this.cb());
  }
  observe(el: Element) {
    observed.add(el);
  }
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
let nested: HTMLDivElement | null = null;
let overlay: HTMLDivElement | null = null;

/** `nested` is the container's first child and scrolls, so it stands in for a
 *  page root; `overlay` scrolls too but is off that chain, standing in for the
 *  modal panes and menus that must never be recorded as the page's offset. The
 *  container is pre-scrolled because refs attach before layout effects, so a
 *  restore that lands at the top has to actively reset a non-zero offset. */
function Harness({
  scrollHeight,
  nestedScrollHeight,
}: {
  scrollHeight: number;
  nestedScrollHeight: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useScrollRestoration(ref);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (el && el !== container) {
          container = el;
          fakeMetrics(el, scrollHeight, 500);
          el.scrollTop = 100;
        }
      }}
    >
      <div
        ref={(el) => {
          if (el && el !== nested) {
            nested = el;
            el.style.overflowY = "auto";
            fakeMetrics(el, nestedScrollHeight, 500);
          }
        }}
      />
      <div
        ref={(el) => {
          if (el && el !== overlay) {
            overlay = el;
            el.style.overflowY = "auto";
            fakeMetrics(el, 4000, 500);
          }
        }}
      />
    </div>
  );
}

function renderWith(
  view: AppView,
  scrollHeight: number,
  nestedScrollHeight = 0,
) {
  const store = createStore();
  store.set(currentViewAtom, view);
  const utils = render(
    <Provider store={store}>
      <Harness
        scrollHeight={scrollHeight}
        nestedScrollHeight={nestedScrollHeight}
      />
    </Provider>,
  );
  return { store, ...utils };
}

/** The child is created imperatively so React never owns it and the test can
 *  swap it the way the seven skeleton-returning pages do: a different element
 *  type at the same position, i.e. unmount + mount. Ref callbacks run before
 *  layout effects, so the "skeleton" is already in place when the restore
 *  starts. */
function SwapHarness() {
  const ref = useRef<HTMLDivElement | null>(null);
  useScrollRestoration(ref);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (el && el !== container) {
          container = el;
          fakeMetrics(el, 700, 500);
          el.scrollTop = 100;
          el.appendChild(document.createElement("div"));
        }
      }}
    />
  );
}

function renderSwap(view: AppView) {
  const store = createStore();
  store.set(currentViewAtom, view);
  return render(
    <Provider store={store}>
      <SwapHarness />
    </Provider>,
  );
}

const view = (navId: number): AppView => ({
  type: "favorites",
  __navId: navId,
  __navSession: NAV_SESSION,
});

describe("useScrollRestoration", () => {
  beforeEach(() => {
    observers.length = 0;
    observed.clear();
    container = null;
    nested = null;
    overlay = null;
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
    renderWith(view(11), 4000, 4000);
    nested!.scrollTop = 800;
    nested!.dispatchEvent(new Event("scroll"));
    expect(getOffset("11:")).toBe(800);
  });

  it("restores a nested overflow-auto child alongside the container", () => {
    saveOffset("12:", 1200);
    renderWith(view(12), 4000, 4000);
    expect(container!.scrollTop).toBe(1200);
    expect(nested!.scrollTop).toBe(1200);
  });

  it("ignores a scroller the restore does not write to", () => {
    renderWith(view(13), 4000);
    overlay!.scrollTop = 60;
    overlay!.dispatchEvent(new Event("scroll"));
    expect(getOffset("13:")).toBeUndefined();

    container!.scrollTop = 2400;
    container!.dispatchEvent(new Event("scroll"));
    expect(getOffset("13:")).toBe(2400);
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

  it("watches the new subtree after a skeleton is swapped for content", () => {
    saveOffset("14:", 1200);
    renderSwap(view(14));
    expect(container!.scrollTop).toBe(200);

    const skeleton = container!.firstElementChild!;
    expect(observed.has(skeleton)).toBe(true);

    const content = document.createElement("section");
    container!.replaceChild(content, skeleton);
    fakeMetrics(container!, 4000, 500);
    observers.forEach((fire) => fire());

    expect(observed.has(content)).toBe(true);
    expect(container!.scrollTop).toBe(1200);
  });

  it("restarts the settle timeout on growth, then gives up once growth stops", () => {
    vi.useFakeTimers();
    saveOffset("15:", 1200);
    renderSwap(view(15));
    expect(container!.scrollTop).toBe(200);

    vi.advanceTimersByTime(2500);
    fakeMetrics(container!, 1000, 500);
    observers.forEach((fire) => fire());
    expect(container!.scrollTop).toBe(500);

    // Past 3000ms since the restore started, but only 2500ms since the growth.
    vi.advanceTimersByTime(2500);
    fakeMetrics(container!, 1600, 500);
    observers.forEach((fire) => fire());
    expect(container!.scrollTop).toBe(1100);

    vi.advanceTimersByTime(3000);
    fakeMetrics(container!, 4000, 500);
    observers.forEach((fire) => fire());
    expect(container!.scrollTop).toBe(1100);
  });

  it("stops chasing at the absolute ceiling even while content keeps growing", () => {
    vi.useFakeTimers();
    saveOffset("16:", 50000);
    renderSwap(view(16));

    // Growth every 2s keeps the quiet period alive, so only the ceiling can
    // end this restore: it fires during the eighth step, at 15000ms.
    for (let height = 1000; height <= 8000; height += 1000) {
      vi.advanceTimersByTime(2000);
      fakeMetrics(container!, height, 500);
      observers.forEach((fire) => fire());
    }

    expect(container!.scrollTop).toBe(6500);
    fakeMetrics(container!, 60000, 500);
    observers.forEach((fire) => fire());
    expect(container!.scrollTop).toBe(6500);
  });
});
