import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { atom, useAtomValue } from "jotai";
import { getArtistViewAll, getFavoriteVideos } from "../../api/tidal";
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
import {
  applyLocalPlaylistEdits,
  fetchLibraryPage,
} from "../../lib/libraryPages";
import { focusElement } from "../../lib/spatialNav";
import { useTvInitialFocus } from "./TvNavContext";
import { TvButton, TvError, TvGrid, TvSpinner } from "./TvParts";
import { libraryEntries, sectionEntries, type TvListSource } from "./tvItems";
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

/** Every item of a collection row, a playlist folder or an artist row, as a
 *  grid that loads its next page as focus nears the end. */
export default function TvListScreen({
  title,
  source,
}: {
  title: string;
  source: TvListSource;
}) {
  const userId = useAtomValue(authTokensAtom)?.user_id;
  const sort = useAtomValue(
    source.kind === "collection" && source.what !== "videos"
      ? SORT_ATOM[source.what]
      : UNSORTED,
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

  const deletedPlaylistIds = useAtomValue(deletedPlaylistIdsAtom);
  const deletedFolderIds = useAtomValue(deletedFolderIdsAtom);
  const movedPlaylists = useAtomValue(movedPlaylistsAtom);
  const addedToFolder = useAtomValue(addedToFolderAtom);
  const renamedFolders = useAtomValue(renamedFoldersAtom);
  const countAdjustments = useAtomValue(folderCountAdjustmentsAtom);
  const items = paged.items;
  const { entries, tracks } = useMemo(() => {
    if (source.kind === "artist") return sectionEntries(items);
    if (source.what !== "playlists") {
      return sectionEntries(items, SECTION_TYPE[source.what]);
    }
    return {
      entries: libraryEntries(
        applyLocalPlaylistEdits(items, folderId ?? "root", {
          deletedPlaylistIds,
          deletedFolderIds,
          movedPlaylists,
          addedToFolder,
        }),
        renamedFolders,
        countAdjustments,
      ),
      tracks: [],
    };
  }, [
    source,
    items,
    folderId,
    deletedPlaylistIds,
    deletedFolderIds,
    movedPlaylists,
    addedToFolder,
    renamedFolders,
    countAdjustments,
  ]);

  const gridRef = useRef<HTMLDivElement>(null);
  useTvGrowOnFocus(gridRef, entries.length, paged.loadMore);

  // After Load more / Try again, focus goes to the first new card (or back
  // to the button when the page added none) once the page is in.
  const focusFrom = useRef<number | null>(null);
  const loadMoreFromButton = (retry: boolean) => {
    focusFrom.current = entries.length;
    if (retry) paged.retry();
    else void paged.loadMore();
  };
  useLayoutEffect(() => {
    const from = focusFrom.current;
    const root = gridRef.current;
    if (from === null || paged.loadingMore || !root) return;
    focusFrom.current = null;
    const current = document.activeElement;
    if (current && current !== document.body && current.isConnected) return;
    const next =
      root.querySelector<HTMLElement>(`[data-tv-index="${from}"]`) ??
      root.querySelector<HTMLElement>("[data-tv-more] [data-tv-focusable]");
    if (next) focusElement(next);
  }, [paged.loadingMore, entries]);

  useTvInitialFocus(!paged.loading);

  return (
    <div ref={gridRef} data-tv-loading={paged.loadingMore || undefined}>
      {paged.error ? (
        <TvError message={paged.error} onRetry={paged.retry} />
      ) : paged.loading ? (
        <TvSpinner />
      ) : (
        <div className="pt-[2.5rem] pb-[3rem]">
          <h1 className="text-[2rem] font-extrabold text-th-text-primary px-[3rem] mb-[1rem]">
            {title}
          </h1>
          {entries.length === 0 ? (
            <p className="px-[3rem] text-[0.85rem] text-th-text-muted">
              Nothing here yet.
            </p>
          ) : (
            <TvGrid
              entries={entries}
              queueTracks={tracks}
              queueId={`list:${title}`}
              name={title}
              menuContext={folderId != null ? { folderId } : undefined}
              showExplicit={source.kind === "artist"}
            />
          )}
          {paged.loadingMore && (
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
              end again. */}
          {paged.hasMore && !paged.loadingMore && !paged.moreError && (
            <div data-tv-more className="px-[3rem] py-[1rem]">
              <TvButton
                label="Load more"
                onClick={() => loadMoreFromButton(false)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
