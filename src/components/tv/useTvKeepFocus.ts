import { useEffect } from "react";
import { focusElement } from "../../lib/spatialNav";

const ITEM = "[data-tv-focusable]";
const ROW = "[data-tv-index]";
const LIST = "[data-tv-keep-list]";
const FALLBACK = "data-tv-keep-fallback";

interface Lost {
  el: HTMLElement;
  list: HTMLElement | null;
  row: number;
  item: number;
  fallback: string | null;
}

/** The entry at `index` of `all`, or the last one when the list got shorter. */
const nth = <T>(all: ArrayLike<T>, index: number): T | undefined =>
  index < 0 ? undefined : all[Math.min(index, all.length - 1)];

/**
 * Keeps the remote's focus inside `root` when the element it is on is taken
 * away by new content (Now Playing on a track change: lyrics lines, a tab's
 * rows, buttons a video does not have). Focus goes to what now stands in the
 * same place of its `data-tv-keep-list` container (same row, else same item,
 * else the last one), else to the element matching the selector of the
 * nearest `data-tv-keep-fallback`, else to the screen's `data-tv-autofocus`
 * one. Never moves focus that something else already placed.
 */
export function useTvKeepFocus(root: HTMLElement | null, active: boolean) {
  useEffect(() => {
    if (!root || !active) return;
    let lost: Lost | null = null;
    const onFocusIn = (e: FocusEvent) => {
      if (!(e.target instanceof HTMLElement)) return;
      const el = e.target;
      const list = el.closest<HTMLElement>(LIST);
      const row = el.closest(ROW);
      lost = {
        el,
        list,
        row:
          list && row
            ? Array.from(list.querySelectorAll(ROW)).indexOf(row)
            : -1,
        item: list ? Array.from(list.querySelectorAll(ITEM)).indexOf(el) : -1,
        fallback: el.closest(`[${FALLBACK}]`)?.getAttribute(FALLBACK) ?? null,
      };
    };
    const observer = new MutationObserver(() => {
      if (!lost || lost.el.isConnected) return;
      const current = document.activeElement;
      if (current && current !== document.body && current.isConnected) return;
      const { list, row, item, fallback } = lost;
      let next: HTMLElement | null | undefined;
      if (list?.isConnected) {
        next =
          nth(list.querySelectorAll(ROW), row)?.querySelector<HTMLElement>(
            ITEM,
          ) ?? nth(list.querySelectorAll<HTMLElement>(ITEM), item);
      }
      next ??=
        (fallback && root.querySelector<HTMLElement>(fallback)) ||
        root.querySelector<HTMLElement>("[data-tv-autofocus]");
      if (next) focusElement(next);
    });
    root.addEventListener("focusin", onFocusIn);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      root.removeEventListener("focusin", onFocusIn);
      observer.disconnect();
    };
  }, [root, active]);
}
