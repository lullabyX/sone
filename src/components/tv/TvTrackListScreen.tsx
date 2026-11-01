import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { focusElement } from "../../lib/spatialNav";
import { useAtomValue, useSetAtom } from "jotai";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Heart,
  Info,
  ListFilter,
  ListPlus,
  ListX,
  MoreHorizontal,
  Play,
  RefreshCw,
  Shuffle,
  X,
} from "lucide-react";
import {
  getAlbumPage,
  getArtistTopTracksAll,
  getFavoriteTracks,
  getMixItems,
  getPlaylistDetails,
  getPlaylistTracksPage,
} from "../../api/tidal";
import { authTokensAtom } from "../../atoms/auth";
import { allPlaylistsAtom } from "../../atoms/playlists";
import {
  favoriteTrackIdsAtom,
  trackSortPrefsAtom,
  type SortOrder,
} from "../../atoms/favorites";
import { useFavorites } from "../../hooks/useFavorites";
import { usePlaylistRecommendations } from "../../hooks/usePlaylistRecommendations";
import { usePlaylists } from "../../hooks/usePlaylists";
import { useToast } from "../../contexts/ToastContext";
import {
  ARTIST_TRACKS_PAGE_SIZE,
  artistTopTracksPager,
  FAVORITE_TRACKS_PAGE_SIZE,
  favoriteTracksPager,
  PLAYLIST_PAGE_SIZE,
  playlistTracksPager,
  type PlayableSource,
} from "../../lib/trackSources";
import type { AlbumDetail, MediaItemType, Playlist, Track } from "../../types";
import { getTidalImageUrl } from "../../types";
import {
  formatTotalDuration,
  getTrackArtistDisplay,
  playlistCountLabel,
} from "../../utils/itemHelpers";
import { TvScreenContext, useTvInitialFocus, useTvNav } from "./TvNavContext";
import TidalImage from "../TidalImage";
import { TvButton, TvError, TvSpinner, TvTrackRow } from "./TvParts";
import { groupByVolume, type TvView } from "./tvItems";
import {
  playlistBusy,
  playlistRevision,
  playlistSettled,
  queuePlaylistEdit,
  usePlaylistBusy,
} from "./tvPlaylistEdits";
import { useTvGrowOnFocus } from "./useTvGrowOnFocus";
import { useTvLoader } from "./useTvLoader";
import { useTvPaged } from "./useTvPaged";
import { useTvProgressive } from "./useTvProgressive";
import {
  FAVORITES_TRACK_SORT,
  TRACK_SORT_OPTIONS,
  trackSortMenu,
} from "./tvSort";

/** Cover side in the left column: its full width, unless the text and
 *  buttons below (about 15rem) would then no longer fit under it. */
const COVER_SIZE = "min(100cqw, 100cqh - 15rem)";
/** The same with room for a three-line description. */
const COVER_SIZE_DESCRIBED = "min(100cqw, 100cqh - 19rem)";
/** Longer descriptions get "About", as the desktop's "Read more". */
const LONG_DESCRIPTION = 120;

const PLAYLIST_CHANGED = "This playlist changed — reloading";

