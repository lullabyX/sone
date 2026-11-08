import { useRef } from "react";
import { expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { range, setupTvTest } from "./tvTestUtils";
import { useTvGrowOnFocus } from "./useTvGrowOnFocus";

setupTvTest();

function L({
  count,
  onNearEnd,
}: {
  count: number;
  onNearEnd: (() => void) | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useTvGrowOnFocus(ref, count, onNearEnd, 3);
  return (
    <>
      <div ref={ref}>
        {range(count).map((i) => (
          <button key={i} data-tv-index={i}>{`b${i}`}</button>
        ))}
      </div>
      <button data-tv-index={99}>outside</button>
    </>
  );
}

it("calls onNearEnd once per count when a late item takes focus", () => {
  const onNearEnd = vi.fn();
  const { rerender } = render(<L count={10} onNearEnd={onNearEnd} />);
  act(() => screen.getByText("b5").focus());
  expect(onNearEnd).not.toHaveBeenCalled();
  act(() => screen.getByText("b7").focus());
  act(() => screen.getByText("b8").focus());
  expect(onNearEnd).toHaveBeenCalledTimes(1);
  rerender(<L count={20} onNearEnd={onNearEnd} />);
  act(() => screen.getByText("b18").focus());
  expect(onNearEnd).toHaveBeenCalledTimes(2);
});

it("ignores focus outside the list and does nothing when disabled", () => {
  const onNearEnd = vi.fn();
  const { rerender } = render(<L count={10} onNearEnd={onNearEnd} />);
  act(() => screen.getByText("outside").focus());
  expect(onNearEnd).not.toHaveBeenCalled();
  rerender(<L count={10} onNearEnd={null} />);
  act(() => screen.getByText("b9").focus());
  expect(onNearEnd).not.toHaveBeenCalled();
});
