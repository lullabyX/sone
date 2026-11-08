import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { atom, useAtom, useAtomValue } from "jotai";
import { ArrowDown, ArrowUp, ListFilter, X } from "lucide-react";
import {
  getArtistViewAll,
  getFavoriteVideos,
  getFlattenedPlaylists,
} from "../../api/tidal";
import { authTokensAtom } from "../../atoms/auth";
import {
  albumSortAtom,
  artistSortAtom,
  mixSortAtom,
  playlistSortAtom,
  type SortOrder,
} from "../../atoms/favorites";
import {
  addedToFolderAtom,
  deletedFolderIdsAtom,
  deletedPlaylistIdsAtom,
  folderCountAdjustmentsAtom,
  movedPlaylistsAtom,
  renamedFoldersAtom,
} from "../../atoms/playlists";
import { SORT_OPTIONS } from "../../constants/sortOptions";
import {
  applyLocalPlaylistEdits,
  fetchLibraryPage,
  filterLibraryItems,
  type LibraryType,
} from "../../lib/libraryPages";
import { focusElement, focusFirstIn } from "../../lib/spatialNav";
import type { PlaylistOrFolder } from "../../types";
import { useTvInitialFocus, useTvNav } from "./TvNavContext";
import { TvButton, TvError, TvGrid, TvSpinner } from "./TvParts";
import { libraryEntries, sectionEntries, type TvListSource } from "./tvItems";
import { librarySortMenu } from "./tvSort";
import { useTvGrowOnFocus } from "./useTvGrowOnFocus";
import { useTvPaged, type TvPage } from "./useTvPaged";

const PAGE = 50;

const SECTION_TYPE = {
  albums: "ALBUM_LIST",
  artists: "ARTIST_LIST",
  mixes: "MIX_LIST",
  videos: "VIDEO_LIST",
} as const;

const SORT_ATOM = {
  playlists: playlistSortAtom,
  albums: albumSortAtom,
  artists: artistSortAtom,
  mixes: mixSortAtom,
};
// Videos and artist lists have no sort; this keeps the hook unconditional.
const UNSORTED = atom<SortOrder>({ order: "", direction: "" });

const FILTER_HINT = {
  playlists: "Title or creator",
  albums: "Title or artist",
  artists: "Name",
  mixes: "Title",
};

/** Every item of a collection row, a playlist folder or an artist row, as a
 *  grid that loads its next page as focus nears the end. */
