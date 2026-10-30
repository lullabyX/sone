import { useCallback, useMemo, useRef } from "react";
import { focusElement } from "../../lib/spatialNav";
import { useAtomValue } from "jotai";
import { Heart, ListX, MoreHorizontal, Play, Shuffle } from "lucide-react";
import {
  getAlbumPage,
  getFavoriteTracks,
  getMixItems,
  getPlaylistDetails,
  getPlaylistTracks,
} from "../../api/tidal";
import { authTokensAtom } from "../../atoms/auth";
import { favoriteTrackIdsAtom } from "../../atoms/favorites";
import { useFavorites } from "../../hooks/useFavorites";
import { usePlaylists } from "../../hooks/usePlaylists";
import { useToast } from "../../contexts/ToastContext";
import {
  FAVORITE_TRACKS_PAGE_SIZE,
  favoriteTracksPager,
  type PlayableSource,
} from "../../lib/trackSources";
import type { AlbumDetail, MediaItemType, Playlist, Track } from "../../types";
import { getTidalImageUrl } from "../../types";
import {
  formatTotalDuration,
  getTrackArtistDisplay,
  playlistCountLabel,
} from "../../utils/itemHelpers";
import { useTvInitialFocus, useTvNav } from "./TvNavContext";
import TidalImage from "../TidalImage";
import { TvButton, TvError, TvSpinner, TvTrackRow } from "./TvParts";
import type { TvView } from "./tvItems";
import { useTvGrowOnFocus } from "./useTvGrowOnFocus";
import { useTvLoader } from "./useTvLoader";
import { useTvPaged } from "./useTvPaged";

/** Cover side in the left column: its full width, unless the text and
 *  buttons below (about 15rem) would then no longer fit under it. */
const COVER_SIZE = "min(100cqw, 100cqh - 15rem)";

type ListView = Extract<
  TvView,
  { type: "album" | "playlist" | "mix" | "favorites" }
>;

interface TrackListSpec {
  kicker: string;
  title: string;
  subtitle?: string;
  image?: string;
  /** Show the liked-tracks heart tile instead of a cover image. */
  heart?: boolean;
  /** The first page, or the whole list when there is no `pager`. */
  first: Track[];
  total: number;
  pager?: NonNullable<PlayableSource["fetchPage"]>;
  /** Rows to show; tracks it rejects stay loaded but hidden. */
  include?: (t: Track) => boolean;
  dedupe?: boolean;
  /** For a first page that reports `hasMore` instead of a total. */
  hasMore?: boolean;
  artist?: { id: number; name: string };
  /** The album / playlist itself, handed to the like call so the
   *  collection shows it straight away (as the desktop pages do). */
  album?: AlbumDetail;
  playlist?: Playlist;
  /** What "Playing from" and the saved queue show, as on the desktop. */
  meta: PlayableSource["meta"];
  albumMode?: boolean;
}

const viewKey = (view: ListView) =>
  view.type === "album"
    ? `album:${view.id}`
    : view.type === "playlist"
      ? `playlist:${view.uuid}`
      : view.type === "mix"
        ? `mix:${view.mixId}`
        : "favorites";

/** Keeps the first of each track id, as the desktop favorites view does. */
function dedupeById(tracks: Track[]): Track[] {
  const seen = new Set<number>();
  return tracks.filter((t) => !seen.has(t.id) && !!seen.add(t.id));
}

