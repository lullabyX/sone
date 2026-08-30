import { RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { currentViewAtom } from "../atoms/navigation";
import { getOffset, saveOffset, scrollKey } from "../lib/scrollMemory";
import { getRestoreLoader } from "./useRestoreLoader";

/** Growth restarts the quiet period, so a slow first page keeps the loop alive;
 *  the ceiling stops a feed that grows forever from chasing forever. */
const QUIET_MS = 3000;
const MAX_RESTORE_MS = 15000;
/** A scrollbar-thumb drag emits `scroll` with no `wheel`, so pointerdown is
 *  what lets a drag win against an in-flight restore. Covers touch and pen too. */
const ABORT_EVENTS = ["wheel", "pointerdown", "keydown"] as const;
/** Animating the whole distance reads as a blur on a long list, so only the
 *  final approach is animated: the jump lands this far above the offset and the
 *  rest is a glide, which looks the same from row 40 or row 340. */
const SMOOTH_RUNWAY = 1.5;
/** Recording stays paused until the glide settles, so its intermediate
 *  positions are not written over the offset being restored. */
const SETTLE_ANIMATION_MS = 1200;

function prefersReducedMotion(): boolean {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false
  );
}

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

    const resumeRecording = () => {
      if (!animating) {
        pausedRef.current = false;
        return;
      }
      const el = targets[0];
      const timer = setTimeout(() => {
        pausedRef.current = false;
      }, SETTLE_ANIMATION_MS);
      el.addEventListener(
        "scrollend",
        () => {
          clearTimeout(timer);
          pausedRef.current = false;
        },
        { once: true },
      );
    };

    const finish = () => {
      if (done) return;
      done = true;
      resumeRecording();
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(ceiling);
      for (const type of ABORT_EVENTS) window.removeEventListener(type, abort);
    };

    /** The list stays where it is until the offset is reachable, so the viewport
     *  moves once instead of stepping down as each page arrives. */
    let animating = false;
    const land = (offset: number) => {
      for (const el of targets) {
        const max = el.scrollHeight - el.clientHeight;
        if (max <= 0) continue;
        const top = Math.min(offset, max);
        const glide =
          !prefersReducedMotion() && typeof el.scrollTo === "function";
        if (!glide) {
          el.scrollTop = top;
          continue;
        }
        el.scrollTop = Math.max(0, top - el.clientHeight * SMOOTH_RUNWAY);
        el.scrollTo({ top, behavior: "smooth" });
        animating = true;
      }
    };

    /** Out of content before the offset is reachable: land as deep as the page
     *  goes, in the same single movement. */
    const settle = () => {
      if (done) return;
      land(target);
      finish();
    };

    let requested = false;
    let seenHeight = 0;
    const requestMore = () => {
      if (requested) return;
      const loader = getRestoreLoader();
      if (!loader?.hasMore) return;
      requested = true;
      loader.loadMore();
    };

    const apply = () => {
      seenHeight = Math.max(
        seenHeight,
        ...targets.map((el) => el.scrollHeight),
      );
      const reachable = targets.some(
        (el) => el.scrollHeight - el.clientHeight >= target,
      );
      if (reachable) {
        land(target);
        finish();
        return;
      }
      requestMore();
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
      // Only real growth clears the way for another request — a ResizeObserver
      // can fire for reasons that add no rows, and each spurious callback would
      // otherwise cost a page fetch.
      const height = Math.max(...targets.map((el) => el.scrollHeight));
      if (height > seenHeight) {
        seenHeight = height;
        requested = false;
      }
      clearTimeout(quiet);
      quiet = setTimeout(settle, QUIET_MS);
      apply();
    });

    const ceiling = setTimeout(settle, MAX_RESTORE_MS);
    let quiet = setTimeout(settle, QUIET_MS);

    const abort = () => {
      animating = false;
      finish();
    };

    observe();
    for (const type of ABORT_EVENTS) {
      window.addEventListener(type, abort, { passive: true });
    }

    apply();
    return abort;
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
