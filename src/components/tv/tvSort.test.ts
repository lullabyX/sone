import { expect, it, vi } from "vitest";
import { ArrowDown, ArrowUp } from "lucide-react";
import { librarySortMenu, nextTrackSort, trackSortMenu } from "./tvSort";
import { setupTvTest } from "./tvTestUtils";

setupTvTest();

it("toggles the direction of the same column, starts a new one ascending, and resets on null", () => {
  expect(nextTrackSort(null, "NAME")).toEqual({
    order: "NAME",
    direction: "ASC",
  });
  expect(nextTrackSort({ order: "NAME", direction: "ASC" }, "NAME")).toEqual({
    order: "NAME",
    direction: "DESC",
  });
  expect(nextTrackSort({ order: "NAME", direction: "DESC" }, "NAME")).toEqual({
    order: "NAME",
    direction: "ASC",
  });
  expect(nextTrackSort({ order: "NAME", direction: "DESC" }, "ARTIST")).toEqual(
    { order: "ARTIST", direction: "ASC" },
  );
  expect(nextTrackSort({ order: "NAME", direction: "ASC" }, null)).toBeNull();
});

it("offers Date added only on own playlists and marks the current sort with its direction", async () => {
  const onPick = vi.fn();
  const other = trackSortMenu({
    current: null,
    own: false,
    favorites: false,
    onPick,
  });
  expect(other.items.map((i) => i.label)).toEqual([
    "Playlist order",
    "Title",
    "Artist",
    "Album",
    "Duration",
  ]);
  expect(other.items.filter((i) => i.checked).map((i) => i.label)).toEqual([
    "Playlist order",
  ]);
  const own = trackSortMenu({
    current: { order: "ARTIST", direction: "DESC" },
    own: true,
    favorites: false,
    onPick,
  });
  expect(own.items.map((i) => i.label)).toEqual([
    "Playlist order",
    "Title",
    "Artist",
    "Album",
    "Date added",
    "Duration",
  ]);
  const checked = own.items.find((i) => i.checked)!;
  expect(checked.label).toBe("Artist");
  expect(checked.icon).toBe(ArrowDown);
  await own.items.find((i) => i.label === "Artist")!.onSelect!();
  expect(onPick).toHaveBeenLastCalledWith({
    order: "ARTIST",
    direction: "ASC",
  });
  await own.items.find((i) => i.label === "Playlist order")!.onSelect!();
  expect(onPick).toHaveBeenLastCalledWith(null);
});

it("My Tracks has no playlist order and treats newest first as the default", async () => {
  const onPick = vi.fn();
  const fav = trackSortMenu({
    current: null,
    own: true,
    favorites: true,
    onPick,
  });
  expect(fav.items.map((i) => i.label)).toEqual([
    "Title",
    "Artist",
    "Album",
    "Date added",
    "Duration",
  ]);
  const checked = fav.items.find((i) => i.checked)!;
  expect(checked.label).toBe("Date added");
  expect(checked.icon).toBe(ArrowDown);
  await fav.items.find((i) => i.label === "Date added")!.onSelect!();
  expect(onPick).toHaveBeenLastCalledWith({ order: "DATE", direction: "ASC" });

  const asc = trackSortMenu({
    current: { order: "DATE", direction: "ASC" },
    own: false,
    favorites: true,
    onPick,
  });
  expect(asc.items.map((i) => i.label)).toContain("Date added");
  expect(asc.items.find((i) => i.checked)!.icon).toBe(ArrowUp);
  await asc.items.find((i) => i.label === "Date added")!.onSelect!();
  expect(onPick).toHaveBeenLastCalledWith(null);
});

it("offers a collection's sort orders and flips the current one", async () => {
  const onPick = vi.fn();
  const m = librarySortMenu(
    "albums",
    { order: "DATE", direction: "DESC" },
    onPick,
  );
  expect(m.items.map((i) => i.label)).toEqual([
    "Date added",
    "Name",
    "Artist",
    "Release date",
  ]);
  const checked = m.items.filter((i) => i.checked);
  expect(checked.map((i) => i.label)).toEqual(["Date added"]);
  expect(checked[0].icon).toBe(ArrowDown);
  expect(m.items[1].icon).toBeUndefined();
  await m.items[1].onSelect!();
  expect(onPick).toHaveBeenLastCalledWith({ order: "NAME", direction: "ASC" });
  await m.items[0].onSelect!();
  expect(onPick).toHaveBeenLastCalledWith({ order: "DATE", direction: "ASC" });
  const asc = librarySortMenu(
    "playlists",
    { order: "NAME", direction: "ASC" },
    onPick,
  );
  expect(asc.items.map((i) => i.label)).toEqual([
    "Date added",
    "Last updated",
    "Name",
  ]);
  expect(asc.items.find((i) => i.checked)!.icon).toBe(ArrowUp);
});