function descriptionParagraphs(s: string): string[] {
  return s
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

type ListView = Extract<
  TvView,
  { type: "album" | "playlist" | "mix" | "favorites" | "artistTracks" }
>;

interface TrackListSpec {
  kicker: string;
  title: string;
  subtitle?: string;
  description?: string;
  image?: string;
  /** Show the liked-tracks heart tile instead of a cover image. */
  heart?: boolean;
  /** The first page, or the whole list when there is no `pager`. */
  first: Track[];
  total: number;
  pager?: NonNullable<PlayableSource["fetchPage"]>;
  /** Rows to show; tracks it rejects stay loaded but hidden. */
  include?: (t: Track) => boolean;
  /** Drop repeated track ids from the rows and from what plays (rows with
   *  `include` are always deduped; they play as loaded, as on the desktop). */
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
  /** The stored sort the rows were loaded in (null: the list's own order). */
  sort?: SortOrder | null;
  /** The playlist's revision (tvPlaylistEdits) the rows were loaded at. */
  revision?: number;
}

const viewKey = (view: ListView) =>
  view.type === "album"
    ? `album:${view.id}`
    : view.type === "playlist"
      ? `playlist:${view.uuid}`
      : view.type === "mix"
        ? `mix:${view.mixId}`
        : view.type === "artistTracks"
          ? `artistTracks:${view.artistId}`
          : "favorites";

/** The list's key in the sort prefs the desktop pages share. */
const sortKeyOf = (view: ListView) =>
  view.type === "playlist"
    ? view.uuid
    : view.type === "favorites"
      ? "__favorites__"
      : null;

/** Keeps the first of each track id, as the desktop favorites view does. */
function dedupeById(tracks: Track[]): Track[] {
  const seen = new Set<number>();
  return tracks.filter((t) => !seen.has(t.id) && !!seen.add(t.id));
}

/** The desktop favorites filter: title, artist or album contains `q`
 *  (already lower-cased). */
function matchesTrack(t: Track, q: string): boolean {
  return (
    t.title.toLowerCase().includes(q) ||
    !!t.artist?.name?.toLowerCase().includes(q) ||
    !!t.artists?.some((a) => a.name?.toLowerCase().includes(q)) ||
    !!t.album?.title?.toLowerCase().includes(q)
  );
}

async function loadList(
  view: ListView,
  userId: number | undefined,
  sort: SortOrder | null,
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
      // Writes still on their way (from an earlier visit, say) land first,
      // so the rows match the server.
      await playlistSettled(view.uuid);
      const revision = playlistRevision(view.uuid);
      // Only the first page here; the rest load as focus nears the end.
      const [details, page] = await Promise.all([
        getPlaylistDetails(view.uuid).catch(() => null),
        getPlaylistTracksPage(
          view.uuid,
          0,
          PLAYLIST_PAGE_SIZE,
          sort?.order,
          sort?.direction,
        ),
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
        // The track count follows removals, so the page adds it.
        subtitle: creator,
        description: details?.description?.trim() || undefined,
        image,
        first: page.items,
        total: page.totalNumberOfItems,
        pager: playlistTracksPager(view.uuid, sort?.order, sort?.direction),
        playlist: details ?? undefined,
        sort,
        revision,
        meta: { type: "playlist", id: view.uuid, name: title, image },
      };
    }
    case "mix": {
      const mix = await getMixItems(view.mixId);
      // As the desktop MixPage: a track radio plays as "radio".
      const mixType = view.mixType ?? mix.mixType ?? undefined;
      const isTrackRadio = mixType === "TRACK_MIX";
      const title = mix.title ?? view.title ?? "Mix";
      const image = mix.image ?? view.image;
      const seed = isTrackRadio
        ? (view.artist ?? mix.tracks[0]?.artists?.[0] ?? mix.tracks[0]?.artist)
        : undefined;
      return {
        kicker: isTrackRadio ? "Track Radio" : "Mix",
        title,
        subtitle: mix.subtitle ?? undefined,
        image,
        first: mix.tracks,
        total: mix.tracks.length,
        artist: seed ? { id: seed.id, name: seed.name } : undefined,
        meta: {
          type: isTrackRadio ? "radio" : "mix",
          id: view.mixId,
          name: title,
          image,
          mixType,
        },
      };
    }
    case "favorites": {
      if (!userId) throw new Error("Not signed in");
      // Only the first page here; the rest load as focus nears the end.
      const { order, direction } = sort ?? FAVORITES_TRACK_SORT;
      const page = await getFavoriteTracks(
        userId,
        0,
        FAVORITE_TRACKS_PAGE_SIZE,
        order,
        direction,
      );
      return {
        kicker: "Collection",
        title: "My Tracks",
        // Shown as the heart tile, as in the collection and on the desktop.
        heart: true,
        first: page.items,
        total: page.totalNumberOfItems,
        pager: favoriteTracksPager(userId, order, direction),
        sort,
        meta: { type: "favorites", id: "favorites", name: "Loved Tracks" },
      };
    }
    case "artistTracks": {
      const page = await getArtistTopTracksAll(
        view.artistId,
        0,
        ARTIST_TRACKS_PAGE_SIZE,
      );
      return {
        kicker: "Artist",
        title: `${view.name}: Top tracks`,
        first: page.items,
        // The endpoint reports no total, so no track count is shown.
        total: page.items.length,
        hasMore: page.hasMore,
        pager: artistTopTracksPager(view.artistId),
        // Its pages can overlap, as on the desktop ArtistTracksPage.
        dedupe: true,
        meta: { type: "artist-tracks", id: view.artistId, name: view.name },
      };
    }
  }
}

