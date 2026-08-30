/**
 * Vitest global setup.
 *
 * jsdom build does not expose `localStorage` on the global object,
 * provide an in-memory shim so themeFile tests can rely on it.
 */

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
