import { RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { currentViewAtom } from "../atoms/navigation";
import { getOffset, saveOffset, scrollKey } from "../lib/scrollMemory";

/** Growth restarts the quiet period, so a slow first page keeps the loop alive;
 *  the ceiling stops a feed that grows forever from chasing forever. */
const QUIET_MS = 3000;
const MAX_RESTORE_MS = 15000;
/** A scrollbar-thumb drag emits `scroll` with no `wheel`, so pointerdown is
 *  what lets a drag win against an in-flight restore. Covers touch and pen too. */
const ABORT_EVENTS = ["wheel", "pointerdown", "keydown"] as const;

/** Page content may sit inside its own `overflow-y-auto` root, so the offset is
 *  applied to the container and to any nested scroll candidate. Candidates that
 *  turn out not to scroll are skipped when the offset is applied. */
function scrollTargets(container: HTMLElement): HTMLElement[] {
  const targets = [container];
  let el = container.firstElementChild as HTMLElement | null;
  for (let depth = 0; el && depth < 3; depth++) {
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") targets.push(el);
    el = el.firstElementChild as HTMLElement | null;
  }
  return targets;
}

export function useScrollRestoration(
  containerRef: RefObject<HTMLElement | null>,
): void {
  const currentView = useAtomValue(currentViewAtom);
  const key = scrollKey(currentView);
  const keyRef = useRef(key);
  const pausedRef = useRef(false);
  const targetsRef = useRef<HTMLElement[]>([]);

  useLayoutEffect(() => {
    keyRef.current = key;
    const container = containerRef.current;
    if (!container) return;

    let targets = scrollTargets(container);
    targetsRef.current = targets;
    const target = key === null ? undefined : getOffset(key);

    if (target === undefined || target <= 0) {
      for (const el of targets) el.scrollTop = 0;
      return;
    }

    pausedRef.current = true;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      pausedRef.current = false;
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(ceiling);
      for (const type of ABORT_EVENTS) window.removeEventListener(type, finish);
    };

    const apply = () => {
      let reached = false;
      for (const el of targets) {
        const max = el.scrollHeight - el.clientHeight;
        if (max <= 0) continue;
        el.scrollTop = Math.min(target, max);
        if (max >= target) reached = true;
      }
      if (reached) finish();
    };

    const observe = () => {
      for (const el of targets) {
        observer.observe(el);
        if (el.firstElementChild) observer.observe(el.firstElementChild);
      }
    };

    // Async page data and late-loading images keep growing the content after
    // mount; each growth is another chance to reach the saved offset.
    const observer = new ResizeObserver(() => {
      if (done) return;
      // A page swapping its loading skeleton for its real root detaches the
      // node being watched, so the set is re-derived on every callback to chain
      // into the new subtree. Re-observing an observed element is a no-op.
      targets = scrollTargets(container);
      targetsRef.current = targets;
      observe();
      clearTimeout(quiet);
      quiet = setTimeout(finish, QUIET_MS);
      apply();
    });

    const ceiling = setTimeout(finish, MAX_RESTORE_MS);
    let quiet = setTimeout(finish, QUIET_MS);

    observe();
    for (const type of ABORT_EVENTS) {
      window.addEventListener(type, finish, { passive: true });
    }

    apply();
    return finish;
  }, [key, containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame = 0;
    // Capture phase: `scroll` does not bubble, so this is what lets one
    // listener see whichever descendant is the real scroller.
    const onScroll = (event: Event) => {
      if (pausedRef.current || frame) return;
      const el = event.target as HTMLElement | null;
      // In-page scrollers (modal panes, menus) also reach this listener, and
      // their offsets are not the page's. Only elements the restore writes to
      // may be recorded, so record and restore share one target set.
      if (!el || !targetsRef.current.includes(el)) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const current = keyRef.current;
        if (current && !pausedRef.current) saveOffset(current, el.scrollTop);
      });
    };

    container.addEventListener("scroll", onScroll, true);
    return () => {
      container.removeEventListener("scroll", onScroll, true);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [containerRef]);
}
