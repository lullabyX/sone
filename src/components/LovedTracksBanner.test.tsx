import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

const draw = vi.fn();
vi.mock("../lib/lovedBanner", async (orig) => ({
  ...(await orig<any>()),
  drawBanner: (...a: unknown[]) => draw(...a),
}));
import LovedTracksBanner, { FRAME_INTERVAL_MS } from "./LovedTracksBanner";

let rafCbs: FrameRequestCallback[] = [];
beforeEach(() => {
  rafCbs = [];
  draw.mockReset();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    rafCbs.push(cb);
    return rafCbs.length;
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
  } as any);
  (globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  (globalThis as any).IntersectionObserver = class {
    constructor(cb: any) {
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
});
const pump = (now: number) => {
  const cbs = rafCbs;
  rafCbs = [];
  cbs.forEach((cb) => cb(now));
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
    expect(rafCbs).toHaveLength(0);
    (document.hasFocus as any).mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(rafCbs.length).toBeGreaterThan(0);
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
    expect(rafCbs).toHaveLength(0);
  });

  it("keeps the overlays", () => {
    const { container } = render(<LovedTracksBanner />);
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(
      container.querySelectorAll("div.absolute.inset-0").length,
    ).toBeGreaterThanOrEqual(3);
  });
});
