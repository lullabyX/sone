import { useCallback, useEffect, useState } from "react";
import { getHomePage, getHomePageMore } from "../../api/tidal";
import { safeErrorMessage } from "../../lib/errorUtils";
import type { HomeSection } from "../../types";
import { useTvInitialFocus } from "./TvNavContext";
import { TvError, TvRow, TvSpinner } from "./TvParts";
import { sectionEntries } from "./tvItems";

/** Extra feed pages fetched after the first, so the screen has enough rows
 *  without an infinite-scroll sentinel (focus moves, the page doesn't). */
const EXTRA_PAGES = 3;

export default function TvHome() {
  const [sections, setSections] = useState<HomeSection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let loaded = false;
      try {
        const { home } = await getHomePage();
        if (cancelled) return;
        setSections(home.sections);
        loaded = true;
        let cursor = home.cursor;
        for (let i = 0; i < EXTRA_PAGES && cursor; i++) {
          const more = await getHomePageMore(cursor);
          if (cancelled) return;
          setSections((prev) => [...(prev ?? []), ...more.sections]);
          cursor = more.cursor;
        }
      } catch (e) {
        // A later page failing keeps the rows already shown.
        if (!cancelled && !loaded) {
          setError(safeErrorMessage(e, "Couldn't load home"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setError(null);
    setSections(null);
    setAttempt((a) => a + 1);
  }, []);

  useTvInitialFocus(sections !== null || error !== null);

  if (error) return <TvError message={error} onRetry={retry} />;
  if (!sections) return <TvSpinner />;

  return (
    <div className="pt-[2rem] pb-[2rem]">
      {sections.map((section, i) => {
        const { entries, tracks } = sectionEntries(
          section.items,
          section.sectionType,
        );
        return (
          <TvRow
            key={`${section.title}:${i}`}
            title={section.title}
            entries={entries}
            queueTracks={tracks}
            queueId={`home:${section.title}`}
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
        );
      })}
    </div>
  );
}
