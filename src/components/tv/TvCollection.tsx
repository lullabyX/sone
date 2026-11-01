import { useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { useAtomValue } from "jotai";
import { getFavoriteVideos } from "../../api/tidal";
import { authTokensAtom } from "../../atoms/auth";
import {
  albumSortAtom,
  artistSortAtom,
  mixSortAtom,
  playlistSortAtom,
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
import type { PlaylistOrFolder } from "../../types";
import { TvScreenContext, useTvInitialFocus } from "./TvNavContext";
import { TvError, TvRow, TvSpinner } from "./TvParts";
import {
  libraryEntries,
  sectionEntries,
  type TvEntry,
  type TvView,
} from "./tvItems";
import { useTvLoader } from "./useTvLoader";

const ROW_LIMIT = 50;

type What = "playlists" | "albums" | "artists" | "mixes" | "videos";

interface Row<T> {
  items: T[];
  /** The row shows only a first page; more may follow. */
  more: boolean;
}

interface Rows {
  playlists: Row<PlaylistOrFolder>;
  albums: Row<TvEntry>;
  artists: Row<TvEntry>;
  mixes: Row<TvEntry>;
  videos: Row<TvEntry>;
}

const MY_TRACKS: TvEntry = {
  key: "my-tracks",
  title: "My Tracks",
  subtitle: "Your favorite tracks",
  image: "",
  icon: "heart",
  action: { kind: "open", view: { type: "favorites" } },
};

/** The Playlists row lists the top level, as the desktop Sidebar does. */
const ROOT_FOLDER = { folderId: "root" };

function viewAll(
  title: string,
  what: What,
  row: Row<unknown>,
): TvView | undefined {
  return row.more
    ? { type: "list", title, source: { kind: "collection", what } }
    : undefined;
}

export default function TvCollection() {
  const userId = useAtomValue(authTokensAtom)?.user_id;
  // Primitives, so a re-read of the same stored sort doesn't load again.
  const { order: playlistOrder, direction: playlistDir } =
    useAtomValue(playlistSortAtom);
  const { order: albumOrder, direction: albumDir } =
    useAtomValue(albumSortAtom);
  const { order: artistOrder, direction: artistDir } =
    useAtomValue(artistSortAtom);
  const { order: mixOrder, direction: mixDir } = useAtomValue(mixSortAtom);

  const load = useCallback(async (): Promise<Rows> => {
    if (!userId) throw new Error("Not signed in");
    // One failing row (e.g. no mixes endpoint access) leaves the others.
    const first = (
      type: "albums" | "artists" | "mixes",
      order: string,
      direction: string,
    ) =>
      fetchLibraryPage(type, {
        userId,
        sort: { order, direction },
        offset: 0,
        limit: ROW_LIMIT,
      }).catch(() => null);
    const [playlists, albums, artists, mixes, videos] = await Promise.all([
      fetchLibraryPage("playlists", {
        folderId: "root",
        sort: { order: playlistOrder, direction: playlistDir },
        offset: 0,
        limit: ROW_LIMIT,
      }).catch(() => null),
      first("albums", albumOrder, albumDir),
      first("artists", artistOrder, artistDir),
      first("mixes", mixOrder, mixDir),
      getFavoriteVideos(userId, 0, ROW_LIMIT).catch(() => null),
    ]);
    if (!playlists && !albums && !artists && !mixes && !videos) {
      throw new Error("Couldn't load your collection");
    }
    const more = (p: { items: unknown[]; cursor: string | null } | null) =>
      !!p && (p.cursor != null || p.items.length >= ROW_LIMIT);
    const row = (
      p: Awaited<ReturnType<typeof first>>,
      sectionType: string,
    ): Row<TvEntry> => ({
      items: sectionEntries(p?.items ?? [], sectionType).entries,
      more: more(p),
    });
    return {
      playlists: { items: playlists?.items ?? [], more: more(playlists) },
      albums: row(albums, "ALBUM_LIST"),
      artists: row(artists, "ARTIST_LIST"),
      mixes: row(mixes, "MIX_LIST"),
      videos: {
        items: sectionEntries(videos ?? [], "VIDEO_LIST").entries,
        more: (videos?.length ?? 0) >= ROW_LIMIT,
      },
    };
  }, [
    userId,
    playlistOrder,
    playlistDir,
    albumOrder,
    albumDir,
    artistOrder,
    artistDir,
    mixOrder,
    mixDir,
  ]);
  const {
    data: rows,
    error,
    retry,
    refresh,
  } = useTvLoader(load, "Couldn't load your collection");

  const deletedPlaylistIds = useAtomValue(deletedPlaylistIdsAtom);
  const deletedFolderIds = useAtomValue(deletedFolderIdsAtom);
  const movedPlaylists = useAtomValue(movedPlaylistsAtom);
  const addedToFolder = useAtomValue(addedToFolderAtom);
  const renamedFolders = useAtomValue(renamedFoldersAtom);
  const countAdjustments = useAtomValue(folderCountAdjustmentsAtom);
  const playlistItems = rows?.playlists.items;
  const playlists = useMemo(
    () =>
      libraryEntries(
        applyLocalPlaylistEdits(playlistItems ?? [], "root", {
          deletedPlaylistIds,
          deletedFolderIds,
          movedPlaylists,
          addedToFolder,
        }),
        renamedFolders,
        countAdjustments,
      ),
    [
      playlistItems,
      deletedPlaylistIds,
      deletedFolderIds,
      movedPlaylists,
      addedToFolder,
      renamedFolders,
      countAdjustments,
    ],
  );

  // Coming back to the collection (after liking an album, creating or
  // deleting a playlist elsewhere) brings it up to date in the background.
  const { active } = useContext(TvScreenContext);
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) refresh();
    wasActive.current = active;
  }, [active, refresh]);

  useTvInitialFocus(rows !== null || error !== null);

  if (error) return <TvError message={error} onRetry={retry} />;
  if (!rows) return <TvSpinner />;

  return (
    <div className="pt-[2rem] pb-[2rem]">
      <TvRow
        title="Playlists"
        entries={[MY_TRACKS, ...playlists]}
        viewAll={viewAll("Playlists", "playlists", rows.playlists)}
        menuContext={ROOT_FOLDER}
      />
      <TvRow
        title="Albums"
        entries={rows.albums.items}
        viewAll={viewAll("Albums", "albums", rows.albums)}
      />
      <TvRow
        title="Artists"
        entries={rows.artists.items}
        viewAll={viewAll("Artists", "artists", rows.artists)}
      />
      <TvRow
        title="Mixes & Radio"
        entries={rows.mixes.items}
        viewAll={viewAll("Mixes & Radio", "mixes", rows.mixes)}
      />
      <TvRow
        title="Videos"
        entries={rows.videos.items}
        viewAll={viewAll("Videos", "videos", rows.videos)}
      />
    </div>
  );
}
