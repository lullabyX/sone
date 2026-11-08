import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { gradientDataUrl, _resetGradientCacheForTests } from "./gradientImage";

const STOPS = [
  { offset: 0, color: "#101010" },
  { offset: 1, color: "#000000" },
];

const stubCanvas = () => {
  const gradient = { addColorStop: vi.fn() };
  const ctx = {
    createLinearGradient: vi.fn(() => gradient),
    fillRect: vi.fn(),
    fillStyle: null as unknown,
  };
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  const toDataURL = vi
    .spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockReturnValue("data:image/png;base64,AAAA");
  return { ctx, gradient, getContext, toDataURL };
};

beforeEach(() => _resetGradientCacheForTests());
afterEach(() => vi.restoreAllMocks());

describe("gradientDataUrl", () => {
  it("returns null without a 2d context so callers keep CSS gradients", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(gradientDataUrl(STOPS, "vertical")).toBeNull();
  });

  it("renders a 1xN vertical strip with the given stops", () => {
    const { ctx, gradient, toDataURL } = stubCanvas();
    expect(gradientDataUrl(STOPS, "vertical", 64)).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(ctx.createLinearGradient).toHaveBeenCalledWith(0, 0, 0, 64);
    expect(gradient.addColorStop.mock.calls).toEqual([
      [0, "#101010"],
      [1, "#000000"],
    ]);
    expect(ctx.fillStyle).toBe(gradient);
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1, 64);
    expect(toDataURL).toHaveBeenCalledWith("image/png");
  });

  it("renders an Nx1 horizontal strip", () => {
    const { ctx } = stubCanvas();
    gradientDataUrl(STOPS, "horizontal");
    expect(ctx.createLinearGradient).toHaveBeenCalledWith(0, 0, 256, 0);
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 256, 1);
  });

  it("memoises by its arguments", () => {
    const { getContext } = stubCanvas();
    gradientDataUrl(STOPS, "vertical");
    gradientDataUrl([...STOPS.map((s) => ({ ...s }))], "vertical");
    expect(getContext).toHaveBeenCalledTimes(1);
    gradientDataUrl(STOPS, "horizontal");
    gradientDataUrl(STOPS, "vertical", 128);
    gradientDataUrl([{ offset: 0, color: "#202020" }], "vertical");
    expect(getContext).toHaveBeenCalledTimes(4);
  });

  it("returns null instead of throwing when a colour can't be parsed", () => {
    const { gradient, getContext } = stubCanvas();
    gradient.addColorStop.mockImplementation(() => {
      throw new SyntaxError("bad colour");
    });
    const bad = [{ offset: 0, color: "#NaNNaNNaN" }];
    expect(gradientDataUrl(bad, "vertical")).toBeNull();
    expect(gradientDataUrl(bad, "vertical")).toBeNull();
    expect(getContext).toHaveBeenCalledTimes(2);
  });
});