async function loadList(
  view: ListView,
  userId?: number,
): Promise<TrackListSpec> {
  switch (view.type) {
    case "album": {
      const { page } = await getAlbumPage(view.id);
      const a = page.album;
      const year = a.releaseDate?.slice(0, 4);
      const artist = a.artist ?? a.artists?.[0];
      const image = getTidalImageUrl(a.cover, 1280);
      return {
        kicker:
          a.albumType === "SINGLE"
            ? "Single"
            : a.albumType === "EP"
              ? "EP"
              : "Album",
        title: a.title,
        subtitle: [getTrackArtistDisplay(a, ""), year]
          .filter(Boolean)
          .join(" · "),
        image,
        first: page.tracks,
        total: page.tracks.length,
        album: a,
        artist: artist ? { id: artist.id, name: artist.name } : undefined,
        meta: { type: "album", id: view.id, name: a.title, image },
        albumMode: true,
      };
    }
    case "playlist": {
      const [details, tracks] = await Promise.all([
        getPlaylistDetails(view.uuid).catch(() => null),
        getPlaylistTracks(view.uuid),
      ]);
      const title = details?.title ?? view.title ?? "Playlist";
      // Playlist images have no 1280px size; 640 is the largest the CDN
      // serves for both square and wide playlist art.
      const image =
        getTidalImageUrl(details?.squareImage ?? details?.image, 640) ||
        view.image;
      const creator = details?.creator?.name
        ? `By ${details.creator.name}`
        : details?.creator?.id === 0
          ? "By TIDAL"
          : undefined;
      return {
        kicker: "Playlist",
        title,
        subtitle: [
          creator,
          playlistCountLabel(details?.numberOfTracks, details?.numberOfVideos),
        ]
          .filter(Boolean)
          .join(" · "),
        image,
        first: tracks,
        total: tracks.length,
        playlist: details ?? undefined,
        meta: { type: "playlist", id: view.uuid, name: title, image },
      };
    }
    case "mix": {
      const mix = await getMixItems(view.mixId);
      const title = mix.title ?? view.title ?? "Mix";
      const image = mix.image ?? view.image;
      return {
        kicker: "Mix",
        title,
        subtitle: mix.subtitle ?? undefined,
        image,
        first: mix.tracks,
        total: mix.tracks.length,
        meta: { type: "mix", id: view.mixId, name: title, image },
      };
    }
    case "favorites": {
      if (!userId) throw new Error("Not signed in");
      // Only the first page here; the rest load as focus nears the end.
      const page = await getFavoriteTracks(
        userId,
        0,
        FAVORITE_TRACKS_PAGE_SIZE,
        "DATE",
        "DESC",
      );
      return {
        kicker: "Collection",
        title: "My Tracks",
        // Shown as the heart tile, as in the collection and on the desktop.
        heart: true,
        first: page.items,
        total: page.totalNumberOfItems,
        pager: favoriteTracksPager(userId, "DATE", "DESC"),
        dedupe: true,
        meta: { type: "favorites", id: "favorites", name: "Loved Tracks" },
      };
    }
  }
}

export default function TvTrackListScreen({ view }: { view: ListView }) {
  const userId = useAtomValue(authTokensAtom)?.user_id;
  const favoriteTrackIds = useAtomValue(favoriteTrackIdsAtom);
  const load = useCallback(() => loadList(view, userId), [view, userId]);
  const { data, error, retry, update } = useTvLoader(
    load,
    "Couldn't load tracks",
  );
  // Attached here rather than in the loader, so a like change re-filters
  // the rows without loading again.
  const spec = useMemo(
    () =>
      data && view.type === "favorites"
        ? { ...data, include: (t: Track) => favoriteTrackIds.has(t.id) }
        : data,
    [data, view.type, favoriteTrackIds],
  );

  useTvInitialFocus(data !== null || error !== null);

  if (error) return <TvError message={error} onRetry={retry} />;
  if (!spec) return <TvSpinner />;
  // The list's near-end detector needs its root at mount, so the page is
  // its own component, mounted once the spec has loaded.
  return (
    <TrackListPage view={view} spec={spec} userId={userId} update={update} />
  );
}

