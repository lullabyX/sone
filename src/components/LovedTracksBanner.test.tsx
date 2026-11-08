import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

const draw = vi.fn();
vi.mock("../lib/lovedBanner", async (orig) => ({
  ...(await orig<any>()),
  drawBanner: (...a: unknown[]) => draw(...a),
}));
import { Provider, createStore } from "jotai";
import LovedTracksBanner, { FRAME_INTERVAL_MS } from "./LovedTracksBanner";
import { themeAtom } from "../atoms/theme";

let rafCbs = new Map<number, FrameRequestCallback>();
let rafId = 0;
let roCb: (
  entries: { contentRect: { width: number; height: number } }[],
) => void;
let ioCb: (entries: { isIntersecting: boolean }[]) => void;
let clock = 0;

beforeEach(() => {
  rafCbs = new Map();
  clock = 0;
  draw.mockReset();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    rafCbs.set(++rafId, cb);
    return rafId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    rafCbs.delete(id);
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    clearRect() {},
    fillRect() {},
    globalAlpha: 1,
    fillStyle: null,
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
  } as any);
  (globalThis as any).ResizeObserver = class {
    constructor(cb: any) {
      roCb = cb;
    }
    observe() {}
    disconnect() {}
  };
  (globalThis as any).IntersectionObserver = class {
    constructor(cb: any) {
      ioCb = cb;
      cb([{ isIntersecting: true }]);
    }
    observe() {}
    disconnect() {}
  };
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }) as any;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const pump = (now: number) => {
  const cbs = [...rafCbs.values()];
  rafCbs = new Map();
  cbs.forEach((cb) => cb(now));
};
const lastT = () => draw.mock.calls[draw.mock.calls.length - 1][3];
const setFocus = (focused: boolean) => {
  (document.hasFocus as any).mockReturnValue(focused);
  act(() => {
    window.dispatchEvent(new Event(focused ? "focus" : "blur"));
  });
};

describe("LovedTracksBanner", () => {
  it("draws a frame and gates to the frame interval", () => {
    render(<LovedTracksBanner />);
    act(() => pump(0));
    expect(draw).toHaveBeenCalledTimes(1);
    act(() => pump(FRAME_INTERVAL_MS / 2));
    expect(draw).toHaveBeenCalledTimes(1);
    act(() => pump(FRAME_INTERVAL_MS + 1));
    expect(draw).toHaveBeenCalledTimes(2);
  });

  it("starts paused when inactive and draws once on activation", () => {
    (document.hasFocus as any).mockReturnValue(false);
    render(<LovedTracksBanner />);
    act(() => pump(0));
    expect(rafCbs.size).toBe(0);
    const before = draw.mock.calls.length;
    setFocus(true);
    expect(rafCbs.size).toBeGreaterThan(0);
    act(() => pump(1000));
    expect(draw.mock.calls.length).toBe(before + 1);
  });

  it("draws one static frame under reduced motion", () => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }) as any;
    render(<LovedTracksBanner />);
    act(() => pump(0));
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw.mock.calls[0][3]).toBe(0);
    expect(rafCbs.size).toBe(0);
  });

  it("draws the theme overlays into the canvas", () => {
    const store = createStore();
    store.set(themeAtom, {
      name: "Ocean",
      accent: "#3B82F6",
      bgBase: "#0E1118",
    });
    const { container } = render(
      <Provider store={store}>
        <LovedTracksBanner />
      </Provider>,
    );
    expect(container.querySelector("canvas")!.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect((container.firstChild as HTMLElement).children).toHaveLength(1);
    act(() => pump(0));
    const overlay = draw.mock.calls[draw.mock.calls.length - 1][4];
    expect(overlay.wash).toBe("rgba(14, 17, 24, 0.6)");
  });

  it("repaints with the new overlay when the theme changes", () => {
    const store = createStore();
    store.set(themeAtom, {
      name: "Ocean",
      accent: "#3B82F6",
      bgBase: "#0E1118",
    });
    render(
      <Provider store={store}>
        <LovedTracksBanner />
      </Provider>,
    );
    act(() => pump(0));
    const before = draw.mock.calls.length;
    act(() =>
      store.set(themeAtom, {
        name: "Paper",
        accent: "#111111",
        bgBase: "#F5F3EE",
      }),
    );
    expect(draw.mock.calls.length).toBe(before + 1);
    expect(draw.mock.calls[before][4].wash).toBe("rgba(245, 243, 238, 0.6)");
  });

  it("freezes time while paused and resumes without a jump", () => {
    clock = 1000;
    render(<LovedTracksBanner />);
    act(() => pump(0));
    clock = 2000;
    act(() => pump(1000));
    expect(lastT()).toBe(1);

    setFocus(false);
    clock = 10000;
    act(() => roCb([{ contentRect: { width: 800, height: 200 } }]));
    expect(lastT()).toBe(1);

    setFocus(true);
    act(() => pump(9000));
    expect(lastT()).toBe(1);
    clock = 10500;
    act(() => pump(9500));
    expect(lastT()).toBe(1.5);
  });

  it("sizes the backing store to dpr / 4", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const { getByTestId } = render(<LovedTracksBanner />);
    const canvas = getByTestId("loved-banner-canvas") as HTMLCanvasElement;
    act(() => roCb([{ contentRect: { width: 800, height: 200 } }]));
    expect([canvas.width, canvas.height]).toEqual([400, 100]);
  });

  it("caps the backing width at 1024 and keeps the aspect ratio", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const { getByTestId } = render(<LovedTracksBanner />);
    const canvas = getByTestId("loved-banner-canvas") as HTMLCanvasElement;
    act(() => roCb([{ contentRect: { width: 4096, height: 400 } }]));
    expect([canvas.width, canvas.height]).toEqual([1024, 100]);
  });

  it("stops the loop when scrolled out of view and restarts on return", () => {
    render(<LovedTracksBanner />);
    act(() => pump(0));
    expect(rafCbs.size).toBe(1);
    act(() => ioCb([{ isIntersecting: false }]));
    expect(rafCbs.size).toBe(0);
    act(() => ioCb([{ isIntersecting: true }]));
    expect(rafCbs.size).toBe(1);
    const before = draw.mock.calls.length;
    act(() => pump(1000));
    expect(draw.mock.calls.length).toBe(before + 1);
  });
});
