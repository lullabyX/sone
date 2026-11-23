import { ArrowDown, ArrowUp } from "lucide-react";
import type { SortOrder } from "../../atoms/favorites";
import { SORT_OPTIONS } from "../../constants/sortOptions";
import { nextSortOrder, type LibraryType } from "../../lib/libraryPages";
import type { TvMenuSpec } from "./tvMenu";

/** The desktop track list's sortable columns, plus its unsorted order. */
export const TRACK_SORT_OPTIONS: {
  value: string | null;
  label: string;
  ownOnly?: boolean;
}[] = [
  { value: null, label: "Playlist order" },
  { value: "NAME", label: "Title" },
  { value: "ARTIST", label: "Artist" },
  { value: "ALBUM", label: "Album" },
  { value: "DATE", label: "Date added", ownOnly: true },
  { value: "LENGTH", label: "Duration" },
];

/** Loved Tracks' order when nothing is stored (FavoritesView's default). */
export const FAVORITES_TRACK_SORT: SortOrder = {
  order: "DATE",
  direction: "DESC",
};

/** Same as clicking a TrackList header: the sorted column flips its
 *  direction, another column starts ascending; `null` is the unsorted order. */
export function nextTrackSort(
  current: SortOrder | null,
  value: string | null,
): SortOrder | null {
  if (value === null) return null;
  if (current?.order === value)
    return {
      order: value,
      direction: current.direction === "ASC" ? "DESC" : "ASC",
    };
  return { order: value, direction: "ASC" };
}

export function trackSortMenu(opts: {
  current: SortOrder | null;
  own: boolean;
  favorites: boolean;
  onPick: (s: SortOrder | null) => void;
}): TvMenuSpec {
  const current = opts.favorites
    ? (opts.current ?? FAVORITES_TRACK_SORT)
    : opts.current;
  const options = TRACK_SORT_OPTIONS.filter((o) =>
    opts.favorites ? o.value !== null : opts.own || !o.ownOnly,
  );
  return {
    title: "Sort by",
    items: options.map((o) => {
      const checked = (current?.order ?? null) === o.value;
      return {
        label: o.label,
        checked,
        icon:
          checked && current
            ? current.direction === "ASC"
              ? ArrowUp
              : ArrowDown
            : undefined,
        onSelect: () => {
          const next = nextTrackSort(current, o.value);
          // FavoritesView stores no key for its default order.
          const isDefault =
            opts.favorites &&
            next?.order === FAVORITES_TRACK_SORT.order &&
            next.direction === FAVORITES_TRACK_SORT.direction;
          opts.onPick(isDefault ? null : next);
        },
      };
    }),
  };
}

/** The desktop library sort dropdown: picking the current order flips its
 *  direction. */
export function librarySortMenu(
  type: LibraryType,
  current: SortOrder,
  onPick: (s: SortOrder) => void,
): TvMenuSpec {
  return {
    title: "Sort by",
    items: SORT_OPTIONS[type].map((o) => {
      const checked = current.order === o.value;
      return {
        label: o.label,
        checked,
        icon: checked
          ? current.direction === "ASC"
            ? ArrowUp
            : ArrowDown
          : undefined,
        onSelect: () => onPick(nextSortOrder(current, o.value)),
      };
    }),
  };
}
