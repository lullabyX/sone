import { useCallback, useEffect, useState } from "react";
import { safeErrorMessage } from "../../lib/errorUtils";

/** Load a screen's data once (and again on `retry`). `load` must be stable,
 *  i.e. wrapped in useCallback by the caller. */
export function useTvLoader<T>(load: () => Promise<T>, failure: string) {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({
    data: null,
    error: null,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (data) => {
        if (!cancelled) setState({ data, error: null });
      },
      (e) => {
        if (!cancelled)
          setState({ data: null, error: safeErrorMessage(e, failure) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [load, failure, attempt]);

  const retry = useCallback(() => {
    setState({ data: null, error: null });
    setAttempt((a) => a + 1);
  }, []);

  /** Load again in the background, keeping what is shown (and focused)
   *  until the new data arrives. */
  const refresh = useCallback(() => {
    load().then(
      (data) => setState({ data, error: null }),
      () => {},
    );
  }, [load]);

  /** Change the loaded data in place (after removing a row, say). */
  const update = useCallback((change: (data: T) => T) => {
    setState((s) => (s.data === null ? s : { ...s, data: change(s.data) }));
  }, []);

  return { ...state, retry, update, refresh };
}
