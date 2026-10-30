import { expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { setupTvTest } from "./tvTestUtils";
import { useTvProgressive } from "./useTvProgressive";

setupTvTest();

it("shows a window that grows by a step and never exceeds the total", () => {
  const { result, rerender } = renderHook(({ n }) => useTvProgressive(n), {
    initialProps: { n: 100 },
  });
  expect(result.current.shown).toBe(40);
  act(() => result.current.grow());
  expect(result.current.shown).toBe(80);
  rerender({ n: 50 });
  expect(result.current.shown).toBe(50);
});
