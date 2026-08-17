import { describe, it, expect, vi, beforeAll } from "vitest";
import { render } from "@testing-library/react";
import { Provider, createStore } from "jotai";

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

function renderLayout() {
  const store = createStore();
  return render(
    <Provider store={store}>
      <Layout>
        <div data-testid="child" />
      </Layout>
    </Provider>,
  );
}

describe("Layout", () => {
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
});
