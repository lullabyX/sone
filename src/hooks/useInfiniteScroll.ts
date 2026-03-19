import { useRef, useEffect, useCallback, useState } from "react";

interface UseInfiniteScrollOptions<T> {
  fetchPage: (
    offset: number,
    limit: number,
  ) => Promise<{ items: T[]; totalNumberOfItems: number }>;
  pageSize?: number;
  enabled?: boolean;
  resetKey?: string;
}

interface UseInfiniteScrollResult<T> {
  items: T[];
  isInitialLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  reset: () => void;
}

export function useInfiniteScroll<T>({
  fetchPage,
  pageSize = 20,
  enabled = true,
  resetKey,
}: UseInfiniteScrollOptions<T>): UseInfiniteScrollResult<T> {
  const [items, setItems] = useState<T[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [isInitialLoading, setIsInitialLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  const offsetRef = useRef(0);
  const hasMoreRef = useRef(true);
  const enabledPrevRef = useRef(false);
  const prevResetKeyRef = useRef(resetKey);

  const loadPage = useCallback(
    async (currentOffset: number, isInitial: boolean) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      if (isInitial) setIsInitialLoading(true);
      else setIsLoadingMore(true);

      try {
        const result = await fetchPage(currentOffset, pageSize);
        setItems((prev) =>
          currentOffset === 0 ? result.items : [...prev, ...result.items],
        );
        const newOffset = currentOffset + result.items.length;
        offsetRef.current = newOffset;
        const more =
          newOffset < result.totalNumberOfItems && result.items.length > 0;
        hasMoreRef.current = more;
        setHasMore(more);
      } catch (err) {
        console.error("Failed to load page:", err);
        hasMoreRef.current = false;
        setHasMore(false);
      } finally {
        if (isInitial) setIsInitialLoading(false);
        else setIsLoadingMore(false);
        loadingRef.current = false;
      }
    },
    [fetchPage, pageSize],
  );

  // Reset when resetKey changes (e.g. sort order changed)
  useEffect(() => {
    if (!enabled) return;
    if (resetKey !== undefined && resetKey !== prevResetKeyRef.current) {
      prevResetKeyRef.current = resetKey;
      setItems([]);
      offsetRef.current = 0;
      hasMoreRef.current = true;
      setHasMore(true);
      loadingRef.current = false;
      loadPage(0, true);
    }
  }, [resetKey, enabled, loadPage]);

  // Initial load when enabled changes to true
  useEffect(() => {
    if (!enabled) {
      enabledPrevRef.current = false;
      return;
    }
    // Only trigger load when enabled transitions to true
    if (enabledPrevRef.current) return;
    enabledPrevRef.current = true;

    setItems([]);
    offsetRef.current = 0;
    hasMoreRef.current = true;
    setHasMore(true);
    loadingRef.current = false;
    loadPage(0, true);
  }, [enabled, loadPage]);

  // IntersectionObserver for sentinel — no state deps, uses refs
  useEffect(() => {
    if (!enabled) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0]?.isIntersecting &&
          !loadingRef.current &&
          hasMoreRef.current
        ) {
          loadPage(offsetRef.current, false);
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [enabled, items, hasMore, loadPage]);

  const reset = useCallback(() => {
    setItems([]);
    offsetRef.current = 0;
    hasMoreRef.current = true;
    setHasMore(true);
    loadingRef.current = false;
    loadPage(0, true);
  }, [loadPage]);

  return {
    items,
    isInitialLoading,
    isLoadingMore,
    hasMore,
    sentinelRef,
    reset,
  };
}
