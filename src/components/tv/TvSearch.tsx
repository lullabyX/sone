import { useContext, useEffect, useRef, useState } from "react";
import { useAtom, useStore } from "jotai";
import { History, Search, Trash2, X } from "lucide-react";
import { searchTidal } from "../../api/tidal";
import { tvSearchQueryAtom } from "../../atoms/tv";
import { currentVideoAtom, videoExpandedAtom } from "../../atoms/video";
import { safeErrorMessage } from "../../lib/errorUtils";
import {
  addToSearchHistory,
  clearSearchHistory,
  loadSearchHistory,
  removeFromSearchHistory,
} from "../../lib/searchHistory";
import { focusElement, focusFirstIn } from "../../lib/spatialNav";
import type { SearchResults, Track } from "../../types";
import { TvScreenContext, useTvInitialFocus, useTvNav } from "./TvNavContext";
import TvKeyboard from "./TvKeyboard";
import { TvButton, TvRow, TvSpinner } from "./TvParts";
import {
  sectionEntries,
  topHitEntries,
  type TvEntry,
  videoEntries,
} from "./tvItems";
import { confirmMenu, tvMenuRef } from "./tvMenu";

const DEBOUNCE_MS = 450;

export default function TvSearch() {
  const { active } = useContext(TvScreenContext);
  const store = useStore();
  const nav = useTvNav();
  // Kept across visits: switching rail sections unmounts the screen.
  const [query, setQuery] = useAtom(tvSearchQueryAtom);
  const [history, setHistory] = useState(loadSearchHistory);
  // Latest finished search; kept on screen while the next one is pending.
  const [outcome, setOutcome] = useState<{
    q: string;
    results: SearchResults | null;
    error: string | null;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const keysRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const recentRef = useRef<HTMLDivElement>(null);
  // Results to move focus to once they arrive, unless focus moved on from
  // where it was when the search was submitted.
  const pendingFocus = useRef<{ q: string; from: Element | null } | null>(
    null,
  );
  // After a recent search is removed: the row to focus in its place.
  const refocusRecent = useRef<number | null>(null);
  const q = query.trim();

  useTvInitialFocus(true);

  useEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    if (p.q !== q) {
      pendingFocus.current = null;
      return;
    }
    if (outcome?.q !== q) return;
    pendingFocus.current = null;
    const el = document.activeElement;
    if (el !== p.from && el !== document.body) return;
    if (resultsRef.current) focusFirstIn(resultsRef.current);
  }, [outcome, q]);

  useEffect(() => {
    const i = refocusRecent.current;
    if (i === null) return;
    refocusRecent.current = null;
    const rows =
      recentRef.current?.querySelectorAll<HTMLElement>("[data-tv-recent]");
    if (rows && rows.length > 0) {
      focusElement(rows[Math.min(i, rows.length - 1)]);
    } else if (keysRef.current) {
      focusFirstIn(keysRef.current);
    }
  }, [history]);

  useEffect(() => {
    if (!q) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchTidal(q, 20).then(
        (results) => {
          if (!cancelled) setOutcome({ q, results, error: null });
        },
        (e) => {
          if (!cancelled)
            setOutcome({
              q,
              results: null,
              error: safeErrorMessage(e, "Search failed"),
            });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  const shown = q ? outcome : null;
  const results = shown?.results ?? null;
  const error = shown?.error ?? null;
  const loading = !!q && outcome?.q !== q;

  // Typing on a real keyboard goes to the search field from anywhere on the
  // screen, so the on-screen keys are only needed with a remote. Not from a
  // prompt or menu, the on-screen keys (they type themselves) or a video.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key.length !== 1 || e.key === " ") return;
      const el = document.activeElement;
      if (el === inputRef.current) return;
      if (document.querySelector("[data-tv-modal]")) return;
      if (el?.closest("[data-tv-keyboard]")) return;
      if (store.get(currentVideoAtom) && store.get(videoExpandedAtom)) return;
      inputRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, store]);

  // The query that found the results on screen, which newer typing may not
  // have replaced yet.
  const foundBy = shown?.q ?? q;
  // Top hits play on their own (no `tracks`); a track or video plays with
  // the rest of its row queued, as on the desktop.
  const sections: { title: string; entries: TvEntry[]; tracks?: Track[] }[] =
    results
      ? [
          { title: "Top hits", entries: topHitEntries(results.topHits ?? []) },
          {
            title: "Tracks",
            ...sectionEntries(results.tracks, "TRACK_LIST"),
          },
          {
            title: "Artists",
            ...sectionEntries(results.artists, "ARTIST_LIST"),
          },
          {
            title: "Albums",
            ...sectionEntries(results.albums, "ALBUM_LIST"),
          },
          {
            title: "Playlists",
            ...sectionEntries(results.playlists, "PLAYLIST_LIST"),
          },
          { title: "Videos", ...videoEntries(results.videos) },
        ]
      : [];
  const empty =
    results !== null && sections.every((s) => s.entries.length === 0);

  // A query is recorded only once the user commits to it.
  const record = (text: string) =>
    setHistory(addToSearchHistory(history, text));

  // The Search key, or Enter in the box: record the query and go to the
  // first result (as soon as there is one).
  const submit = () => {
    if (!q) return;
    record(q);
    if (loading) pendingFocus.current = { q, from: document.activeElement };
    else if (resultsRef.current) focusFirstIn(resultsRef.current);
  };

  const pickRecent = (h: string) => {
    record(h);
    setQuery(h);
    const key =
      keysRef.current?.querySelector<HTMLElement>('[aria-label="Search"]') ??
      null;
    if (key) focusElement(key);
    pendingFocus.current = { q: h.trim(), from: key };
  };

  const removeRecent = (h: string) => {
    refocusRecent.current = history.indexOf(h);
    setHistory(removeFromSearchHistory(history, h));
  };

  const clearRecent = () =>
    nav.openMenu(
      confirmMenu({
        title: "Clear recent searches?",
        confirmLabel: "Clear",
        icon: Trash2,
        onConfirm: () => {
          refocusRecent.current = 0;
          setHistory(clearSearchHistory());
        },
      }),
    );

  return (
    <div className="flex items-start min-h-full">
      <div className="sticky top-0 w-[20rem] shrink-0 pl-[3rem] pr-[1rem] pt-[2.5rem]">
        <label className="flex items-center gap-[0.6rem] h-[2.8rem] px-[1rem] rounded-[0.6rem] bg-th-surface tv-input">
          <Search className="w-[1.1rem] h-[1.1rem] text-th-text-muted shrink-0" />
          <input
            ref={inputRef}
            data-tv-focusable
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              // Focus may move to a result: its keypress must not open it.
              e.preventDefault();
              submit();
            }}
            placeholder="Search TIDAL"
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-[0.9rem] text-th-text-primary placeholder:text-th-text-faint"
          />
        </label>
        <div ref={keysRef} className="mt-[1rem]">
          <TvKeyboard
            autoFocus
            onChange={setQuery}
            empty={query === ""}
            onSubmit={submit}
          />
        </div>
      </div>

      <div ref={resultsRef} className="flex-1 min-w-0 pt-[2rem] pb-[2rem]">
        {loading && !shown ? (
          <TvSpinner />
        ) : error ? (
          <p className="px-[3rem] pt-[1rem] text-[0.85rem] text-th-text-secondary">
            {error}
          </p>
        ) : empty ? (
          <p className="px-[3rem] pt-[1rem] text-[0.85rem] text-th-text-secondary">
            Nothing found for “{q}”.
          </p>
        ) : results ? (
          sections.map((s) => (
            <TvRow
              key={s.title}
              title={s.title}
              entries={s.entries}
              showExplicit
              queueTracks={s.tracks}
              queueId={s.tracks && foundBy}
              queueType={s.tracks && "search"}
              queueName={s.tracks && `Search: ${foundBy}`}
              onActivate={() => record(foundBy)}
            />
          ))
        ) : !q && history.length > 0 ? (
          <section className="px-[3rem]">
            <h2 className="text-[1.05rem] font-bold text-th-text-primary mb-[0.6rem]">
              Recent searches
            </h2>
            <div
              ref={recentRef}
              data-tv-remember
              className="flex flex-col items-start gap-[0.3rem]"
            >
              {history.map((h) => (
                <button
                  key={h}
                  data-tv-focusable
                  data-tv-recent
                  data-tv-has-menu
                  ref={tvMenuRef(() => ({
                    title: h,
                    items: [
                      {
                        label: "Remove from recent searches",
                        icon: X,
                        onSelect: () => removeRecent(h),
                      },
                    ],
                  }))}
                  onClick={() => pickRecent(h)}
                  className="tv-track flex items-center gap-[0.8rem] max-w-full px-[1rem] h-[2.6rem] rounded-[0.5rem] text-left"
                >
                  <History className="w-[1.1rem] h-[1.1rem] shrink-0 text-th-text-muted" />
                  <span className="truncate text-[0.9rem] text-th-text-primary">
                    {h}
                  </span>
                </button>
              ))}
              <div className="mt-[0.8rem]">
                <TvButton
                  icon={<Trash2 className="w-[1rem] h-[1rem]" />}
                  label="Clear recent searches"
                  onClick={clearRecent}
                />
              </div>
            </div>
          </section>
        ) : (
          <p className="px-[3rem] pt-[1rem] text-[0.85rem] text-th-text-muted">
            Find artists, albums, tracks and playlists.
          </p>
        )}
      </div>
    </div>
  );
}