/** `list` with the stored entry for `uuid` (if any) taking the name and
 *  description of its freshly loaded details. */
function refreshListed(
  list: Playlist[],
  uuid: string,
  fresh: Playlist,
): Playlist[] {
  const at = list.findIndex((p) => p.uuid === uuid);
  if (at < 0) return list;
  const p = list[at];
  const title = fresh.title || p.title;
  const description = fresh.description ?? "";
  if (title === p.title && description === p.description) return list;
  const next = list.slice();
  next[at] = { ...p, title, description };
  return next;
}

export default function TvTrackListScreen({ view }: { view: ListView }) {
  const userId = useAtomValue(authTokensAtom)?.user_id;
  const favoriteTrackIds = useAtomValue(favoriteTrackIdsAtom);
  const sortKey = sortKeyOf(view);
  const sortPrefs = useAtomValue(trackSortPrefsAtom);
  const saved = sortKey ? sortPrefs[sortKey] : undefined;
  // Kept by value, so storage re-reads of the same prefs don't reload.
  const sortOrder = saved?.order;
  const sortDir = saved?.direction;
  const sort = useMemo(
    () =>
      sortOrder && sortDir ? { order: sortOrder, direction: sortDir } : null,
    [sortOrder, sortDir],
  );
  const setAllPlaylists = useSetAtom(allPlaylistsAtom);
  const load = useCallback(async () => {
    const list = await loadList(view, userId, sort);
    // The stored playlists were loaded once; these details are newer (an
    // edit made on another device), so their name and description replace
    // the stored ones before the page shows.
    const fresh = list.playlist;
    if (view.type === "playlist" && fresh) {
      setAllPlaylists((prev) => refreshListed(prev, view.uuid, fresh));
    }
    return list;
  }, [view, userId, sort, setAllPlaylists]);
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

  // Loads again in the background, keeping the page (and focus) until the
  // new list arrives; a failure shows the error screen. One at a time: a
  // list that changes again meanwhile is caught by its revision.
  const reloading = useRef(false);
  const reload = useCallback(() => {
    if (reloading.current) return;
    reloading.current = true;
    load()
      .then((d) => update(() => d), retry)
      .finally(() => {
        reloading.current = false;
      });
  }, [load, update, retry]);

  useTvInitialFocus(data !== null || error !== null);

  if (error) return <TvError message={error} onRetry={retry} />;
  if (!spec) return <TvSpinner />;
  // The list's near-end detector needs its root at mount, so the page is
  // its own component, mounted once the spec has loaded.
  return (
    <TrackListPage
      view={view}
      spec={spec}
      userId={userId}
      sort={sort}
      reload={reload}
    />
  );
}

