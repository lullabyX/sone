import { useState, useEffect, useRef, useCallback } from "react";
import {
  getHomePage,
  refreshHomePage,
  getHomePageMore,
  invalidateCache,
} from "../api/tidal";
import type { HomeSection, HomeTab } from "../types";
import { safeErrorMessage } from "../lib/errorUtils";

// Per-tab in-memory cache to prevent skeleton flash on navigation and to keep
// each tab's sections/cursor/pagination state independent across switches.
// Desktop and TV each keep their own, so one never changes what the other shows.
type TabCacheEntry = {
  sections: HomeSection[];
  cursor: string | null;
  hasPaginated: boolean;
};
type ScopeState = {
  tabCache: Map<string, TabCacheEntry>;
  cachedTabs: HomeTab[];
  lastActiveType: string | null;
};
type Scope = "desktop" | "tv";

const newScope = (): ScopeState => ({
  tabCache: new Map(),
  cachedTabs: [],
  lastActiveType: null,
});
const scopes: Record<Scope, ScopeState> = {
  desktop: newScope(),
  tv: newScope(),
};

export function __resetHomeFeedForTests(): void {
  scopes.desktop = newScope();
  scopes.tv = newScope();
}

export const slugOf = (feedType: string) => feedType.toLowerCase();

const REVALIDATE_MIN_INTERVAL_MS = 5 * 60 * 1000;

export function useHomeFeed(
  scope: Scope,
  opts?: { allowReplace?: () => boolean },
) {
  const allowReplaceRef = useRef(opts?.allowReplace);
  useEffect(() => {
    allowReplaceRef.current = opts?.allowReplace;
  });

  const [tabs, setTabs] = useState<HomeTab[]>(scopes[scope].cachedTabs);
  const [activeType, setActiveType] = useState<string>(
    scopes[scope].lastActiveType ??
      scopes[scope].cachedTabs[0]?.tabType ??
      "STATIC",
  );
  const activeEntry = scopes[scope].tabCache.get(slugOf(activeType));
  const sections = activeEntry?.sections ?? [];
  const cursor = activeEntry?.cursor ?? null;
  const [loading, setLoading] = useState<boolean>(!activeEntry);
  const [error, setError] = useState<string | null>(null);
  const [, forceRender] = useState(0); // bump to re-render after async cache writes
  const activeTypeRef = useRef(activeType);
  useEffect(() => {
    activeTypeRef.current = activeType;
    scopes[scope].lastActiveType = activeType;
  }, [activeType, scope]);

  const lastLoadedAtRef = useRef<number>(Date.now());
  const revalidatingRef = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const failedCursorRef = useRef<string | null>(null);

  const loadTab = useCallback(
    async (feedType: string, isRevalidation: boolean) => {
      const slug = slugOf(feedType);
      if (isRevalidation) {
        if (revalidatingRef.current) return;
        revalidatingRef.current = true;
        // Drop the frontend in-memory cache so getHomePage actually re-consults
        // the Rust backend — otherwise the 2h TTL on the cached() wrapper short-
        // circuits the revalidation entirely.
        invalidateCache("home");
      }

      try {
        const result = await getHomePage(feedType);
        const { tabCache } = scopes[scope];
        const prev = tabCache.get(slug);
        if (
          !prev ||
          (!prev.hasPaginated && allowReplaceRef.current?.() !== false)
        ) {
          tabCache.set(slug, {
            sections: result.home.sections,
            cursor: result.home.cursor ?? null,
            hasPaginated: false,
          });
        }
        if (result.home.tabs.length) {
          scopes[scope].cachedTabs = result.home.tabs;
          setTabs(result.home.tabs);
        }
        forceRender((n) => n + 1);

        if (result.isStale) {
          refreshHomePage(feedType)
            .then((fresh) => {
              const cache = scopes[scope].tabCache;
              const cur = cache.get(slug);
              if (
                cur &&
                !cur.hasPaginated &&
                allowReplaceRef.current?.() !== false
              ) {
                cache.set(slug, {
                  sections: fresh.sections,
                  cursor: fresh.cursor ?? null,
                  hasPaginated: false,
                });
                forceRender((n) => n + 1);
              }
            })
            .catch((e) => console.error("home refresh failed", e));
        }

        lastLoadedAtRef.current = Date.now();
        if (slugOf(activeTypeRef.current) === slug) setError(null);
      } catch (e) {
        console.error("Failed to load home tab", feedType, e);
        // Only the tab on screen gets to set the error — background prefetches
        // of the other tabs must not paint over a feed that loaded fine.
        if (slugOf(activeTypeRef.current) === slug) {
          setError(safeErrorMessage(e, "Failed to load home"));
        }
      } finally {
        if (isRevalidation) revalidatingRef.current = false;
        if (slugOf(activeTypeRef.current) === slug) setLoading(false);
      }
    },
    [scope],
  );

  const hasLoadedRef = useRef(false);
  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;
    const first = scopes[scope].cachedTabs[0]?.tabType ?? "STATIC";
    loadTab(first, false).then(() => {
      const st = scopes[scope];
      for (const t of st.cachedTabs) {
        const s = slugOf(t.tabType);
        if (s !== slugOf(first) && !st.tabCache.has(s)) {
          loadTab(t.tabType, false);
        }
      }
    });
  }, [loadTab, scope]);

  const selectTab = useCallback(
    (feedType: string) => {
      setActiveType(feedType);
      setError(null);
      if (!scopes[scope].tabCache.has(slugOf(feedType))) {
        setLoading(true);
        loadTab(feedType, false);
      } else {
        setLoading(false);
      }
    },
    [loadTab, scope],
  );

  const retry = useCallback(() => {
    setError(null);
    setLoading(true);
    loadTab(activeTypeRef.current, false);
  }, [loadTab]);

  const revalidate = useCallback(
    (force?: boolean) => {
      if (document.visibilityState !== "visible") return;
      const active = activeTypeRef.current;
      if (scopes[scope].tabCache.get(slugOf(active))?.hasPaginated) return;
      if (revalidatingRef.current) return;
      if (
        !force &&
        Date.now() - lastLoadedAtRef.current < REVALIDATE_MIN_INTERVAL_MS
      )
        return;
      loadTab(active, true);
    },
    [loadTab, scope],
  );

  // Revalidate on window focus / tab visibility — covers the case where the
  // app stays open past the cache TTL and nothing else triggers a re-fetch.
  useEffect(() => {
    const onWake = () => revalidate();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [revalidate]);

  const loadMore = useCallback(() => {
    if (
      !cursor ||
      loadingMore ||
      loadingMoreRef.current ||
      cursor === failedCursorRef.current
    )
      return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    getHomePageMore(cursor, activeType)
      .then((result) => {
        failedCursorRef.current = null;
        const { tabCache } = scopes[scope];
        const slug = slugOf(activeType);
        const prev = tabCache.get(slug);
        if (prev) {
          tabCache.set(slug, {
            sections: [...prev.sections, ...result.sections],
            cursor: result.cursor ?? null,
            hasPaginated: true,
          });
          forceRender((n) => n + 1);
        }
      })
      .catch((err) => {
        // The sentinel is still on screen, so without remembering which
        // cursor failed the observer would re-fire the same doomed
        // request as soon as loadingMore flips back to false.
        failedCursorRef.current = cursor;
        console.error("Failed to load more home sections:", err);
      })
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [cursor, loadingMore, activeType, scope]);

  return {
    tabs,
    activeType,
    selectTab,
    sections,
    cursor,
    loading,
    loadingMore,
    error,
    retry,
    loadMore,
    revalidate,
  };
}
