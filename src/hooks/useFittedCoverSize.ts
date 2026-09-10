import { useEffect, useRef, useState, type RefObject } from "react";
import { fitCoverSize } from "../lib/coverFit";

/**
 * Sizes the drawer cover to fit its column in both axes: the observer reports
 * the column's content box, the title block measures itself, and the cover
 * takes the largest square left over.
 */
export function useFittedCoverSize(): {
  columnRef: RefObject<HTMLDivElement | null>;
  textRef: RefObject<HTMLDivElement | null>;
  size: number | null;
} {
  const columnRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<number | null>(null);

  useEffect(() => {
    const column = columnRef.current;
    if (!column || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      // Layout hides the drawer behind the video overlay with display:none —
      // hold the last good size rather than collapsing the cover to nothing.
      if (!box || box.width === 0 || box.height === 0) return;
      setSize(
        fitCoverSize({
          width: box.width,
          height: box.height,
          textHeight: textRef.current?.offsetHeight ?? 0,
        }),
      );
    });
    observer.observe(column);
    return () => observer.disconnect();
  }, []);

  return { columnRef, textRef, size };
}
