import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { useEffect } from "react";
import { useTheme } from "./useTheme";
import { themeAtom } from "../atoms/theme";

const OCEAN = { name: "Ocean", accent: "#3B82F6", bgBase: "#0E1118" };

beforeEach(() => {
  document.documentElement.style.cssText = "";
});

afterEach(cleanup);

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
});
