import { useCallback, useState } from "react";
import { useSetAtom } from "jotai";
import { currentViewAtom } from "../atoms/navigation";
import type { AppView } from "../types";

/**
 * Keeps a page-level tab selection in sync with `currentViewAtom` and
 * `window.history.state`, so browser back/forward restores the tab the user
 * was on when they navigated away.
 *
 * Uses `replaceState` (not `pushState`) — tab toggling does not bloat the
 * back stack.
 */
export function useViewTab<T extends string>(initial: T): [T, (tab: T) => void] {
  const setCurrentView = useSetAtom(currentViewAtom);
  const [tab, setTabState] = useState<T>(initial);

  const setTab = useCallback(
    (next: T) => {
      setTabState(next);
      const prev = (window.history.state ?? {}) as AppView & Record<string, unknown>;
      const merged = { ...prev, tab: next };
      window.history.replaceState(merged, "");
      setCurrentView(merged as AppView);
    },
    [setCurrentView],
  );

  return [tab, setTab];
}
