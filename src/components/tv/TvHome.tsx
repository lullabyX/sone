import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { useHomeFeed } from "../../hooks/useHomeFeed";
import { focusFirstIn } from "../../lib/spatialNav";
import { TvScreenContext, useTvInitialFocus } from "./TvNavContext";
import { TvButton, TvError, TvRow, TvSpinner } from "./TvParts";
import { useTvGrowOnFocus } from "./useTvGrowOnFocus";
import { sectionEntries } from "./tvItems";

export default function TvHome() {
  const rootRef = useRef<HTMLDivElement>(null);
  const { active, element } = useContext(TvScreenContext);
  const activeRef = useRef(active);
  useLayoutEffect(() => {
    activeRef.current = active;
  });

  // The section focus is in, or -1 (tabs, quick access, outside Home).
  const focusedSection = () => {
    const root = rootRef.current;
    const item = document.activeElement?.closest("[data-tv-index]");
    return root && item && root.contains(item)
      ? Number(item.getAttribute("data-tv-index"))
      : -1;
  };
  // A refresh never pulls rows out from under focus further down.
  const feed = useHomeFeed("tv", {
    allowReplace: () => !activeRef.current || focusedSection() <= 0,
  });
  const { sections, revalidate } = feed;

  useTvGrowOnFocus(rootRef, sections.length, feed.loadMore, 2);

  // A refresh may replace the rows focus was on.
  const refocusIfLost = useCallback(() => {
    const current = document.activeElement;
    if (current && current !== document.body && current.isConnected) return;
    const el = element();
    if (el) focusFirstIn(el);
  }, [element]);

  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) {
      revalidate();
      refocusIfLost();
    }
    wasActive.current = active;
  }, [active, revalidate, refocusIfLost]);

  const prevCount = useRef(sections.length);
  useEffect(() => {
    if (activeRef.current && prevCount.current > 0) refocusIfLost();
    prevCount.current = sections.length;
  }, [sections, refocusIfLost]);

  useTvInitialFocus(!feed.loading);

  return (
    <div
      ref={rootRef}
      data-tv-loading={feed.loadingMore || undefined}
      className="pt-[2rem] pb-[2rem]"
    >
      {feed.tabs.length > 1 && (
        <div className="flex gap-[0.8rem] px-[3rem] mb-[1.2rem]">
          {feed.tabs.map((tab) => (
            <TvButton
              key={tab.tabType}
              label={tab.name}
              active={tab.tabType === feed.activeType}
              onClick={() => feed.selectTab(tab.tabType)}
            />
          ))}
        </div>
      )}
      {feed.loading ? (
        <TvSpinner />
      ) : feed.error && sections.length === 0 ? (
        <TvError message={feed.error} onRetry={feed.retry} />
      ) : (
        sections.map((section, i) => {
          const { entries, tracks } = sectionEntries(
            section.items,
            section.sectionType,
          );
          return (
            <div
              key={`${feed.activeType}:${section.title}:${i}`}
              data-tv-index={i}
            >
              <TvRow
                title={section.title}
                entries={entries}
                queueTracks={tracks}
                queueId={`home:${section.title}`}
                showExplicit
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
            </div>
          );
        })
      )}
      {feed.loadingMore && (
        <div role="status" aria-label="Loading more">
          <TvSpinner />
        </div>
      )}
    </div>
  );
}
