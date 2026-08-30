import { describe, it, expect } from "vitest";
import { groupFeedByPeriod } from "./feedGrouping";
import type { FeedItem } from "../types";

function item(occurredAt: string): FeedItem {
  return {
    kind: "album",
    activityType: "NEW_ALBUM_RELEASE",
    occurredAt,
    seen: true,
    item: { id: 1, title: "x" },
  };
}

describe("groupFeedByPeriod", () => {
  it("returns no groups for an empty list", () => {
    expect(groupFeedByPeriod([], new Date("2026-08-22T12:00:00Z"))).toEqual([]);
  });

  it("buckets the current calendar month as This month", () => {
    const groups = groupFeedByPeriod(
      [item("2026-08-01T00:00:00.000Z")],
      new Date("2026-08-22T12:00:00Z"),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("This month");
  });

  it("buckets the preceding calendar month as Last month", () => {
    const groups = groupFeedByPeriod(
      [item("2026-07-15T00:00:00.000Z")],
      new Date("2026-08-22T12:00:00Z"),
    );
    expect(groups[0].label).toBe("Last month");
  });

  it("treats December as Last month when now is January", () => {
    const groups = groupFeedByPeriod(
      [item("2025-12-20T00:00:00.000Z")],
      new Date("2026-01-10T12:00:00Z"),
    );
    expect(groups[0].label).toBe("Last month");
  });

  it("buckets anything earlier as Older", () => {
    const groups = groupFeedByPeriod(
      [item("2026-05-01T00:00:00.000Z")],
      new Date("2026-08-22T12:00:00Z"),
    );
    expect(groups[0].label).toBe("Older");
  });

  it("puts future-dated entries in This month", () => {
    const groups = groupFeedByPeriod(
      [item("2027-01-01T00:00:00.000Z")],
      new Date("2026-08-22T12:00:00Z"),
    );
    expect(groups[0].label).toBe("This month");
  });

  it("omits empty buckets and keeps bucket order", () => {
    const groups = groupFeedByPeriod(
      [item("2026-05-01T00:00:00.000Z"), item("2026-08-02T00:00:00.000Z")],
      new Date("2026-08-22T12:00:00Z"),
    );
    expect(groups.map((g) => g.label)).toEqual(["This month", "Older"]);
  });

  it("preserves input order within a bucket", () => {
    const groups = groupFeedByPeriod(
      [item("2026-08-10T00:00:00.000Z"), item("2026-08-02T00:00:00.000Z")],
      new Date("2026-08-22T12:00:00Z"),
    );
    expect(groups[0].items.map((i) => i.occurredAt)).toEqual([
      "2026-08-10T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    ]);
  });

  it("drops entries with an unparseable date", () => {
    expect(
      groupFeedByPeriod([item("not-a-date")], new Date("2026-08-22T12:00:00Z")),
    ).toEqual([]);
  });
});
