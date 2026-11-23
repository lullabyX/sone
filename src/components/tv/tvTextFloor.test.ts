import { expect, it } from "vitest";
import { setupTvTest } from "./tvTestUtils";

setupTvTest();

const sources = Object.fromEntries(
  Object.entries(
    import.meta.glob("./**/*.{tsx,ts}", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>,
  ).filter(([p]) => !/\.test\.tsx?$/.test(p)),
);

it("no TV text is smaller than 0.75rem", () => {
  const bad = Object.entries(sources).flatMap(([f, s]) =>
    [...s.matchAll(/text-\[(\d*\.?\d+)rem\]|font-size:\s*(\d*\.?\d+)rem/g)]
      .filter((m) => parseFloat(m[1] ?? m[2]) < 0.75)
      .map((m) => `${f}: ${m[0]}`),
  );
  expect(bad).toEqual([]);
});

it("actually reads the TV sources", () => {
  expect(Object.keys(sources).length).toBeGreaterThan(20);
});
