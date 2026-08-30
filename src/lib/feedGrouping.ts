import type { FeedItem } from "../types";

/** Not exported: `knip` flags exports unused outside their own file, and this feature
 *  must not add to the baseline count. Consumers infer the shape from the return type. */
interface FeedGroup {
  label: string;
  items: FeedItem[];
}

const THIS_MONTH = "This month";
const LAST_MONTH = "Last month";
const OLDER = "Older";

/**
 * Bucket feed items by calendar month, not by rolling day counts. A December
 * entry viewed in January is "Last month", not "Older".
 *
 * `now` is a parameter so month and year boundaries are testable without
 * mocking the clock.
 *
 * Both sides are compared in UTC. `occurredAt` is always midnight UTC — a
 * day-granularity event — so reading it with local getters would shift every
 * entry back a day in any negative-offset timezone and misbucket the first of
 * the month. Comparing local-to-local would make the tests timezone-dependent.
 *
 * Note that a mix titled "July 2026" carries an `occurredAt` of 2026-08-01, so
 * in August it lands under "This month". The title and the bucket legitimately
 * disagree — the reference client behaves the same way.
 */
export function groupFeedByPeriod(items: FeedItem[], now: Date): FeedGroup[] {
  const buckets: Record<string, FeedItem[]> = {
    [THIS_MONTH]: [],
    [LAST_MONTH]: [],
    [OLDER]: [],
  };

  const nowMonths = now.getUTCFullYear() * 12 + now.getUTCMonth();

  for (const entry of items) {
    const date = new Date(entry.occurredAt);
    if (Number.isNaN(date.getTime())) continue;

    const months = date.getUTCFullYear() * 12 + date.getUTCMonth();
    const delta = nowMonths - months;

    if (delta <= 0) buckets[THIS_MONTH].push(entry);
    else if (delta === 1) buckets[LAST_MONTH].push(entry);
    else buckets[OLDER].push(entry);
  }

  return [THIS_MONTH, LAST_MONTH, OLDER]
    .filter((label) => buckets[label].length > 0)
    .map((label) => ({ label, items: buckets[label] }));
}
