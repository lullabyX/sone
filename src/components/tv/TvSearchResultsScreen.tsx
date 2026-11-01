import { useCallback } from "react";
import { searchTidal } from "../../api/tidal";
import { addToSearchHistory, loadSearchHistory } from "../../lib/searchHistory";
import { useTvInitialFocus } from "./TvNavContext";
import { TvError, TvGrid, TvSpinner } from "./TvParts";
import { SEARCH_LIMIT, type SearchKind, searchEntries } from "./tvItems";
import { useTvLoader } from "./useTvLoader";

/** Every search result of one kind, behind a search row's "View all". */
export default function TvSearchResultsScreen({
  query,
  what,
  title,
}: {
  query: string;
  what: SearchKind;
  title: string;
}) {
  const load = useCallback(() => searchTidal(query, SEARCH_LIMIT), [query]);
  const { data, error, retry } = useTvLoader(load, "Search failed");

  useTvInitialFocus(data !== null || error !== null);

  if (error) return <TvError message={error} onRetry={retry} />;
  if (!data) return <TvSpinner />;

  const { entries, tracks } = searchEntries(data, what);

  return (
    <div className="pt-[2.5rem] pb-[3rem]">
      <div className="px-[3rem] mb-[1rem]">
        <h1 className="text-[2rem] font-extrabold text-th-text-primary">
          {title}
        </h1>
        <p className="text-[0.85rem] text-th-text-muted truncate">“{query}”</p>
      </div>
      {entries.length === 0 ? (
        <p className="px-[3rem] text-[0.85rem] text-th-text-muted">
          Nothing found for “{query}”.
        </p>
      ) : (
        <TvGrid
          entries={entries}
          queueTracks={tracks}
          queueId={query}
          queueType="search"
          name={`Search: ${query}`}
          showExplicit
          // Opening a result commits to its query, as on the Search screen.
          onActivate={() => addToSearchHistory(loadSearchHistory(), query)}
        />
      )}
    </div>
  );
}
