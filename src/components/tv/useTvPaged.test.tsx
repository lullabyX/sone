import { expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { deferred, setupTvTest } from "./tvTestUtils";
import { useTvPaged, type TvPage } from "./useTvPaged";

setupTvTest();

type FetchPage<T> = (
  offset: number,
  cursor: string | null,
) => Promise<TvPage<T>>;

it("shows the first page, keeps rows when a later page fails, retries", async () => {
  const fetchPage = vi
    .fn<FetchPage<number>>()
    .mockResolvedValueOnce({ items: [1, 2], hasMore: true })
    .mockRejectedValueOnce(new Error("x"))
    .mockResolvedValueOnce({ items: [3], hasMore: false });
  const { result } = renderHook(() => useTvPaged(fetchPage, "k"));
  await waitFor(() => expect(result.current.items).toEqual([1, 2]));
  await act(() => result.current.loadMore());
  expect(result.current).toMatchObject({
    items: [1, 2],
    moreError: true,
    error: null,
    hasMore: true,
  });
  act(() => result.current.retry());
  await waitFor(() =>
    expect(result.current).toMatchObject({
      items: [1, 2, 3],
      hasMore: false,
      offset: 3,
      moreError: false,
    }),
  );
  expect(fetchPage).toHaveBeenNthCalledWith(2, 2, null);
});

it("shows an error when the first page fails and fetches it again on retry", async () => {
  const fetchPage = vi
    .fn<FetchPage<number>>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ items: [1], hasMore: false });
  const { result } = renderHook(() => useTvPaged(fetchPage, "k"));
  await waitFor(() =>
    expect(result.current).toMatchObject({ error: "offline", loading: false }),
  );
  act(() => result.current.retry());
  expect(result.current).toMatchObject({ error: null, loading: true });
  await waitFor(() => expect(result.current.items).toEqual([1]));
  expect(fetchPage).toHaveBeenNthCalledWith(2, 0, null);
});

it("asks for one page at a time", async () => {
  const page1 = deferred<TvPage<number>>();
  const fetchPage = vi
    .fn<FetchPage<number>>()
    .mockResolvedValueOnce({ items: [1], hasMore: true })
    .mockReturnValueOnce(page1.promise);
  const { result } = renderHook(() => useTvPaged(fetchPage, "k"));
  await waitFor(() => expect(result.current.items).toEqual([1]));
  act(() => {
    void result.current.loadMore();
    void result.current.loadMore();
  });
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect(result.current.loadingMore).toBe(true);
  await act(async () => page1.resolve({ items: [2], hasMore: false }));
  expect(result.current).toMatchObject({ items: [1, 2], loadingMore: false });
  expect(fetchPage).toHaveBeenCalledTimes(2);
});

it("remove returns the index at call time and shifts the offset; two removals in one batch see each other", async () => {
  const [a, b, c, d, x] = [
    { n: "a" },
    { n: "b" },
    { n: "c" },
    { n: "d" },
    { n: "x" },
  ];
  const fetchPage = vi
    .fn<FetchPage<{ n: string }>>()
    .mockResolvedValueOnce({ items: [a, b, c, d], hasMore: true })
    .mockResolvedValueOnce({ items: [x], hasMore: false });
  const { result, rerender } = renderHook(({ k }) => useTvPaged(fetchPage, k), {
    initialProps: { k: "k" },
  });
  await waitFor(() => expect(result.current.items).toEqual([a, b, c, d]));
  let i1 = -2;
  let i2 = -2;
  act(() => {
    i1 = result.current.remove(b);
    i2 = result.current.remove(c);
  });
  expect([i1, i2]).toEqual([1, 1]);
  expect(result.current.items).toEqual([a, d]);
  expect(result.current.offset).toBe(2);
  expect(result.current.remove({ n: "a" })).toBe(-1);
  act(() => result.current.insert(1, b));
  expect(result.current.items).toEqual([a, b, d]);
  expect(result.current.offset).toBe(3);
  rerender({ k: "k2" });
  expect(result.current).toMatchObject({ items: [], loading: true });
  expect(fetchPage).toHaveBeenLastCalledWith(0, null);
  await waitFor(() => expect(result.current.items).toEqual([x]));
});

