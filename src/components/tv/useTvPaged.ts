import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { safeErrorMessage } from "../../lib/errorUtils";

export type TvPage<T> = {
  items: T[];
  hasMore: boolean;
  cursor?: string | null;
};

type FetchPage<T> = (
  offset: number,
  cursor: string | null,
) => Promise<TvPage<T>>;

type PagedState<T> = {
  items: T[];
  offset: number;
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  moreError: boolean;
};

const FAILURE = "Couldn't load this list";

/** One key's loading run; a new key ends it so its late pages are dropped. */
type Run = { live: boolean; inFlight: Promise<void> | null };

function startState<T>(
  seed: TvPage<T> | null | undefined,
  hasFetcher: boolean,
): PagedState<T> {
  const base: PagedState<T> = {
    items: [],
    offset: 0,
    cursor: null,
    hasMore: false,
    loading: false,
    loadingMore: false,
    error: null,
    moreError: false,
  };
  if (seed === null) return { ...base, loading: true };
  if (seed === undefined) return { ...base, loading: hasFetcher };
  return {
    ...base,
    items: seed.items.slice(),
    offset: seed.items.length,
    cursor: seed.cursor ?? null,
    hasMore: hasFetcher && seed.hasMore,
  };
}

// An empty page that claims more would make loadAll spin forever.
const hasMorePages = <T>(page: TvPage<T>) =>
  page.hasMore && page.items.length > 0;

/** A list that loads page by page and keeps the rows it has when a later
 *  page fails. Without a `seed` page 0 is fetched; a `null` seed waits; a
 *  seed object is the first page (or the whole list when `fetchPage` is
 *  null). A new `key` or seed object starts over, so keep the seed stable. */
export function useTvPaged<T>(
  fetchPage: FetchPage<T> | null,
  key: string,
  seed?: TvPage<T> | null,
) {
  const hasFetcher = fetchPage !== null;
  const [state, setState] = useState(() => startState(seed, hasFetcher));
  const [inputs, setInputs] = useState({ key, seed, hasFetcher });
  if (
    inputs.key !== key ||
    inputs.seed !== seed ||
    inputs.hasFetcher !== hasFetcher
  ) {
    setInputs({ key, seed, hasFetcher });
    setState(startState(seed, hasFetcher));
  }

  const stateRef = useRef(state);
  const fetchRef = useRef(fetchPage);
  const runRef = useRef<Run>({ live: true, inFlight: null });
  useLayoutEffect(() => {
    stateRef.current = state;
    fetchRef.current = fetchPage;
  });

  const commit = useCallback((next: PagedState<T>) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const track = useCallback((run: Run, work: Promise<void>) => {
    const p = work.finally(() => {
      if (run.inFlight === p) run.inFlight = null;
    });
    run.inFlight = p;
    return p;
  }, []);

  const fetchFirst = useCallback(() => {
    const fp = fetchRef.current;
    const run = runRef.current;
    if (!fp) return;
    void track(
      run,
      (async () => {
        try {
          const page = await fp(0, null);
          if (!run.live) return;
          commit({
            ...startState<T>(undefined, false),
            items: page.items.slice(),
            offset: page.items.length,
            cursor: page.cursor ?? null,
            hasMore: hasMorePages(page),
          });
        } catch (e) {
          if (!run.live) return;
          commit({
            ...stateRef.current,
            loading: false,
            error: safeErrorMessage(e, FAILURE),
          });
        }
      })(),
    );
  }, [commit, track]);

  useLayoutEffect(() => {
    const run: Run = { live: true, inFlight: null };
    runRef.current = run;
    if (seed === undefined) fetchFirst();
    return () => {
      run.live = false;
    };
  }, [key, seed, hasFetcher, fetchFirst]);

  const loadMore = useCallback(async () => {
    const s = stateRef.current;
    const fp = fetchRef.current;
    const run = runRef.current;
    if (run.inFlight || !fp) return;
    if (s.loading || s.error || !s.hasMore || s.moreError) return;
    commit({ ...s, loadingMore: true });
    await track(
      run,
      (async () => {
        try {
          const page = await fp(s.offset, s.cursor);
          if (!run.live) return;
          const cur = stateRef.current;
          commit({
            ...cur,
            items: cur.items.concat(page.items),
            offset: cur.offset + page.items.length,
            cursor: page.cursor ?? null,
            hasMore: hasMorePages(page),
            loadingMore: false,
          });
        } catch {
          if (!run.live) return;
          commit({ ...stateRef.current, loadingMore: false, moreError: true });
        }
      })(),
    );
  }, [commit, track]);

  const loadAll = useCallback(async () => {
    const run = runRef.current;
    while (run.live) {
      if (run.inFlight) {
        await run.inFlight;
        continue;
      }
      const s = stateRef.current;
      if (s.loading || s.error || !s.hasMore || s.moreError) return;
      await loadMore();
    }
  }, [loadMore]);

  const retry = useCallback(() => {
    const s = stateRef.current;
    if (s.error) {
      if (runRef.current.inFlight) return;
      commit({ ...s, loading: true, error: null });
      fetchFirst();
    } else if (s.moreError) {
      commit({ ...s, moreError: false });
      void loadMore();
    }
  }, [commit, fetchFirst, loadMore]);

  const remove = useCallback(
    (item: T) => {
      const s = stateRef.current;
      const i = s.items.indexOf(item);
      if (i < 0) return -1;
      const items = s.items.slice();
      items.splice(i, 1);
      commit({ ...s, items, offset: s.offset - 1 });
      return i;
    },
    [commit],
  );

  const insert = useCallback(
    (index: number, item: T) => {
      const s = stateRef.current;
      const items = s.items.slice();
      items.splice(index, 0, item);
      commit({ ...s, items, offset: s.offset + 1 });
    },
    [commit],
  );

  return { ...state, loadMore, loadAll, retry, remove, insert };
}
