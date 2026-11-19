import { useCallback, useState } from "react";

/** How much of a long list to render: the first `initial` items, then one
 *  more `step` each time `grow()` is called. */
export function useTvProgressive(
  total: number,
  opts: { initial?: number; step?: number } = {},
): { shown: number; grow: () => void } {
  const step = opts.step ?? 40;
  const [count, setCount] = useState(opts.initial ?? 40);
  const grow = useCallback(() => setCount((c) => c + step), [step]);
  return { shown: Math.min(count, total), grow };
}
