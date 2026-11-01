import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { useHomeFeed } from "../../hooks/useHomeFeed";
import { focusElement, focusFirstIn } from "../../lib/spatialNav";
import { isMyTracksItem } from "../../utils/itemHelpers";
import type { HomeSection } from "../../types";
import { TvScreenContext, useTvInitialFocus, useTvNav } from "./TvNavContext";
import { TvButton, TvError, TvRow, TvSpinner, TvTile } from "./TvParts";
import { useTvGrowOnFocus } from "./useTvGrowOnFocus";
import { sectionEntries, type TvEntry } from "./tvItems";

const MY_TRACKS: TvEntry = {
  key: "my-tracks",
  title: "My Tracks",
  subtitle: "",
  image: "",
  icon: "heart",
  action: { kind: "open", view: { type: "favorites" } },
};

/** The feed's shortcuts as a grid led by My Tracks (desktop Home's quick
 *  access: the first shortcut section, up to 7 of its items). */
function QuickAccess({ section }: { section: HomeSection }) {
  const nav = useTvNav();
  const { entries, tracks } = sectionEntries(
    (Array.isArray(section.items) ? section.items : []).filter(
      (i) => !isMyTracksItem(i),
    ),
    "SHORTCUT_LIST",
  );
  return (
    <div
      data-tv-remember
      data-testid="tv-quick-access"
      className="grid grid-cols-4 gap-x-[1.1rem] gap-y-[0.9rem] px-[3rem] pb-[0.8rem] mb-[1.2rem]"
    >
      {[MY_TRACKS, ...entries.slice(0, 7)].map((entry, i) => (
        <TvTile
          key={entry.key}
          entry={entry}
          autoFocus={i === 0}
          onSelect={() =>
            nav.run(entry.action, {
              tracks,
              name: section.title,
              id: `home:${section.title}`,
            })
          }
        />
      ))}
    </div>
  );
}

export default function TvHome() {
  const rootRef = useRef<HTMLDivElement>(null);
  const { active, element } = useContext(TvScreenContext);
  const activeRef = useRef(active);
  useLayoutEffect(() => {
    activeRef.current = active;
  });

  // The section `el` is in, or -1 (tabs, quick access, outside Home).
  const sectionOf = (el: Element | null) => {
    const root = rootRef.current;
    const item = el?.closest("[data-tv-index]");
    return root && item && root.contains(item)
      ? Number(item.getAttribute("data-tv-index"))
      : -1;
  };
  // Where focus was on Home, for while a screen or Now Playing covers it.
  const lastSectionRef = useRef(-1);
  // A refresh never pulls rows out from under focus further down, nor from
  // under the row Back returns to.
  const feed = useHomeFeed("tv", {
    allowReplace: () =>
      (activeRef.current
        ? sectionOf(document.activeElement)
        : lastSectionRef.current) <= 0,
  });
  const { sections, revalidate } = feed;
  const shortcuts = sections.find((s) => s.sectionType === "SHORTCUT_LIST");
  const rows = sections.filter((s) => s.sectionType !== "SHORTCUT_LIST");

  useTvGrowOnFocus(rootRef, rows.length, feed.loadMore, 2);

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

  // After Load more / Try again, focus goes to the first new row with cards
  // (or back to the button) once the page is in.
  const focusFrom = useRef<number | null>(null);
  const loadMoreFromButton = (retry: boolean) => {
    focusFrom.current = rows.length;
    if (retry) feed.retryMore();
    else feed.loadMore();
  };
  useLayoutEffect(() => {
    const from = focusFrom.current;
    const root = rootRef.current;
    if (from === null || feed.loadingMore || !root) return;
    focusFrom.current = null;
    const current = document.activeElement;
    if (current && current !== document.body && current.isConnected) return;
    const next =
      Array.from(root.querySelectorAll<HTMLElement>("[data-tv-index]"))
        .filter((el) => Number(el.getAttribute("data-tv-index")) >= from)
        .map((el) => el.querySelector<HTMLElement>("[data-tv-focusable]"))
        .find((el) => el !== null) ??
      root.querySelector<HTMLElement>("[data-tv-more] [data-tv-focusable]");
    if (next) focusElement(next);
  }, [feed.loadingMore, sections]);

  useTvInitialFocus(!feed.loading);

  return (
    <div
      ref={rootRef}
      data-tv-loading={feed.loadingMore || undefined}
      onFocus={(e) => {
        lastSectionRef.current = sectionOf(e.target);
      }}
      className="pt-[2rem] pb-[2rem]"
    >
      {feed.tabs.length > 1 && (
        <div className="flex gap-[0.8rem] px-[3rem] mb-[1.2rem]">
          {feed.tabs.map((tab) => (
            <TvButton
              key={tab.tabType}
              label={tab.name}
              active={tab.tabType === feed.activeType}
              onClick={() => {
                focusFrom.current = null;
                feed.selectTab(tab.tabType);
              }}
            />
          ))}
        </div>
      )}
      {feed.loading ? (
        <TvSpinner />
      ) : feed.error && sections.length === 0 ? (
        <TvError message={feed.error} onRetry={feed.retry} />
      ) : (
        <>
          {shortcuts && (
            <QuickAccess key={feed.activeType} section={shortcuts} />
          )}
          {rows.map((section, i) => {
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
          })}
        </>
      )}
      {feed.loadingMore && (
        <div role="status" aria-label="Loading more">
          <TvSpinner />
        </div>
      )}
      {!feed.loading && !feed.loadingMore && feed.moreError && (
        <div
          data-tv-more
          className="flex items-center gap-[1rem] px-[3rem] py-[1rem]"
        >
          <p className="text-[0.85rem] text-th-text-secondary">
            Couldn't load more
          </p>
          <TvButton
            label="Try again"
            onClick={() => loadMoreFromButton(true)}
          />
        </div>
      )}
      {/* Reachable when the last rows show no cards, so focus never nears
          the end again. */}
      {!feed.loading && feed.cursor && !feed.loadingMore && !feed.moreError && (
        <div data-tv-more className="px-[3rem] py-[1rem]">
          <TvButton
            label="Load more"
            onClick={() => loadMoreFromButton(false)}
          />
        </div>
      )}
    </div>
  );
}
