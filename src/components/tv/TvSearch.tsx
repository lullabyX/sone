import { useContext, useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { searchTidal } from "../../api/tidal";
import { safeErrorMessage } from "../../lib/errorUtils";
import type { SearchResults } from "../../types";
import { TvScreenContext, useTvInitialFocus } from "./TvNavContext";
import TvKeyboard from "./TvKeyboard";
import { TvRow, TvSpinner } from "./TvParts";
import { sectionEntries } from "./tvItems";

const DEBOUNCE_MS = 450;

// Kept across visits: switching rail sections unmounts the screen.
let lastQuery = "";

export default function TvSearch() {
  const { active } = useContext(TvScreenContext);
  const [query, setQuery] = useState(lastQuery);
  // Latest finished search; kept on screen while the next one is pending.
  const [outcome, setOutcome] = useState<{
    q: string;
    results: SearchResults | null;
    error: string | null;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const q = query.trim();

  useTvInitialFocus(true);

  useEffect(() => {
    lastQuery = query;
  }, [query]);

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

  // Typing on a real keyboard goes to the search field wherever focus is, so
  // the on-screen keys are only needed with a remote.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key.length !== 1 || e.key === " ") return;
      if (document.activeElement === inputRef.current) return;
      inputRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);

  const sections = results
    ? [
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
        {
          title: "Videos",
          ...sectionEntries(results.videos, "VIDEO_LIST"),
        },
      ]
    : [];
  const empty =
    results !== null && sections.every((s) => s.entries.length === 0);

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
            placeholder="Search TIDAL"
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-[0.9rem] text-th-text-primary placeholder:text-th-text-faint"
          />
        </label>
        <div className="mt-[1rem]">
          <TvKeyboard autoFocus onChange={setQuery} />
        </div>
      </div>

      <div className="flex-1 min-w-0 pt-[2rem] pb-[2rem]">
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
              queueTracks={s.tracks}
              queueId={`search:${q}`}
            />
          ))
        ) : (
          <p className="px-[3rem] pt-[1rem] text-[0.85rem] text-th-text-muted">
            Find artists, albums, tracks and playlists.
          </p>
        )}
      </div>
    </div>
  );
}
