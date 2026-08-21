import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";

// jsdom has no Element.prototype.scrollTo. A real implementation, not a no-op,
// so that a scroll reset re-added to Layout is observable as a lost offset.
beforeAll(() => {
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = function (x?: unknown, y?: unknown) {
      if (typeof x === "object" && x !== null) {
        const opts = x as ScrollToOptions;
        if (opts.left !== undefined) this.scrollLeft = opts.left;
        if (opts.top !== undefined) this.scrollTop = opts.top;
        return;
      }
      if (typeof x === "number") this.scrollLeft = x;
      if (typeof y === "number") this.scrollTop = y;
    };
  }
});

class StubResizeObserver {
  observe() {}
  disconnect() {}
}

/** jsdom has no layout: scrollHeight/clientHeight are always 0, so the
 *  restore's clamp would pin every offset to 0. */
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

vi.mock("./Sidebar", () => ({ default: () => <div /> }));
vi.mock("./Header", () => ({ default: () => <div /> }));
vi.mock("./PlayerBar", () => ({ default: () => <div /> }));
vi.mock("./NowPlayingDrawer", () => ({ default: () => <div /> }));
vi.mock("./TitleBar", () => ({ default: () => <div /> }));
vi.mock("./ResizeEdges", () => ({ default: () => <div /> }));
vi.mock("./MaximizedPlayer", () => ({ default: () => <div /> }));
vi.mock("./VideoPlayer", () => ({ default: () => <div /> }));
vi.mock("../hooks/useMiniplayerEmitter", () => ({
  useMiniplayerEmitter: () => {},
}));

import Layout from "./Layout";
import { currentViewAtom } from "../atoms/navigation";
import {
  clearAllOffsets,
  pushView,
  saveOffset,
  scrollKey,
} from "../lib/scrollMemory";
import { usePageScrollElement } from "../contexts/PageScrollContext";

function renderLayout(children: ReactNode = null, store = createStore()) {
  const view = render(
    <Provider store={store}>
      <Layout>{children}</Layout>
    </Provider>,
  );
  return { ...view, store };
}

describe("Layout", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    clearAllOffsets();
  });

  it("makes the scroll container focusable so arrow keys can scroll it", () => {
    const { container } = renderLayout();
    const scroller = container.querySelector(".custom-scrollbar");
    expect(scroller).not.toBeNull();
    expect(scroller!.getAttribute("tabindex")).toBe("-1");
  });

  it("focuses the scroll container on mount", () => {
    const { container } = renderLayout();
    const scroller = container.querySelector(".custom-scrollbar");
    expect(document.activeElement).toBe(scroller);
  });

  it("refocuses the scroll container when the view changes", () => {
    const { container, store } = renderLayout(<button>Play</button>);
    const scroller = container.querySelector(".custom-scrollbar");
    const button = container.querySelector("button")!;
    button.focus();
    expect(document.activeElement).toBe(button);

    act(() => {
      store.set(currentViewAtom, { type: "album", albumId: 1 });
    });
    expect(document.activeElement).toBe(scroller);
  });

  it("leaves focus in a text field when the view changes", () => {
    const { container, store } = renderLayout(<input />);
    const input = container.querySelector("input")!;
    input.focus();
    expect(document.activeElement).toBe(input);

    act(() => {
      store.set(currentViewAtom, { type: "album", albumId: 1 });
    });
    expect(document.activeElement).toBe(input);
  });

  it("keeps the restored offset instead of resetting the scroll container", () => {
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
    const view = pushView({ type: "favorites" });
    saveOffset(scrollKey(view)!, 250);
    const store = createStore();
    store.set(currentViewAtom, view);

    // Child refs attach before Layout's layout effects, so this is the only
    // place metrics can be faked before the restore reads them.
    const { container } = renderLayout(
      <div
        ref={(el) => {
          if (el) fakeMetrics(el.parentElement!, 4000, 500);
        }}
      />,
      store,
    );

    const scroller = container.querySelector(".custom-scrollbar")!;
    expect(scroller.scrollTop).toBe(250);
  });
  it("publishes the scroll container to descendants", () => {
    let seen: HTMLElement | null = null;
    function Probe({ onRead }: { onRead: (el: HTMLElement | null) => void }) {
      onRead(usePageScrollElement());
      return null;
    }

    renderLayout(<Probe onRead={(el) => (seen = el)} />);

    expect(seen).not.toBe(null);
    expect(seen!.classList.contains("custom-scrollbar")).toBe(true);
  });
});
