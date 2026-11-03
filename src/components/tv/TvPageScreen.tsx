import { useCallback } from "react";
import { getPageSection } from "../../api/tidal";
import { useTvInitialFocus } from "./TvNavContext";
import { TvError, TvGrid, TvRow, TvSpinner } from "./TvParts";
import { sectionEntries } from "./tvItems";
import { useTvLoader } from "./useTvLoader";

/**
 * A TIDAL page by its API path, the TV counterpart of the desktop's Explore,
 * Explore sub-pages and "View all" pages:
 * - `all` (a home row's "View all"): every item as one grid.
 * - A page that is a single list of links: one grid of links.
 * - Otherwise each section as a row, with its own "View all" when TIDAL has
 *   more than the row shows.
 */
export default function TvPageScreen({
  title,
  apiPath,
  all,
}: {
  title: string;
  apiPath: string;
  all?: boolean;
}) {
  const load = useCallback(() => getPageSection(apiPath), [apiPath]);
  const { data, error, retry } = useTvLoader(load, "Couldn't load this page");

  useTvInitialFocus(data !== null || error !== null);

  if (error) return <TvError message={error} onRetry={retry} />;
  if (!data) return <TvSpinner />;

  const sections = data.sections
    .map((section) => ({
      section,
      ...sectionEntries(section.items, section.sectionType),
    }))
    .filter((s) => s.entries.length > 0);
  // One grid for "View all", and for a page that is a single list of links
  // (a genre's sub-pages); titled link sections (Genres, Moods, Decades)
  // stay rows of their own, as on the desktop.
  const flat =
    all ||
    (sections.every((s) => s.entries.every(isLink)) &&
      sections.filter((s) => s.section.title).length <= 1);

  return (
    <div className="pt-[2.5rem] pb-[3rem]">
      <h1 className="text-[2rem] font-extrabold text-th-text-primary px-[3rem] mb-[1rem]">
        {title}
      </h1>
      {sections.length === 0 ? (
        <p className="px-[3rem] text-[0.85rem] text-th-text-muted">
          Nothing here yet.
        </p>
      ) : flat ? (
        <TvGrid
          entries={dedupe(sections.flatMap((s) => s.entries))}
          queueTracks={sections.flatMap((s) => s.tracks)}
          queueId={`page:${apiPath}`}
          name={title}
        />
      ) : (
        sections.map(({ section, entries, tracks }, i) => (
          <TvRow
            key={`${section.title}:${i}`}
            title={section.title}
            entries={entries}
            queueTracks={tracks}
            queueId={`page:${apiPath}:${section.title}`}
            viewAll={
              section.hasMore && section.apiPath
                ? {
                    type: "page",
                    title: section.title,
                    apiPath: section.apiPath,
                    all: true,
                  }
                : undefined
            }
          />
        ))
      )}
    </div>
  );
}

function isLink(entry: { icon?: string }) {
  return entry.icon === "link";
}

function dedupe<T extends { key: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  return entries.filter((e) => !seen.has(e.key) && !!seen.add(e.key));
}
