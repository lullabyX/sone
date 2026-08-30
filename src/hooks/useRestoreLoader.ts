import { useLayoutEffect } from "react";

interface RestoreLoader {
  loadMore: () => void;
  hasMore: boolean;
}

let current: RestoreLoader | null = null;

export function getRestoreLoader(): RestoreLoader | null {
  return current;
}

/**
 * Lets a paginated page offer its next-page fetch to an in-flight scroll
 * restore. Without it the restore could only reach a deep offset by parking the
 * viewport on the page's own IntersectionObserver sentinel, which paginated in
 * visible steps; asking the data layer directly keeps the list still until the
 * offset is reachable.
 *
 * Registered in a layout effect so it is in place before `Layout`'s restore
 * effect runs — child layout effects run before the parent's.
 */
export function useRestoreLoader(
  loadMore: (() => void) | undefined,
  hasMore: boolean,
): void {
  useLayoutEffect(() => {
    if (!loadMore) return;
    const registration: RestoreLoader = { loadMore, hasMore };
    current = registration;
    return () => {
      if (current === registration) current = null;
    };
  }, [loadMore, hasMore]);
}
