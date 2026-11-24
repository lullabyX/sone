/**
 * Vitest global setup.
 *
 * jsdom build does not expose `localStorage` on the global object,
 * provide an in-memory shim so themeFile tests can rely on it.
 */

import { configure } from "@testing-library/react";

function makeMemoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => {
      m.set(k, String(v));
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
    clear: () => m.clear(),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() {
      return m.size;
    },
  };
}

if (
  typeof globalThis.localStorage === "undefined" ||
  globalThis.localStorage === null
) {
  Object.defineProperty(globalThis, "localStorage", {
    value: makeMemoryStorage(),
    configurable: true,
    writable: true,
  });
}

// CI runners are slower than a desktop; the stock 1 s wait for findBy/waitFor
// fails the heavier TV tests there at random.
configure({ asyncUtilTimeout: 5000 });