function TrackListPage({
  view,
  spec,
  userId,
  sort,
  reload,
}: {
  view: ListView;
  spec: TrackListSpec;
  userId?: number;
  /** The stored sort; the rows still show `spec.sort` until it reloads. */
  sort: SortOrder | null;
  reload: () => void;
}) {
  const nav = useTvNav();
  const fav = useFavorites();
  const { addTrackToPlaylist, removeTrackFromPlaylist } = usePlaylists();
  const recs = usePlaylistRecommendations(
    view.type === "playlist" ? view.uuid : "",
  );
  const listRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const { showToast } = useToast();
  const { active } = useContext(TvScreenContext);
  // A playlist's writes are shared by every page and menu (tvPlaylistEdits).
  // Removals go out one at a time, each sending the row's position at the
  // moment it is chosen; that is only right while these rows are the
  // playlist as the server will have it. They are while its revision is the
  // one they loaded at plus this page's own removals: any other write (from
  // another page, a menu, a failure) makes the page reload before it
  // removes anything.
  const uuid = view.type === "playlist" ? view.uuid : "";
  const busy = usePlaylistBusy(uuid);
  const rowsRevision = useRef(spec.revision);
  useLayoutEffect(() => {
    rowsRevision.current = spec.revision;
  }, [spec]);
  const outdated = () =>
    uuid !== "" && playlistRevision(uuid) !== rowsRevision.current;
  const reloadChanged = useCallback(() => {
    showToast(PLAYLIST_CHANGED);
    reload();
  }, [showToast, reload]);
  useEffect(() => {
    if (active && uuid && playlistRevision(uuid) !== rowsRevision.current) {
      reloadChanged();
    }
  }, [active, uuid, reloadChanged]);
  const [countDelta, setCountDelta] = useState(0);
  const [countSpec, setCountSpec] = useState(spec);
  if (countSpec !== spec) {
    setCountSpec(spec);
    setCountDelta(0);
  }

  const pagedKey = spec.sort
    ? `${viewKey(view)}:${spec.sort.order}:${spec.sort.direction}`
    : viewKey(view);
  const paged = useTvPaged(spec.pager ?? null, pagedKey, {
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
  // A filter needs every page: it loads the rest and keeps loading after a
  // retry or a re-sort while it is on.
  const [query, setQuery] = useState("");
  const filtering = query !== "";
  const loadingAll = filtering && paged.hasMore && !paged.moreError;
  const { loadAll } = paged;
  useEffect(() => {
    if (filtering && !paged.moreError) void loadAll();
  }, [filtering, paged.moreError, loadAll, pagedKey, spec.first]);
  // Filtered rows keep their number in the whole list.
  const listed = useMemo(() => {
    const q = query.toLowerCase();
    const all = rows.map((track, pos) => ({ track, pos }));
    return q ? all.filter(({ track }) => matchesTrack(track, q)) : all;
  }, [rows, query]);
  // A multi-disc album lists each disc under its own heading, numbered from
  // 1; `start` is the flat position of the disc's first row.
  const discs = useMemo(() => {
    if (view.type !== "album") return null;
    const groups = groupByVolume(rows);
    if (groups.size < 2) return null;
    let start = 0;
    return [...groups].map(([vol, tracks]) => {
      const disc = { vol, tracks, start };
      start += tracks.length;
      return disc;
    });
  }, [view.type, rows]);
  // A complete list (album, mix) renders in chunks as focus moves down.
  const win = useTvProgressive(spec.pager ? 0 : rows.length, {
    initial: 60,
    step: 60,
  });
  const shown = spec.pager ? Infinity : win.shown;
  const shownDiscs = discs?.filter((d) => d.start < shown);
  // No new page while writes are in flight: their offsets would shift
  // under the fetch.
  const grow = spec.pager ? (busy ? null : paged.loadMore) : win.grow;
  useTvGrowOnFocus(
    listRef,
    spec.pager ? listed.length : win.shown,
    filtering ? null : grow,
  );

  const playable = (): PlayableSource =>
    spec.pager
      ? {
          meta: spec.meta,
          loaded: paged.items,
          fetchPage: spec.pager,
          nextOffset: paged.offset,
          hasMore: paged.hasMore,
          include: spec.include,
          dedupe: spec.dedupe,
        }
      : { meta: spec.meta, loaded: paged.items, albumMode: spec.albumMode };
  // A name or description edited from "Edit details" shows here at once.
  const listedPlaylist = useAtomValue(allPlaylistsAtom).find(
    (p) => view.type === "playlist" && p.uuid === view.uuid,
  );
  const title = listedPlaylist?.title || spec.title;
  const media: MediaItemType | null =
    view.type === "album"
      ? { type: "album", id: view.id, title, cover: spec.image }
      : view.type === "playlist"
        ? {
            type: "playlist",
            uuid: view.uuid,
            title,
            image: spec.image,
          }
        : view.type === "mix"
          ? {
              type: "mix",
              mixId: view.mixId,
              title,
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
                  title,
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
  // Removal sends the row's position in the playlist's own order, which a
  // sorted list does not show.
  const canRemove = ownPlaylist && !sort && !spec.sort;
  const setSortPrefs = useSetAtom(trackSortPrefsAtom);
  const sortKey = sortKeyOf(view);
  const shownSort =
    view.type === "favorites" ? (sort ?? FAVORITES_TRACK_SORT) : sort;
  const sortLabel = TRACK_SORT_OPTIONS.find(
    (o) => o.value === (shownSort?.order ?? null),
  )?.label;
  const SortIcon = !shownSort
    ? ArrowUpDown
    : shownSort.direction === "ASC"
      ? ArrowUp
      : ArrowDown;
  // A re-sorted list loads from the server, where removals still in flight
  // have not landed yet; its rows' positions would then be off.
  const removalsPending = () => {
    if (!uuid || !playlistBusy(uuid)) return false;
    showToast("Wait for removals to finish");
    return true;
  };
  const openSort = () => {
    if (!sortKey || removalsPending()) return;
    nav.openMenu(
      trackSortMenu({
        current: sort,
        own: ownPlaylist,
        favorites: view.type === "favorites",
        onPick: (s) => {
          if (removalsPending()) return;
          setSortPrefs((prev) => {
            const next = { ...prev };
            if (s) next[sortKey] = s;
            else delete next[sortKey];
            return next;
          });
        },
      }),
    );
  };
  const openFilter = async () => {
    const q = await nav.prompt({
      title: "Filter My Tracks",
      initial: query,
      confirm: "Filter",
      allowEmpty: true,
      placeholder: "Title, artist or album",
    });
    if (q !== null) setQuery(q);
  };
  const clearFilter = () => {
    setQuery("");
    // The Clear button goes away with the filter.
    requestAnimationFrame(() => {
      const b = sideRef.current?.querySelector<HTMLElement>(
        '[aria-label="Filter"]',
      );
      if (b) focusElement(b);
    });
  };
  // The button goes away while the page loads: focus then moves to the
  // first new row, or back to the button when the page added none, once
  // the page is in.
  const focusFrom = useRef<number | null>(null);
  const loadMore = () => {
    if (removalsPending()) return;
    focusFrom.current = listed.length;
    void paged.loadMore();
  };
  useLayoutEffect(() => {
    const from = focusFrom.current;
    const list = listRef.current;
    if (from === null || paged.loadingMore || !list) return;
    focusFrom.current = null;
    const current = document.activeElement;
    if (current && current !== document.body && current.isConnected) return;
    const next =
      list
        .querySelector(`[data-tv-index="${from}"]`)
        ?.querySelector<HTMLElement>("[data-tv-focusable]") ??
      list.querySelector<HTMLElement>('[aria-label="Load more"]');
    if (next) focusElement(next);
  }, [paged.loadingMore, listed]);
  // The row at `idx` went away while it had focus: move focus to the row
  // that took its place (or the new last one), once the menu has closed and
  // the list has re-rendered. Rows are found by position: blocked rows have
  // no menu, so counting menus would skip them.
  const refocusRowAt = (idx: number) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const list = listRef.current;
        if (!list) return;
        const rowCount = list.querySelectorAll("[data-tv-index]").length;
        const next = list
          .querySelector(`[data-tv-index="${Math.min(idx, rowCount - 1)}"]`)
          ?.querySelector<HTMLElement>("[data-tv-focusable]");
        if (next) focusElement(next);
      }),
    );
  const removeFromPlaylist = (track: Track) => {
    if (!uuid) return;
    if (outdated()) {
      reloadChanged();
      return;
    }
    // Found by identity in the list as it is now, so an earlier removal
    // still in flight cannot shift it onto the wrong row.
    const idx = paged.remove(track);
    if (idx < 0) return;
    setCountDelta((d) => d - 1);
    queuePlaylistEdit(uuid, () => removeTrackFromPlaylist(uuid, idx), {
      positional: true,
    }).then(
      (sent) => {
        if (sent) showToast(`Removed "${track.title}" from playlist`);
      },
      () => {
        showToast("Failed to remove track", "error");
        reload();
      },
    );
    // This page's own removal: its rows already show it.
    rowsRevision.current = playlistRevision(uuid);
    refocusRowAt(idx);
  };
  // The added track is not among the rows (where the server puts it is not
  // assumed), so the next removal reloads first.
  const addRecommendation = async (track: Track, position: number) => {
    if (!uuid) return;
    recs.removeLocal(track.id);
    refocusRowAt(position);
    try {
      await queuePlaylistEdit(uuid, () => addTrackToPlaylist(uuid, track.id));
      setCountDelta((d) => d + 1);
      showToast(`Added "${track.title}" to playlist`);
    } catch {
      recs.restore(track);
      showToast("Failed to add track", "error");
    }
  };
  // As the desktop: once every row has loaded, and only under some rows.
  const showRecs =
    view.type === "playlist" &&
    !paged.hasMore &&
    rows.length > 0 &&
    recs.visible.length > 0;
  const refreshRecs = () => {
    if (!recs.loading) void recs.refresh();
  };
  // A refresh that comes back empty takes the section (and the focused
  // Refresh button) away: focus goes to the last row, or Play.
  const hadRecs = useRef(showRecs);
  useLayoutEffect(() => {
    const had = hadRecs.current;
    hadRecs.current = showRecs;
    if (!had || showRecs) return;
    const current = document.activeElement;
    if (current && current !== document.body && current.isConnected) return;
    const next =
      listRef.current
        ?.querySelector(`[data-tv-index="${rows.length - 1}"]`)
        ?.querySelector<HTMLElement>("[data-tv-focusable]") ??
      sideRef.current?.querySelector<HTMLElement>('[aria-label="Play"]');
    if (next) focusElement(next);
  }, [showRecs, rows.length]);
  // `position` is the row's flat index in the list, `number` the one shown.
  const renderRow = (
    key: string,
    track: Track,
    position: number,
    number: number,
  ) => (
    <TvTrackRow
      key={key}
      track={track}
      index={position}
      position={position}
      number={number}
      entry={position === 0}
      menuExtra={
        canRemove
          ? [
              {
                label: "Remove from this playlist",
                icon: ListX,
                onSelect: () => removeFromPlaylist(track),
              },
            ]
          : undefined
      }
      showCover={view.type !== "album"}
      blockedNoMenu
      onSelect={() => void nav.playSource(playable(), { startAt: track })}
    />
  );

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
    view.type === "playlist"
      ? playlistCountLabel(
          (spec.playlist?.numberOfTracks ?? 0) + countDelta,
          spec.playlist?.numberOfVideos,
        )
      : undefined,
    totalSecs > 0 ? formatTotalDuration(totalSecs) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const description =
    listedPlaylist?.description != null
      ? listedPlaylist.description.trim() || undefined
      : spec.description;
  const coverSize = description ? COVER_SIZE_DESCRIBED : COVER_SIZE;
  const openAbout = () =>
    nav.openMenu({
      title: "About",
      subtitle: title,
      wide: true,
      items: descriptionParagraphs(description ?? "").map((p) => ({
        label: p,
        multiline: true,
      })),
    });

  // Cover, title and actions stay in a column on the left while the tracks
  // scroll on the right, so a wide TV screen is not mostly empty. The column
  // is a side panel for the spatial navigation: Left from any track reaches
  // it (landing on the button used last), Right goes back to the tracks.
  return (
    <div className="flex h-full">
      <aside
        ref={sideRef}
        data-tv-side
        data-tv-remember
        className="w-[32rem] shrink-0 h-full overflow-hidden flex flex-col justify-center pl-[3rem] pr-[1.5rem] py-[1.5rem]"
        style={{ containerType: "size" }}
      >
        <div
          className="aspect-square shrink-0 overflow-hidden rounded-[0.8rem] bg-th-surface shadow-2xl"
          style={{ width: coverSize }}
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
              alt={title}
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
          {title}
        </h1>
        {subtitle && (
          <p className="mt-[0.3rem] text-[0.8rem] text-th-text-secondary line-clamp-2">
            {subtitle}
          </p>
        )}
        {description && (
          <p className="mt-[0.3rem] text-[0.8rem] text-th-text-muted line-clamp-3">
            {description}
          </p>
        )}
        {filtering && (
          <p className="mt-[0.3rem] text-[0.8rem] text-th-text-secondary truncate">
            Filter: “{query}”
          </p>
        )}
        {/* Play and Shuffle share the first line, the smaller actions the
            second, so nothing wraps awkwardly in the narrow column. */}
        <div
          className="mt-[1.2rem] grid grid-cols-2 gap-[0.7rem]"
          style={{ width: coverSize }}
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
              onClick={() =>
                nav.openMenu(
                  nav.mediaMenu(media, true, {
                    creatorId: spec.playlist?.creator?.id,
                  }),
                )
              }
            />
          )}
          {description && description.length > LONG_DESCRIPTION && (
            <TvButton
              label="About"
              icon={<Info className="w-[1rem] h-[1rem]" />}
              onClick={openAbout}
            />
          )}
          {sortKey && (
            <TvButton
              label={sortLabel ? `Sort: ${sortLabel}` : "Sort"}
              icon={<SortIcon className="w-[1rem] h-[1rem]" />}
              onClick={openSort}
            />
          )}
          {view.type === "favorites" && (
            <TvButton
              label="Filter"
              icon={<ListFilter className="w-[1rem] h-[1rem]" />}
              onClick={() => void openFilter()}
            />
          )}
          {filtering && (
            <TvButton
              label="Clear"
              icon={<X className="w-[1rem] h-[1rem]" />}
              onClick={clearFilter}
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
        data-tv-loading={paged.loadingMore || loadingAll || undefined}
        className="tv-scroll flex-1 min-w-0 h-full overflow-y-auto pl-[0.5rem] pr-[2rem] pt-[2.5rem] pb-[3rem]"
      >
        {listed.length === 0 && !paged.hasMore ? (
          <p className="px-[1rem] text-[0.85rem] text-th-text-muted">
            {filtering ? `No tracks match “${query}”.` : "No tracks here yet."}
          </p>
        ) : shownDiscs ? (
          shownDiscs.map(({ vol, tracks, start }) => (
            // A disc's first row scrolls into view with its heading.
            <section
              key={vol}
              className="[&>.tv-track-row:first-of-type_.tv-track]:scroll-mt-[3rem]"
            >
              <h2
                className={`px-[1rem] pb-[0.5rem] text-[0.95rem] font-semibold text-th-text-secondary${
                  start > 0 ? " pt-[1.5rem]" : ""
                }`}
              >
                Volume {vol}
              </h2>
              {tracks
                .slice(0, shown - start)
                .map((track, n) =>
                  renderRow(
                    `${track.id}:${start + n}`,
                    track,
                    start + n,
                    n + 1,
                  ),
                )}
            </section>
          ))
        ) : (
          listed
            .slice(0, shown)
            .map(({ track, pos }, i) =>
              renderRow(`${track.id}:${pos}`, track, i, pos + 1),
            )
        )}
        {(paged.loadingMore || loadingAll) && (
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
        {showRecs && (
          <section className="mt-[2rem]">
            <h2 className="px-[1rem] pb-[0.6rem] text-[1.1rem] font-bold text-th-text-primary">
              Recommended tracks
            </h2>
            {recs.visible.map((track, i) => (
              <TvTrackRow
                key={`rec:${track.id}`}
                track={track}
                index={i}
                position={rows.length + i}
                menuExtra={
                  ownPlaylist
                    ? [
                        {
                          label: "Add to this playlist",
                          icon: ListPlus,
                          onSelect: () =>
                            addRecommendation(track, rows.length + i),
                        },
                      ]
                    : undefined
                }
                showCover
                blockedNoMenu
                onSelect={() =>
                  void nav.playSource(
                    {
                      meta: {
                        type: "playlist-recs",
                        id: view.uuid,
                        name: `${title}: Recommended`,
                      },
                      loaded: recs.visible,
                    },
                    { startAt: track },
                  )
                }
              />
            ))}
            <div className="px-[1rem] pt-[1rem]">
              <TvButton
                label="Refresh"
                icon={<RefreshCw className="w-[1rem] h-[1rem]" />}
                onClick={refreshRecs}
              />
            </div>
          </section>
        )}
        {/* Reachable when a page adds no shown rows, so focus never nears
            the end again. */}
        {paged.hasMore &&
          !paged.loadingMore &&
          !paged.moreError &&
          !loadingAll && (
            <div className="px-[1rem] py-[1rem]">
              <TvButton label="Load more" onClick={loadMore} />
            </div>
          )}
      </div>
    </div>
  );
}
