import { useCallback, useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { currentViewAtom } from "../atoms/navigation";
import type { AppView } from "../types";

function stateTab(): string | undefined {
  const tab = (window.history.state as { tab?: unknown } | null)?.tab;
  return typeof tab === "string" ? tab : undefined;
}

/**
 * Keeps a page-level tab selection in sync with `currentViewAtom` and
 * `window.history.state`, so browser back/forward restores the tab the user
 * was on when they navigated away.
 *
 * Uses `replaceState` (not `pushState`) — tab toggling does not bloat the
 * back stack.
 */
export function useViewTab<T extends string>(
  initial: T,
): [T, (tab: T) => void] {
  const setCurrentView = useSetAtom(currentViewAtom);
  const [tab, setTabState] = useState<T>(() => (stateTab() as T) ?? initial);

  const writeTab = useCallback(
    (next: T) => {
      const prev = (window.history.state ?? {}) as AppView &
        Record<string, unknown>;
      const merged = { ...prev, tab: next };
      window.history.replaceState(merged, "");
      setCurrentView(merged as AppView);
    },
    [setCurrentView],
  );

  const setTab = useCallback(
    (next: T) => {
      setTabState(next);
      writeTab(next);
    },
    [writeTab],
  );

  const navId = useAtomValue(currentViewAtom).__navId;

  // The tab an entry opens on needs to be in the entry's state too, or its
  // scroll offset is filed under the empty tab segment and lost as soon as the
  // first switch writes a real one. Keyed on the entry rather than on mount:
  // a new entry can appear for a page that never remounts.
  useEffect(() => {
    if (stateTab() === undefined) writeTab(tab);
  }, [navId, tab, writeTab]);

  return [tab, setTab];
}
