import { useLayoutEffect, useRef, type RefObject } from "react";

/** Calls `onNearEnd` when focus reaches one of the last `threshold` items
 *  (`data-tv-index`) inside `ref`, at most once per `count`; `null` turns
 *  it off. The list root must exist at mount. */
export function useTvGrowOnFocus(
  ref: RefObject<HTMLElement | null>,
  count: number,
  onNearEnd: (() => void) | null,
  threshold = 20,
): void {
  const countRef = useRef(count);
  const onNearEndRef = useRef(onNearEnd);
  const firedForRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    countRef.current = count;
    onNearEndRef.current = onNearEnd;
  });

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onFocusIn = (e: FocusEvent) => {
      const cb = onNearEndRef.current;
      if (!cb || !(e.target instanceof Element)) return;
      const item = e.target.closest("[data-tv-index]");
      if (!item || !root.contains(item)) return;
      const n = countRef.current;
      if (Number(item.getAttribute("data-tv-index")) < n - threshold) return;
      if (n === firedForRef.current) return;
      firedForRef.current = n;
      cb();
    };
    root.addEventListener("focusin", onFocusIn);
    return () => root.removeEventListener("focusin", onFocusIn);
  }, [ref, threshold]);
}