export default function TvListScreen({
  title,
  source,
}: {
  title: string;
  source: TvListSource;
}) {
  const nav = useTvNav();
  const userId = useAtomValue(authTokensAtom)?.user_id;
  // Collection lists sort and filter like the desktop's library pages.
  const libraryType: LibraryType | null =
    source.kind === "collection" && source.what !== "videos"
      ? source.what
      : null;
  const [sort, setSort] = useAtom(
    libraryType ? SORT_ATOM[libraryType] : UNSORTED,
  );
  const folderId =
    source.kind === "collection" ? (source.folderId ?? "root") : undefined;

  const fetchPage = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (offset: number, cursor: string | null): Promise<TvPage<any>> => {
      if (source.kind === "artist") {
        const r = await getArtistViewAll(
          source.artistId,
          source.apiPath,
          offset,
          PAGE,
        );
        return { items: r.items, hasMore: r.hasMore };
      }
      if (userId == null) throw new Error("Not signed in");
      if (source.what === "videos") {
        const items = await getFavoriteVideos(userId, offset, PAGE);
        return { items, hasMore: items.length >= PAGE };
      }
      const page = await fetchLibraryPage(source.what, {
        userId,
        folderId,
        sort,
        offset,
        limit: PAGE,
        cursor,
      });
      return {
        items: page.items,
        hasMore: offset + page.items.length < page.totalNumberOfItems,
        cursor: page.cursor,
      };
    },
    [source, userId, folderId, sort],
  );
  const paged = useTvPaged(
    fetchPage,
    JSON.stringify(source) + `${sort.order}:${sort.direction}`,
  );

  // A filter needs every page: it loads the rest, and again after a re-sort
  // or a retry while it is on.
  const [query, setQuery] = useState("");
  const filtering = libraryType !== null && query !== "";
  const loadingAll = filtering && paged.hasMore && !paged.moreError;
  const { loadAll } = paged;
  useEffect(() => {
    if (filtering && !paged.loading && !paged.moreError) void loadAll();
  }, [filtering, paged.loading, paged.moreError, loadAll]);
  // A playlist filter also searches the playlists inside folders.
  const [flattened, setFlattened] = useState<PlaylistOrFolder[]>([]);
  const flattenedLoaded = useRef(false);
  useEffect(() => {
    if (!filtering || libraryType !== "playlists" || flattenedLoaded.current)
      return;
    flattenedLoaded.current = true;
    getFlattenedPlaylists()
      .then(setFlattened)
      .catch(() => {
        flattenedLoaded.current = false;
      });
  }, [filtering, libraryType]);

  const deletedPlaylistIds = useAtomValue(deletedPlaylistIdsAtom);
  const deletedFolderIds = useAtomValue(deletedFolderIdsAtom);
  const movedPlaylists = useAtomValue(movedPlaylistsAtom);
  const addedToFolder = useAtomValue(addedToFolderAtom);
  const renamedFolders = useAtomValue(renamedFoldersAtom);
  const countAdjustments = useAtomValue(folderCountAdjustmentsAtom);
  const items = paged.items;
  const { entries, tracks } = useMemo(() => {
    if (source.kind === "artist") return sectionEntries(items);
    const what = source.what;
    if (what === "videos") return sectionEntries(items, SECTION_TYPE.videos);
    const listed =
      what === "playlists"
        ? applyLocalPlaylistEdits(items, folderId ?? "root", {
            deletedPlaylistIds,
            deletedFolderIds,
            movedPlaylists,
            addedToFolder,
          })
        : items;
    const shown = filterLibraryItems(what, listed, query, {
      flattened,
      renamedFolders,
    });
    if (what !== "playlists") return sectionEntries(shown, SECTION_TYPE[what]);
    return {
      entries: libraryEntries(shown, renamedFolders, countAdjustments),
      tracks: [],
    };
  }, [
    source,
    items,
    query,
    flattened,
    folderId,
    deletedPlaylistIds,
    deletedFolderIds,
    movedPlaylists,
    addedToFolder,
    renamedFolders,
    countAdjustments,
  ]);

  const rootRef = useRef<HTMLDivElement>(null);
  useTvGrowOnFocus(rootRef, entries.length, filtering ? null : paged.loadMore);

  // After Load more / Try again, focus goes to the first new card once the
  // page is in; when the page added none, back to the button or else to the
  // last card.
  const focusFrom = useRef<number | null>(null);
  const loadMoreFromButton = (retry: boolean) => {
    focusFrom.current = entries.length;
    if (retry) paged.retry();
    else void paged.loadMore();
  };
  useLayoutEffect(() => {
    const from = focusFrom.current;
    const root = rootRef.current;
    if (from === null || paged.loadingMore || !root) return;
    focusFrom.current = null;
    const current = document.activeElement;
    if (current && current !== document.body && current.isConnected) return;
    const next =
      root.querySelector<HTMLElement>(`[data-tv-index="${from}"]`) ??
      root.querySelector<HTMLElement>("[data-tv-more] [data-tv-focusable]") ??
      root.querySelector<HTMLElement>(`[data-tv-index="${from - 1}"]`);
    if (next) focusElement(next);
    else focusFirstIn(root);
  }, [paged.loadingMore, entries]);

  useTvInitialFocus(!paged.loading);

  const sortLabel = libraryType
    ? (SORT_OPTIONS[libraryType].find((o) => o.value === sort.order)?.label ??
      "Date added")
    : "";
  const SortIcon = sort.direction === "ASC" ? ArrowUp : ArrowDown;
  const openSort = () => {
    if (!libraryType) return;
    nav.openMenu(librarySortMenu(libraryType, sort, (s) => setSort(s)));
  };
  const openFilter = async () => {
    if (!libraryType) return;
    const q = await nav.prompt({
      title: "Filter",
      initial: query,
      confirm: "Filter",
      allowEmpty: true,
      placeholder: FILTER_HINT[libraryType],
    });
    if (q !== null) setQuery(q);
  };
  const clearFilter = () => {
    // The Clear button goes away with the filter.
    const b = rootRef.current?.querySelector<HTMLElement>(
      '[aria-label="Filter"]',
    );
    if (b) focusElement(b);
    setQuery("");
  };

  // The header stays while a new sort loads, so focus stays on its button.
  return (
    <div
      ref={rootRef}
      data-tv-loading={paged.loadingMore || loadingAll || undefined}
    >
      <div className="pt-[2.5rem] pb-[3rem]">
        <h1 className="text-[2rem] font-extrabold text-th-text-primary px-[3rem] mb-[1rem]">
          {title}
        </h1>
        {libraryType && (
          <div className="flex items-center gap-[0.7rem] px-[3rem] mb-[1rem]">
            <TvButton
              label={`Sort: ${sortLabel}`}
              icon={<SortIcon className="w-[1rem] h-[1rem]" />}
              onClick={openSort}
            />
            <TvButton
              label="Filter"
              icon={<ListFilter className="w-[1rem] h-[1rem]" />}
              onClick={() => void openFilter()}
            />
            {filtering && (
              <>
                <p className="min-w-0 truncate text-[0.85rem] text-th-text-secondary">
                  Filter: “{query}”
                </p>
                <TvButton
                  label="Clear"
                  icon={<X className="w-[1rem] h-[1rem]" />}
                  onClick={clearFilter}
                />
              </>
            )}
          </div>
        )}
        {paged.error ? (
          <TvError message={paged.error} onRetry={paged.retry} />
        ) : paged.loading ? (
          <TvSpinner screen />
        ) : (
          <>
            {entries.length === 0 ? (
              !loadingAll && (
                <p className="px-[3rem] text-[0.85rem] text-th-text-muted">
                  {filtering
                    ? `Nothing matches “${query}”.`
                    : "Nothing here yet."}
                </p>
              )
            ) : (
              <TvGrid
                entries={entries}
                queueTracks={tracks}
                queueId={`list:${title}`}
                name={title}
                menuContext={folderId != null ? { folderId } : undefined}
                showExplicit={source.kind === "artist"}
                autoFocusFirst={libraryType !== null}
              />
            )}
            {(paged.loadingMore || loadingAll) && (
              <div role="status" aria-label="Loading more">
                <TvSpinner />
              </div>
            )}
            {paged.moreError && (
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
            {/* Reachable when a page adds no cards, so focus never nears the
              end again. A filter loads every page itself. */}
            {paged.hasMore &&
              !filtering &&
              !paged.loadingMore &&
              !paged.moreError && (
                <div data-tv-more className="px-[3rem] py-[1rem]">
                  <TvButton
                    label="Load more"
                    onClick={() => loadMoreFromButton(false)}
                  />
                </div>
              )}
          </>
        )}
      </div>
    </div>
  );
}
