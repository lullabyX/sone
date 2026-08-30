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
import { useRestoreLoader } from "./useRestoreLoader";
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

function LoaderHarness({
  scrollHeight,
  loadMore,
  hasMore,
}: {
  scrollHeight: number;
  loadMore: () => void;
  hasMore: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useRestoreLoader(loadMore, hasMore);
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
    />
  );
}

function renderWithLoader(
  view: AppView,
  scrollHeight: number,
  loadMore: () => void,
  hasMore: boolean,
) {
  const store = createStore();
  store.set(currentViewAtom, view);
  return render(
    <Provider store={store}>
      <LoaderHarness
        scrollHeight={scrollHeight}
        loadMore={loadMore}
        hasMore={hasMore}
      />
    </Provider>,
  );
}

function GlideHarness({ scrollTo }: { scrollTo: (opts: unknown) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useScrollRestoration(ref);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (el && el !== container) {
          container = el;
          fakeMetrics(el, 4000, 500);
          (el as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
        }
      }}
    />
  );
}

describe("useScrollRestoration", () => {
  beforeEach(() => {
    observers.length = 0;
    observed.clear();
    container = null;
    nested = null;
    overlay = null;
    clearAllOffsets();
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    // Returns 0, not 1: the callback runs synchronously and clears the hook's
    // frame handle, so a truthy return would latch the throttle and silently
    // drop every scroll after the first.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
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

  it("holds still while content is short, then lands in one jump", () => {
    saveOffset("4:", 1200);
    renderWith(view(4), 700);
    // The old behaviour stepped to the clamped 200 here; stepping down as each
    // page arrived is what the single jump replaces.
    expect(container!.scrollTop).toBe(100);

    fakeMetrics(container!, 4000, 500);
    observers.forEach((fire) => fire());
    expect(container!.scrollTop).toBe(1200);
  });

  it("stops chasing the target once the user scrolls", () => {
    saveOffset("5:", 1200);
    renderWith(view(5), 700);
    expect(container!.scrollTop).toBe(100);

    window.dispatchEvent(new Event("wheel"));
    fakeMetrics(container!, 4000, 500);
    observers.forEach((fire) => fire());
    expect(container!.scrollTop).toBe(100);
  });

  it("stops chasing the target when the user grabs the scrollbar", () => {
    saveOffset("10:", 1200);
    renderWith(view(10), 700);
    expect(container!.scrollTop).toBe(100);

    window.dispatchEvent(new Event("pointerdown"));
    fakeMetrics(container!, 4000, 500);
    observers.forEach((fire) => fire());
    expect(container!.scrollTop).toBe(100);
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
    // Out of content: the settle lands as deep as the page goes, in one move.
    vi.advanceTimersByTime(3000);
    expect(container!.scrollTop).toBe(200);

    fakeMetrics(container!, 4000, 500);
    observers.forEach((fire) => fire());
    expect(container!.scrollTop).toBe(200);
  });

  it("watches the new subtree after a skeleton is swapped for content", () => {
    saveOffset("14:", 1200);
    renderSwap(view(14));
    expect(container!.scrollTop).toBe(100);

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
    expect(container!.scrollTop).toBe(100);

    vi.advanceTimersByTime(2500);
    fakeMetrics(container!, 1000, 500);
    observers.forEach((fire) => fire());
    expect(container!.scrollTop).toBe(100);

    // Past 3000ms since the restore started, but only 2500ms since the growth,
    // so the restore is still live and still has not moved the viewport.
    vi.advanceTimersByTime(2500);
    fakeMetrics(container!, 1600, 500);
    observers.forEach((fire) => fire());
    expect(container!.scrollTop).toBe(100);

    // Growth stops: the quiet period expires and lands at the deepest offset
    // the content allows, once.
    vi.advanceTimersByTime(3000);
    expect(container!.scrollTop).toBe(1100);

    fakeMetrics(container!, 4000, 500);
    observers.forEach((fire) => fire());
    expect(container!.scrollTop).toBe(1100);
  });

  it("asks the page for more rows instead of moving the viewport", () => {
    saveOffset("17:", 1200);
    const loadMore = vi.fn();
    renderWithLoader(view(17), 700, loadMore, true);

    // Unreachable offset: the request goes to the data layer and the list has
    // not moved, which is what removes the visible pagination stepping.
    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(container!.scrollTop).toBe(100);

    // A callback that brought no rows must not cost another fetch — a real
    // ResizeObserver fires for reasons that add nothing.
    observers.forEach((fire) => fire());
    expect(loadMore).toHaveBeenCalledTimes(1);

    // Rows arrived but the offset is still out of reach: ask once more.
    fakeMetrics(container!, 900, 500);
    observers.forEach((fire) => fire());
    expect(loadMore).toHaveBeenCalledTimes(2);
    expect(container!.scrollTop).toBe(100);

    observers.forEach((fire) => fire());
    expect(loadMore).toHaveBeenCalledTimes(2);
  });

  it("stops asking once the rows it needs have arrived", () => {
    saveOffset("18:", 1200);
    const loadMore = vi.fn();
    renderWithLoader(view(18), 700, loadMore, true);
    expect(loadMore).toHaveBeenCalledTimes(1);

    fakeMetrics(container!, 4000, 500);
    observers.forEach((fire) => fire());

    expect(container!.scrollTop).toBe(1200);
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("does not ask a page that has no more rows", () => {
    saveOffset("19:", 1200);
    const loadMore = vi.fn();
    renderWithLoader(view(19), 700, loadMore, false);

    observers.forEach((fire) => fire());
    expect(loadMore).not.toHaveBeenCalled();
  });

  it("jumps instantly when the user prefers reduced motion", () => {
    const scrollTo = vi.fn();
    const store = createStore();
    store.set(currentViewAtom, view(20));
    saveOffset("20:", 1200);
    vi.stubGlobal("matchMedia", () => ({ matches: true }));

    render(
      <Provider store={store}>
        <GlideHarness scrollTo={scrollTo} />
      </Provider>,
    );

    expect(scrollTo).not.toHaveBeenCalled();
    expect(container!.scrollTop).toBe(1200);
  });

  it("jumps a runway short of the offset, then scrolls smoothly to it", () => {
    const scrollTo = vi.fn();
    const store = createStore();
    store.set(currentViewAtom, view(22));
    saveOffset("22:", 1200);

    render(
      <Provider store={store}>
        <GlideHarness scrollTo={scrollTo} />
      </Provider>,
    );

    // clientHeight 500 * 1.5 runway = 750 below the 1200 target.
    expect(container!.scrollTop).toBe(450);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: "smooth" });
  });

  it("keeps recording paused until the glide settles", () => {
    const scrollTo = vi.fn();
    const store = createStore();
    store.set(currentViewAtom, view(23));
    saveOffset("23:", 1200);

    render(
      <Provider store={store}>
        <GlideHarness scrollTo={scrollTo} />
      </Provider>,
    );

    // Mid-glide scroll events must not overwrite the offset being restored.
    container!.scrollTop = 700;
    container!.dispatchEvent(new Event("scroll"));
    expect(getOffset("23:")).toBe(1200);

    container!.dispatchEvent(new Event("scrollend"));
    container!.scrollTop = 1200;
    container!.dispatchEvent(new Event("scroll"));
    expect(getOffset("23:")).toBe(1200);

    container!.scrollTop = 1500;
    container!.dispatchEvent(new Event("scroll"));
    expect(getOffset("23:")).toBe(1500);
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

    // The ceiling fires mid-eighth-step, so it lands against the height the
    // seventh step left behind.
    expect(container!.scrollTop).toBe(6500);
    fakeMetrics(container!, 60000, 500);
    observers.forEach((fire) => fire());
    expect(container!.scrollTop).toBe(6500);
  });
});
