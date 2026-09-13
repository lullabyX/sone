import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useFittedCoverSize } from "./useFittedCoverSize";

type Box = { width: number; height: number };

/** jsdom ships no ResizeObserver — this one lets a test drive the callback. */
class FakeResizeObserver {
  static latest: FakeResizeObserver | null = null;
  observed: Element[] = [];
  constructor(private cb: (entries: { contentRect: Box }[]) => void) {
    FakeResizeObserver.latest = this;
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {}
  emit(box: Box) {
    act(() => this.cb([{ contentRect: box }]));
  }
}

const TEXT_HEIGHT = 50;

function Harness() {
  const { columnRef, textRef, size } = useFittedCoverSize();
  return (
    <div ref={columnRef}>
      <div data-testid="cover" style={size != null ? { width: size } : {}} />
      <div
        ref={(el) => {
          if (el)
            Object.defineProperty(el, "offsetHeight", {
              configurable: true,
              get: () => TEXT_HEIGHT,
            });
          textRef.current = el;
        }}
      />
    </div>
  );
}

function renderHarness() {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const { getByTestId } = render(<Harness />);
  return {
    cover: getByTestId("cover") as HTMLElement,
    observer: FakeResizeObserver.latest!,
  };
}

describe("useFittedCoverSize", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    FakeResizeObserver.latest = null;
  });

  it("sizes the cover from the column's content box", () => {
    const { cover, observer } = renderHarness();
    observer.emit({ width: 900, height: 300 });
    // 300 tall - 24 gap - 50 text = 226, narrower than the 900 available.
    expect(cover.style.width).toBe("226px");
  });

  it("observes the column element", () => {
    const { observer } = renderHarness();
    expect(observer.observed).toHaveLength(1);
  });

  it("keeps the last good size when the drawer is hidden and reports zero", () => {
    const { cover, observer } = renderHarness();
    observer.emit({ width: 900, height: 300 });
    observer.emit({ width: 0, height: 0 });
    expect(cover.style.width).toBe("226px");
  });
});
