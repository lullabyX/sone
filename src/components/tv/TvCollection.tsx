import { useCallback, useContext, useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import {
  getAllPlaylists,
  getFavoriteAlbums,
  getFavoriteArtists,
  getFavoriteMixes,
  getFavoriteVideos,
} from "../../api/tidal";
import { authTokensAtom } from "../../atoms/auth";
import { TvScreenContext, useTvInitialFocus } from "./TvNavContext";
import { TvError, TvRow, TvSpinner } from "./TvParts";
import { sectionEntries, type TvEntry, type TvView } from "./tvItems";
import { useTvLoader } from "./useTvLoader";

const ROW_LIMIT = 50;

interface Rows {
  playlists: TvEntry[];
  albums: TvEntry[];
  artists: TvEntry[];
  mixes: TvEntry[];
  videos: TvEntry[];
}

const MY_TRACKS: TvEntry = {
  key: "my-tracks",
  title: "My Tracks",
  subtitle: "Your favorite tracks",
  image: "",
  icon: "heart",
  action: { kind: "open", view: { type: "favorites" } },
};

/** A row's "View all", when the row shows a full first page (so more may
 *  follow). */
function viewAll(
  title: string,
  what: "playlists" | "albums" | "artists" | "mixes" | "videos",
  entries: TvEntry[],
): TvView | undefined {
  return entries.length >= ROW_LIMIT
    ? { type: "list", title, source: { kind: "collection", what } }
    : undefined;
}

export default function TvCollection() {
  const userId = useAtomValue(authTokensAtom)?.user_id;
  const load = useCallback(async (): Promise<Rows> => {
    if (!userId) throw new Error("Not signed in");
    // One failing row (e.g. no mixes endpoint access) leaves the others.
    const settle = <T,>(p: Promise<{ items: T[] }>) =>
      p.then((r) => r.items).catch(() => null);
    const [playlists, albums, artists, mixes, videos] = await Promise.all([
      settle(getAllPlaylists(userId, 0, ROW_LIMIT)),
      settle(getFavoriteAlbums(userId, 0, ROW_LIMIT)),
      settle(getFavoriteArtists(userId, 0, ROW_LIMIT)),
      settle(getFavoriteMixes(0, ROW_LIMIT)),
      getFavoriteVideos(userId, 0, ROW_LIMIT).catch(() => null),
    ]);
    if (!playlists && !albums && !artists && !mixes && !videos) {
      throw new Error("Couldn't load your collection");
    }
    return {
      playlists: sectionEntries(playlists ?? [], "PLAYLIST_LIST").entries,
      albums: sectionEntries(albums ?? [], "ALBUM_LIST").entries,
      artists: sectionEntries(artists ?? [], "ARTIST_LIST").entries,
      mixes: sectionEntries(mixes ?? [], "MIX_LIST").entries,
      videos: sectionEntries(videos ?? [], "VIDEO_LIST").entries,
    };
  }, [userId]);
  const {
    data: rows,
    error,
    retry,
    refresh,
  } = useTvLoader(load, "Couldn't load your collection");

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
        entries={[MY_TRACKS, ...rows.playlists]}
        viewAll={viewAll("Playlists", "playlists", rows.playlists)}
      />
      <TvRow
        title="Albums"
        entries={rows.albums}
        viewAll={viewAll("Albums", "albums", rows.albums)}
      />
      <TvRow
        title="Artists"
        entries={rows.artists}
        viewAll={viewAll("Artists", "artists", rows.artists)}
      />
      <TvRow
        title="Mixes & Radio"
        entries={rows.mixes}
        viewAll={viewAll("Mixes & Radio", "mixes", rows.mixes)}
      />
      <TvRow
        title="Videos"
        entries={rows.videos}
        viewAll={viewAll("Videos", "videos", rows.videos)}
      />
    </div>
  );
}
