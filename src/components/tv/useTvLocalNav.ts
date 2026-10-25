import { useEffect, type RefObject } from "react";
import { focusFirstIn, moveFocus, type Direction } from "../../lib/spatialNav";

const ARROWS: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** The remote on a full-screen TV surface without TvApp's key handler:
 *  arrows move between the buttons, Enter presses them (a held OK does not). */
export function useTvLocalNav(
  rootRef: RefObject<HTMLElement | null>,
  refocusKey: unknown,
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && e.repeat) {
        e.preventDefault();
        return;
      }
      const dir = ARROWS[e.key];
      const root = rootRef.current;
      if (!dir || !root) return;
      e.preventDefault();
      if (!root.contains(document.activeElement)) focusFirstIn(root);
      else moveFocus(root, dir);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rootRef]);

  useEffect(() => {
    const root = rootRef.current;
    if (root && !root.contains(document.activeElement)) focusFirstIn(root);
  }, [rootRef, refocusKey]);
}
