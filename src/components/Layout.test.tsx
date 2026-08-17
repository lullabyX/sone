import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";

// jsdom has no Element.prototype.scrollTo; Layout's effect calls it.
beforeAll(() => {
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = () => {};
  }
});

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

function renderLayout(children: ReactNode = null) {
  const store = createStore();
  const view = render(
    <Provider store={store}>
      <Layout>{children}</Layout>
    </Provider>,
  );
  return { ...view, store };
}

describe("Layout", () => {
  afterEach(cleanup);

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
});
