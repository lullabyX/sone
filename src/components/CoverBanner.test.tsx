import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";
const bake = vi.fn();
vi.mock("../lib/coverBlur", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/coverBlur")>()),
  bakeCover: (...a: unknown[]) => bake(...a),
}));
import { Provider, createStore } from "jotai";
import CoverBanner from "./CoverBanner";
import { themeAtom } from "../atoms/theme";
import { BLUR_OPTIONS, SHARP_OPTIONS } from "../lib/coverBlur";

type ROCallback = (
  entries: { contentRect: { width: number; height: number } }[],
) => void;
let observers: { cb: ROCallback; el: Element | null }[] = [];
const resizeTo = (width: number, height: number) =>
  act(() => {
    for (const o of observers)
      if (o.el) o.cb([{ contentRect: { width, height } }]);
  });

interface Gradient {
  args: number[];
  stops: [number, string][];
  addColorStop(o: number, c: string): void;
}

let ctx: {
  drawImage: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  save: () => void;
  restore: () => void;
  createLinearGradient: (...args: number[]) => Gradient;
  fillStyle: unknown;
  globalCompositeOperation: string;
};

beforeEach(() => {
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      o: { cb: ROCallback; el: Element | null };
      constructor(cb: ROCallback) {
        this.o = { cb, el: null };
        observers.push(this.o);
      }
      observe(el: Element) {
        this.o.el = el;
      }
      disconnect() {
        this.o.el = null;
      }
    },
  );
  vi.stubGlobal("devicePixelRatio", 1);
  ctx = {
    drawImage: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    save: () => {},
    restore: () => {},
    createLinearGradient: (...args: number[]) => ({
      args,
      stops: [],
      addColorStop(o: number, c: string) {
        this.stops.push([o, c]);
      },
    }),
    fillStyle: null,
    globalCompositeOperation: "source-over",
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  bake.mockReset();
});

const bakedCanvas = (w: number, h: number) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("CoverBanner", () => {
  it("renders nothing without a source", () => {
    expect(
      render(<CoverBanner src={undefined} />).container.firstChild,
    ).toBeNull();
  });

  it("fades the canvas in once the bake is ready", async () => {
    bake.mockResolvedValue(bakedCanvas(128, 128));
    const { getByTestId } = render(<CoverBanner src="img" />);
    expect(bake).toHaveBeenCalledWith("img", BLUR_OPTIONS);
    expect(getByTestId("cover-banner-canvas").style.opacity).toBe("0");
    await waitFor(() =>
      expect(getByTestId("cover-banner-canvas").style.opacity).toBe("1"),
    );
  });

  it("sizes the canvas to the observed box at device resolution", async () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const art = bakedCanvas(128, 128);
    bake.mockResolvedValue(art);
    const { getByTestId } = render(<CoverBanner src="img" />);
    resizeTo(800, 300);
    await waitFor(() => expect(ctx.drawImage).toHaveBeenCalled());
    const canvas = getByTestId("cover-banner-canvas") as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([1600, 600]);
    expect(ctx.drawImage).toHaveBeenLastCalledWith(art, 0, 0, 1600, 1600);
  });

  it("dark variant centre-crops the art to cover the box", async () => {
    const art = bakedCanvas(400, 200);
    bake.mockResolvedValue(art);
    render(<CoverBanner src="img" variant="dark" />);
    expect(bake).toHaveBeenCalledWith("img", SHARP_OPTIONS);
    resizeTo(300, 300);
    await waitFor(() => expect(ctx.drawImage).toHaveBeenCalled());
    // Scaled to 600x300 so the height covers, then shifted left by 150.
    expect(ctx.drawImage).toHaveBeenLastCalledWith(art, -150, 0, 600, 300);
  });

  it("repaints when the box size changes", async () => {
    bake.mockResolvedValue(bakedCanvas(128, 128));
    const { getByTestId } = render(<CoverBanner src="img" />);
    resizeTo(800, 300);
    await waitFor(() => expect(ctx.drawImage).toHaveBeenCalledTimes(1));
    resizeTo(1000, 400);
    expect(ctx.drawImage).toHaveBeenCalledTimes(2);
    const canvas = getByTestId("cover-banner-canvas") as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([1000, 400]);
  });

  it("does not paint a bake that finishes after the source changed", async () => {
    const first = deferred<HTMLCanvasElement>();
    const second = deferred<HTMLCanvasElement>();
    bake.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const stale = bakedCanvas(128, 128);
    const fresh = bakedCanvas(128, 64);
    const { rerender, getByTestId } = render(<CoverBanner src="a" />);
    resizeTo(800, 300);
    rerender(<CoverBanner src="b" />);
    await act(async () => first.resolve(stale));
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(getByTestId("cover-banner-canvas").style.opacity).toBe("0");
    await act(async () => second.resolve(fresh));
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(ctx.drawImage.mock.calls[0][0]).toBe(fresh);
  });

  it("is hidden from assistive tech", () => {
    bake.mockReturnValue(new Promise(() => {}));
    const { getByTestId } = render(<CoverBanner src="img" />);
    expect(getByTestId("cover-banner-canvas").getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  const paintedLayers = async (variant: "blur" | "dark") => {
    bake.mockResolvedValue(bakedCanvas(128, 128));
    const layers: { op: string; style: unknown }[] = [];
    ctx.fillRect.mockImplementation(() =>
      layers.push({ op: ctx.globalCompositeOperation, style: ctx.fillStyle }),
    );
    const store = createStore();
    store.set(themeAtom, { name: "T", accent: "#3B82F6", bgBase: "#101010" });
    render(
      <Provider store={store}>
        <CoverBanner src="img" variant={variant} />
      </Provider>,
    );
    resizeTo(800, 300);
    await waitFor(() => expect(layers).toHaveLength(3));
    const [wash, tint, fade] = layers;
    return {
      wash: wash.style,
      tint: tint.style as Gradient,
      fade: fade.style as Gradient,
      fadeOp: fade.op,
    };
  };

  it("blur variant: tint 0% -> 10% -> 60% to the right, fade from 50%", async () => {
    const { wash, tint, fade, fadeOp } = await paintedLayers("blur");
    expect(wash).toBe("rgba(16, 16, 16, 0.5)");
    expect(tint.args).toEqual([0, 0, 800, 0]);
    expect(tint.stops).toEqual([
      [0, "rgba(16, 16, 16, 0)"],
      [0.5, "rgba(16, 16, 16, 0.1)"],
      [1, "rgba(16, 16, 16, 0.6)"],
    ]);
    expect(fadeOp).toBe("destination-in");
    expect(fade.stops).toEqual([
      [0, "rgba(0, 0, 0, 1)"],
      [0.5, "rgba(0, 0, 0, 1)"],
      [1, "rgba(0, 0, 0, 0)"],
    ]);
  });

  it("dark variant: tint 30% -> 70% -> 0% to the right, fade from 22%", async () => {
    const { wash, tint, fade, fadeOp } = await paintedLayers("dark");
    expect(wash).toBe("rgba(16, 16, 16, 0.5)");
    expect(tint.stops).toEqual([
      [0, "rgba(16, 16, 16, 0.3)"],
      [0.5, "rgba(16, 16, 16, 0.7)"],
      [1, "rgba(16, 16, 16, 0)"],
    ]);
    expect(fadeOp).toBe("destination-in");
    expect(fade.stops).toEqual([
      [0, "rgba(0, 0, 0, 1)"],
      [0.22, "rgba(0, 0, 0, 1)"],
      [1, "rgba(0, 0, 0, 0)"],
    ]);
  });
});
