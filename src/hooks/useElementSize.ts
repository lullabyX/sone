import { useCallback, useEffect, useMemo, useState } from "react";

export interface ElementSize {
  w: number;
  h: number;
  /** Current devicePixelRatio; changes when the window moves to a differently scaled monitor. */
  dpr: number;
}

/** Observed CSS size of an element, rounded to whole pixels; 0x0 until measured. */
export function useElementSize<T extends Element>(): [
  (el: T | null) => void,
  ElementSize,
] {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const ref = useCallback((node: T | null) => setEl(node), []);

  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[entries.length - 1].contentRect;
      const w = Math.round(width);
      const h = Math.round(height);
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [dpr]);

  const result = useMemo(() => ({ ...size, dpr }), [size, dpr]);
  return [ref, result];
}
