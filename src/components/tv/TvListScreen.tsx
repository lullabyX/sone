import { useCallback } from "react";
import { useAtomValue } from "jotai";
import {
  getAllPlaylists,
  getArtistViewAll,
  getFavoriteAlbums,
  getFavoriteArtists,
  getFavoriteMixes,
  getFavoriteVideos,
} from "../../api/tidal";
import { authTokensAtom } from "../../atoms/auth";
import { useTvInitialFocus } from "./TvNavContext";
import { TvError, TvGrid, TvSpinner } from "./TvParts";
import { sectionEntries, type TvListSource } from "./tvItems";
import { useTvLoader } from "./useTvLoader";

const PAGE = 50;
/** Enough for any real collection; stops a runaway loop on a bad total. */
const MAX_ITEMS = 5000;

const SECTION_TYPE = {
  playlists: "PLAYLIST_LIST",
  albums: "ALBUM_LIST",
  artists: "ARTIST_LIST",
  mixes: "MIX_LIST",
  videos: "VIDEO_LIST",
} as const;

/** One page of a source: its items and whether more follow. */
async function fetchPage(
  source: TvListSource,
  userId: number,
  offset: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ items: any[]; more: boolean }> {
  if (source.kind === "artist") {
    const r = await getArtistViewAll(
      source.artistId,
      source.apiPath,
      offset,
      PAGE,
    );
    return { items: r.items, more: r.hasMore };
  }
  if (source.what === "videos") {
    const items = await getFavoriteVideos(userId, offset, PAGE);
    return { items, more: items.length >= PAGE };
  }
  const page =
    source.what === "playlists"
      ? await getAllPlaylists(userId, offset, PAGE)
      : source.what === "albums"
        ? await getFavoriteAlbums(userId, offset, PAGE)
        : source.what === "artists"
          ? await getFavoriteArtists(userId, offset, PAGE)
          : await getFavoriteMixes(offset, PAGE);
  const total = page.totalNumberOfItems ?? 0;
  return {
    items: page.items,
    more:
      page.items.length > 0 &&
      (total > 0
        ? offset + page.items.length < total
        : page.items.length >= PAGE),
  };
}

/** Every item of a collection row or an artist row, as a grid. All pages
 *  load up front: focus moves through the grid, so there is no scroll
 *  position to trigger loading more. */
export default function TvListScreen({
  title,
  source,
}: {
  title: string;
  source: TvListSource;
}) {
  const userId = useAtomValue(authTokensAtom)?.user_id;
  const load = useCallback(async () => {
    if (userId == null) throw new Error("Not signed in");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: any[] = [];
    for (let offset = 0; offset < MAX_ITEMS; ) {
      const page = await fetchPage(source, userId, offset);
      items.push(...page.items);
      offset += page.items.length;
      if (!page.more) break;
    }
    const type =
      source.kind === "collection" ? SECTION_TYPE[source.what] : undefined;
    return sectionEntries(items, type);
  }, [source, userId]);
  const { data, error, retry } = useTvLoader(load, "Couldn't load this list");

  useTvInitialFocus(data !== null || error !== null);

  if (error) return <TvError message={error} onRetry={retry} />;
  if (!data) return <TvSpinner />;

  return (
    <div className="pt-[2.5rem] pb-[3rem]">
      <h1 className="text-[2rem] font-extrabold text-th-text-primary px-[3rem] mb-[1rem]">
        {title}
      </h1>
      {data.entries.length === 0 ? (
        <p className="px-[3rem] text-[0.85rem] text-th-text-muted">
          Nothing here yet.
        </p>
      ) : (
        <TvGrid
          entries={data.entries}
          queueTracks={data.tracks}
          queueId={`list:${title}`}
          name={title}
        />
      )}
    </div>
  );
}