function TrackListPage({
  view,
  spec,
  userId,
  update,
}: {
  view: ListView;
  spec: TrackListSpec;
  userId?: number;
  update: (change: (spec: TrackListSpec) => TrackListSpec) => void;
}) {
  const nav = useTvNav();
  const fav = useFavorites();
  const { removeTrackFromPlaylist } = usePlaylists();
  const listRef = useRef<HTMLDivElement>(null);
  const { showToast } = useToast();

  const paged = useTvPaged(spec.pager ?? null, viewKey(view), {
    items: spec.first,
    hasMore: !!spec.pager && (spec.hasMore ?? spec.first.length < spec.total),
  });
  const rows = useMemo(
    () =>
      spec.include
        ? dedupeById(paged.items).filter(spec.include)
        : spec.dedupe
          ? dedupeById(paged.items)
          : paged.items,
    [paged.items, spec.include, spec.dedupe],
  );
  useTvGrowOnFocus(listRef, rows.length, spec.pager ? paged.loadMore : null);

  const playable = (): PlayableSource =>
    spec.pager
      ? {
          meta: spec.meta,
          loaded: paged.items,
          fetchPage: spec.pager,
          nextOffset: paged.offset,
          hasMore: paged.hasMore,
          include: spec.include,
        }
      : { meta: spec.meta, loaded: paged.items, albumMode: spec.albumMode };
  const media: MediaItemType | null =
    view.type === "album"
      ? { type: "album", id: view.id, title: spec.title, cover: spec.image }
      : view.type === "playlist"
        ? {
            type: "playlist",
            uuid: view.uuid,
            title: spec.title,
            image: spec.image,
          }
        : view.type === "mix"
          ? {
              type: "mix",
              mixId: view.mixId,
              title: spec.title,
              image: spec.image,
            }
          : null;
  const liked =
    view.type === "album"
      ? fav.favoriteAlbumIds.has(view.id)
      : view.type === "playlist"
        ? fav.favoritePlaylistUuids.has(view.uuid)
        : view.type === "mix"
          ? fav.favoriteMixIds.has(view.mixId)
          : false;
  const toggleLike = () => {
    const run =
      view.type === "album"
        ? liked
          ? fav.removeFavoriteAlbum(view.id)
          : fav.addFavoriteAlbum(view.id, spec.album)
        : view.type === "playlist"
          ? liked
            ? fav.removeFavoritePlaylist(view.uuid)
            : fav.addFavoritePlaylist(view.uuid, spec.playlist)
          : view.type === "mix"
            ? liked
              ? fav.removeFavoriteMix(view.mixId)
              : fav.addFavoriteMix(view.mixId, {
                  id: view.mixId,
                  title: spec.title,
                  subTitle: spec.subtitle ?? "",
                  images: spec.image
                    ? {
                        SMALL: { url: spec.image },
                        MEDIUM: { url: spec.image },
                      }
                    : undefined,
                })
            : null;
    run?.catch(() => {});
  };
  // Same rule as the desktop: only the user's own playlists are editable.
  const ownPlaylist =
    view.type === "playlist" &&
    userId != null &&
    spec.playlist?.creator?.id === userId;
  const removeFromPlaylist = async (index: number) => {
    if (view.type !== "playlist") return;
    const track = rows[index];
    try {
      await removeTrackFromPlaylist(view.uuid, index);
      update((d) => ({
        ...d,
        first: d.first.filter((_, i) => i !== index),
        total: d.total - 1,
      }));
      // The removed row had focus: move it to the row that took its place
      // (or the new last one), once the menu has closed and the list has
      // re-rendered. Rows are found by position: blocked rows have no menu,
      // so counting menus would skip them.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const list = listRef.current;
          if (!list) return;
          const rowCount = list.querySelectorAll("[data-tv-index]").length;
          const next = list
            .querySelector(`[data-tv-index="${Math.min(index, rowCount - 1)}"]`)
            ?.querySelector<HTMLElement>("[data-tv-focusable]");
          if (next) focusElement(next);
        }),
      );
      showToast(`Removed "${track?.title ?? "track"}" from playlist`);
    } catch {
      showToast("Failed to remove track", "error");
    }
  };

  // A paged list's loaded rows are not the whole list, so it shows its
  // track count instead of a running time.
  const totalSecs = spec.pager
    ? 0
    : rows.reduce((s, t) => s + (t.duration ?? 0), 0);
  const count = spec.total - (paged.items.length - rows.length);

  // Same as the desktop pages: Play follows the shuffle setting, Shuffle is
  // a one-off shuffled run that leaves the setting alone.
  const playAll = () => void nav.playSource(playable());
  const shufflePlay = () => void nav.playSource(playable(), { shuffle: true });

  const subtitle = [
    view.type === "favorites" ? `${count} tracks` : spec.subtitle,
    totalSecs > 0 ? formatTotalDuration(totalSecs) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  // Cover, title and actions stay in a column on the left while the tracks
  // scroll on the right, so a wide TV screen is not mostly empty. The column
  // is a side panel for the spatial navigation: Left from any track reaches
  // it (landing on the button used last), Right goes back to the tracks.
  return (
    <div className="flex h-full">
      <aside
        data-tv-side
        data-tv-remember
        className="w-[32rem] shrink-0 h-full overflow-hidden flex flex-col justify-center pl-[3rem] pr-[1.5rem] py-[1.5rem]"
        style={{ containerType: "size" }}
      >
        <div
          className="aspect-square shrink-0 overflow-hidden rounded-[0.8rem] bg-th-surface shadow-2xl"
          style={{ width: COVER_SIZE }}
        >
          {spec.heart ? (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-th-accent to-th-surface">
              <Heart
                className="w-[38%] h-[38%] text-white"
                fill="currentColor"
              />
            </div>
          ) : (
            <TidalImage
              src={spec.image || undefined}
              alt={spec.title}
              type="album"
              className="w-full h-full"
            />
          )}
        </div>
        {spec.kicker && (
          <p className="mt-[1.4rem] text-[0.75rem] font-bold uppercase tracking-[0.15em] text-th-text-muted">
            {spec.kicker}
          </p>
        )}
        <h1 className="text-[1.8rem] font-extrabold leading-tight text-th-text-primary line-clamp-2">
          {spec.title}
        </h1>
        {subtitle && (
          <p className="mt-[0.3rem] text-[0.8rem] text-th-text-secondary line-clamp-2">
            {subtitle}
          </p>
        )}
        {/* Play and Shuffle share the first line, the smaller actions the
            second, so nothing wraps awkwardly in the narrow column. */}
        <div
          className="mt-[1.2rem] grid grid-cols-2 gap-[0.7rem]"
          style={{ width: COVER_SIZE }}
        >
          <TvButton
            primary
            autoFocus
            icon={<Play className="w-[1rem] h-[1rem]" fill="currentColor" />}
            label="Play"
            onClick={playAll}
          />
          <TvButton
            icon={<Shuffle className="w-[1rem] h-[1rem]" />}
            label="Shuffle"
            onClick={shufflePlay}
          />
        </div>
        <div className="mt-[0.8rem] flex flex-wrap gap-[0.7rem]">
          {media && (
            <TvButton
              title={liked ? "Remove from collection" : "Add to collection"}
              active={liked}
              icon={
                <Heart
                  className="w-[1rem] h-[1rem]"
                  fill={liked ? "currentColor" : "none"}
                />
              }
              onClick={toggleLike}
            />
          )}
          {media && (
            <TvButton
              title="More options"
              icon={<MoreHorizontal className="w-[1rem] h-[1rem]" />}
              onClick={() => nav.openMenu(nav.mediaMenu(media, true))}
            />
          )}
          {spec.artist && (
            <TvButton
              label={spec.artist.name}
              title={`Go to ${spec.artist.name}`}
              onClick={() =>
                nav.push({
                  type: "artist",
                  id: spec.artist!.id,
                  name: spec.artist!.name,
                })
              }
            />
          )}
        </div>
      </aside>
      <div
        ref={listRef}
        data-tv-remember
        data-tv-scroll-root
        data-tv-loading={paged.loadingMore || undefined}
        className="tv-scroll flex-1 min-w-0 h-full overflow-y-auto pl-[0.5rem] pr-[2rem] pt-[2.5rem] pb-[3rem]"
      >
        {rows.length === 0 ? (
          <p className="px-[1rem] text-[0.85rem] text-th-text-muted">
            No tracks here yet.
          </p>
        ) : (
          rows.map((track, i) => (
            <TvTrackRow
              key={`${track.id}:${i}`}
              track={track}
              index={i}
              entry={i === 0}
              menuExtra={
                ownPlaylist
                  ? [
                      {
                        label: "Remove from this playlist",
                        icon: ListX,
                        onSelect: () => removeFromPlaylist(i),
                      },
                    ]
                  : undefined
              }
              showCover={view.type !== "album"}
              blockedNoMenu
              onSelect={() =>
                void nav.playSource(playable(), { startAt: track })
              }
            />
          ))
        )}
        {paged.loadingMore && (
          <p className="px-[1rem] py-[1rem] text-[0.85rem] text-th-text-muted">
            Loading…
          </p>
        )}
        {paged.moreError && (
          <div className="flex items-center gap-[1rem] px-[1rem] py-[1rem]">
            <p className="text-[0.85rem] text-th-text-secondary">
              Couldn't load more
            </p>
            <TvButton label="Try again" onClick={paged.retry} />
          </div>
        )}
      </div>
    </div>
  );
}