it("drops a page that arrives after the key changed", async () => {
  const old = deferred<TvPage<number>>();
  const fetchPage = vi
    .fn<FetchPage<number>>()
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ items: [9], hasMore: false });
  const { result, rerender } = renderHook(({ k }) => useTvPaged(fetchPage, k), {
    initialProps: { k: "k" },
  });
  rerender({ k: "k2" });
  await waitFor(() => expect(result.current.items).toEqual([9]));
  await act(async () => old.resolve({ items: [1], hasMore: true }));
  expect(result.current).toMatchObject({ items: [9], hasMore: false });
});

it("passes the cursor of the previous page", async () => {
  const fetchPage = vi
    .fn<FetchPage<number>>()
    .mockResolvedValueOnce({ items: [1], hasMore: true, cursor: "c" })
    .mockResolvedValueOnce({ items: [2], hasMore: false });
  const { result } = renderHook(() => useTvPaged(fetchPage, "k"));
  await waitFor(() => expect(result.current.items).toEqual([1]));
  await act(() => result.current.loadMore());
  expect(fetchPage).toHaveBeenLastCalledWith(1, "c");
});

it("uses a seed page, waits for a null seed, never fetches page 0 when seeded", async () => {
  const fp = vi
    .fn<FetchPage<number>>()
    .mockResolvedValueOnce({ items: [2], hasMore: false });
  const { result, rerender } = renderHook(
    ({ seed }: { seed: TvPage<number> | null }) => useTvPaged(fp, "k", seed),
    { initialProps: { seed: null as TvPage<number> | null } },
  );
  expect(result.current).toMatchObject({ items: [], loading: true });
  expect(fp).not.toHaveBeenCalled();
  rerender({ seed: { items: [1], hasMore: true } });
  expect(result.current).toMatchObject({
    items: [1],
    loading: false,
    offset: 1,
  });
  expect(fp).not.toHaveBeenCalled();
  await act(() => result.current.loadMore());
  expect(fp).toHaveBeenLastCalledWith(1, null);
  expect(result.current.items).toEqual([1, 2]);
});

it("treats the seed as the whole list without a fetcher", () => {
  const seed = { items: [1, 2], hasMore: true };
  const { result } = renderHook(() => useTvPaged<number>(null, "k", seed));
  expect(result.current).toMatchObject({
    items: [1, 2],
    hasMore: false,
    loading: false,
  });
});

it("loadAll stops at the end or on an error", async () => {
  const all = vi
    .fn<FetchPage<number>>()
    .mockResolvedValueOnce({ items: [1], hasMore: true })
    .mockResolvedValueOnce({ items: [2], hasMore: true })
    .mockResolvedValueOnce({ items: [3], hasMore: false });
  const done = renderHook(() => useTvPaged(all, "k"));
  await act(() => done.result.current.loadAll());
  expect(done.result.current).toMatchObject({
    items: [1, 2, 3],
    hasMore: false,
  });
  expect(all).toHaveBeenCalledTimes(3);

  const failing = vi
    .fn<FetchPage<number>>()
    .mockResolvedValueOnce({ items: [1], hasMore: true })
    .mockRejectedValueOnce(new Error("x"))
    .mockResolvedValue({ items: [3], hasMore: false });
  const stopped = renderHook(() => useTvPaged(failing, "k"));
  await act(() => stopped.result.current.loadAll());
  expect(stopped.result.current).toMatchObject({
    items: [1],
    moreError: true,
    hasMore: true,
  });
  expect(failing).toHaveBeenCalledTimes(2);
});
