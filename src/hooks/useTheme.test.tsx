import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { useEffect } from "react";
import { useTheme } from "./useTheme";
import { themeAtom } from "../atoms/theme";
import { _resetGradientCacheForTests } from "../lib/gradientImage";

const OCEAN = { name: "Ocean", accent: "#3B82F6", bgBase: "#0E1118" };

beforeEach(() => {
  document.documentElement.style.cssText = "";
  _resetGradientCacheForTests();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PAGE_GRADIENT = "--page-gradient-image";

function Child({ onSeen }: { onSeen: (v: string) => void }) {
  // A passive effect in a child runs BEFORE the root's passive effect, but
  // AFTER every layout effect. So this only sees the var if useTheme uses
  // useLayoutEffect.
  useEffect(() => {
    onSeen(document.documentElement.style.getPropertyValue("--th-accent"));
  }, [onSeen]);
  return null;
}

function Root({ onSeen }: { onSeen: (v: string) => void }) {
  useTheme();
  return <Child onSeen={onSeen} />;
}

describe("useTheme", () => {
  it("applies CSS vars before child passive effects run", () => {
    const store = createStore();
    store.set(themeAtom, OCEAN);
    let seen = "unset";
    render(
      <Provider store={store}>
        <Root onSeen={(v) => (seen = v)} />
      </Provider>,
    );
    expect(seen).not.toBe("");
    expect(seen.toUpperCase()).toBe("#3B82F6");
  });

  it("sets colorScheme from the background lightness", () => {
    const store = createStore();
    store.set(themeAtom, {
      name: "Paper",
      accent: "#111111",
      bgBase: "#F5F3EE",
    });
    render(
      <Provider store={store}>
        <Root onSeen={() => {}} />
      </Provider>,
    );
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("publishes the page gradient as an image", () => {
    const stops: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createLinearGradient: () => ({
        addColorStop: (_o: number, c: string) => stops.push(c),
      }),
      fillRect: () => {},
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,AAAA",
    );
    const store = createStore();
    store.set(themeAtom, OCEAN);
    render(
      <Provider store={store}>
        <Root onSeen={() => {}} />
      </Provider>,
    );
    const root = document.documentElement.style;
    expect(root.getPropertyValue(PAGE_GRADIENT)).toBe(
      "url(data:image/png;base64,AAAA)",
    );
    expect(stops).toEqual([
      root.getPropertyValue("--th-bg-surface"),
      root.getPropertyValue("--th-bg-base"),
    ]);
  });

  it("leaves the CSS gradient fallback when canvas is unavailable", () => {
    document.documentElement.style.setProperty(PAGE_GRADIENT, "url(stale)");
    const store = createStore();
    store.set(themeAtom, OCEAN);
    render(
      <Provider store={store}>
        <Root onSeen={() => {}} />
      </Provider>,
    );
    expect(document.documentElement.style.getPropertyValue(PAGE_GRADIENT)).toBe(
      "",
    );
  });

  it("does not throw on a colour the canvas rejects", () => {
    const rejected: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,AAAA",
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createLinearGradient: () => ({
        addColorStop: (_o: number, c: string) => {
          if (!/^#[0-9a-f]{6}$/i.test(c)) {
            rejected.push(c);
            throw new SyntaxError("bad colour");
          }
        },
      }),
      fillRect: () => {},
    } as unknown as CanvasRenderingContext2D);
    const store = createStore();
    store.set(themeAtom, { name: "Broken", accent: "#3B82F6", bgBase: "#zz" });
    expect(() =>
      render(
        <Provider store={store}>
          <Root onSeen={() => {}} />
        </Provider>,
      ),
    ).not.toThrow();
    expect(rejected.length).toBeGreaterThan(0);
  });
});
