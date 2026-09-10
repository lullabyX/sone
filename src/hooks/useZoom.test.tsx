import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { useEffect } from "react";
import { useZoom } from "./useZoom";

const ZOOM_KEY = "sone.zoom.v1";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.cssText = "";
});
afterEach(cleanup);

function Child({ onSeen }: { onSeen: (v: string) => void }) {
  // A child's passive effect runs BEFORE the root's passive effect but AFTER
  // every layout effect, so this only sees the zoom if useZoom applies it in
  // a layout effect — i.e. before the browser paints.
  useEffect(() => {
    onSeen(document.documentElement.style.zoom);
  }, [onSeen]);
  return null;
}

function Root({ onSeen }: { onSeen: (v: string) => void }) {
  useZoom();
  return <Child onSeen={onSeen} />;
}

function renderWithZoom(onSeen: (v: string) => void) {
  render(
    <Provider store={createStore()}>
      <Root onSeen={onSeen} />
    </Provider>,
  );
}

describe("useZoom", () => {
  it("applies the persisted zoom before child passive effects run", () => {
    localStorage.setItem(ZOOM_KEY, "1.5");
    let seen = "unset";
    renderWithZoom((v) => (seen = v));
    expect(seen).not.toBe("");
    expect(seen).toBe("1.5");
  });

  it("also exposes the zoom as the --zoom custom property", () => {
    localStorage.setItem(ZOOM_KEY, "0.8");
    renderWithZoom(() => {});
    expect(document.documentElement.style.getPropertyValue("--zoom")).toBe(
      "0.8",
    );
  });

  it("restores a persisted value at the top of the allowed range", () => {
    // Pins the read path: "1" is also the no-value default, so a test that
    // only checks the clamp would still pass against the wrong storage key.
    localStorage.setItem(ZOOM_KEY, "2.0");
    let seen = "unset";
    renderWithZoom((v) => (seen = v));
    expect(seen).toBe("2");
  });

  it("falls back to 1 for an out-of-range persisted value", () => {
    localStorage.setItem(ZOOM_KEY, "99");
    let seen = "unset";
    renderWithZoom((v) => (seen = v));
    expect(seen).toBe("1");
  });
});
