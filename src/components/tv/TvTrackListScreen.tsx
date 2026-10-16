import { useCallback, useRef } from "react";
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
import { usePlaybackActions } from "../../hooks/usePlaybackActions";
import { useFavorites } from "../../hooks/useFavorites";
import { usePlaylists } from "../../hooks/usePlaylists";
import { useToast } from "../../contexts/ToastContext";
import { isTrackUnavailable } from "../../lib/trackAvailability";
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
import { useTvLoader } from "./useTvLoader";

/** Cover side in the left column: its full width, unless the text and
 *  buttons below (about 15rem) would then no longer fit under it. */
const COVER_SIZE = "min(100cqw, 100cqh - 15rem)";

type ListView = Extract<
  TvView,
  { type: "album" | "playlist" | "mix" | "favorites" }
>;

interface Loaded {
  kicker: string;
  title: string;
  subtitle?: string;
  image?: string;
  /** Show the liked-tracks heart tile instead of a cover image. */
  heart?: boolean;
  tracks: Track[];
  artist?: { id: number; name: string };
  /** The album / playlist itself, handed to the like call so the
   *  collection shows it straight away (as the desktop pages do). */
  album?: AlbumDetail;
  playlist?: Playlist;
}

const FAVORITES_PAGE = 100;

async function loadList(view: ListView, userId?: number): Promise<Loaded> {
  switch (view.type) {
    case "album": {
      const { page } = await getAlbumPage(view.id);
      const a = page.album;
      const year = a.releaseDate?.slice(0, 4);
      const artist = a.artist ?? a.artists?.[0];
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
        image: getTidalImageUrl(a.cover, 1280),
        tracks: page.tracks,
        album: a,
        artist: artist ? { id: artist.id, name: artist.name } : undefined,
      };
    }
    case "playlist": {
      const [details, tracks] = await Promise.all([
        getPlaylistDetails(view.uuid).catch(() => null),
        getPlaylistTracks(view.uuid),
      ]);
      const creator = details?.creator?.name
        ? `By ${details.creator.name}`
        : details?.creator?.id === 0
          ? "By TIDAL"
          : undefined;
      return {
        kicker: "Playlist",
        title: details?.title ?? view.title ?? "Playlist",
        subtitle: [
          creator,
          playlistCountLabel(details?.numberOfTracks, details?.numberOfVideos),
        ]
          .filter(Boolean)
          .join(" · "),
        // Playlist images have no 1280px size; 640 is the largest the CDN
        // serves for both square and wide playlist art.
        image:
          getTidalImageUrl(details?.squareImage ?? details?.image, 640) ||
          view.image,
        tracks,
        playlist: details ?? undefined,
      };
    }
    case "mix": {
      const mix = await getMixItems(view.mixId);
      return {
        kicker: "Mix",
        title: mix.title ?? view.title ?? "Mix",
        subtitle: mix.subtitle ?? undefined,
        image: mix.image ?? view.image,
        tracks: mix.tracks,
      };
    }
    case "favorites": {
      if (!userId) throw new Error("Not signed in");
      // Same paging as the desktop favorites view: advance by what came
      // back (a page can be short of the limit) until the total is reached.
      const tracks: Track[] = [];
      const seen = new Set<number>();
      let offset = 0;
      for (;;) {
        const page = await getFavoriteTracks(userId, offset, FAVORITES_PAGE);
        for (const t of page.items) {
          if (!seen.has(t.id)) {
            seen.add(t.id);
            tracks.push(t);
          }
        }
        offset += page.items.length;
        if (page.items.length === 0 || offset >= page.totalNumberOfItems) {
          break;
        }
      }
      return {
        kicker: "Collection",
        title: "My Tracks",
        subtitle: `${tracks.length} tracks`,
        // Shown as the heart tile, as in the collection and on the desktop.
        heart: true,
        tracks,
      };
    }
  }
}

function sourceId(view: ListView): string | number {
  switch (view.type) {
    case "album":
      return view.id;
    case "playlist":
      return view.uuid;
    case "mix":
      return view.mixId;
    case "favorites":
      return "favorites";
  }
}

export default function TvTrackListScreen({ view }: { view: ListView }) {
  const nav = useTvNav();
  const userId = useAtomValue(authTokensAtom)?.user_id;
  const fav = useFavorites();
  const { playAllFromSource, setShuffledQueue, playTrack } =
    usePlaybackActions();
  const load = useCallback(() => loadList(view, userId), [view, userId]);
  const { data, error, retry, update } = useTvLoader(
    load,
    "Couldn't load tracks",
  );
  const { removeTrackFromPlaylist } = usePlaylists();
  const listRef = useRef<HTMLDivElement>(null);
  const { showToast } = useToast();

  useTvInitialFocus(data !== null || error !== null);

  if (error) return <TvError message={error} onRetry={retry} />;
  if (!data) return <TvSpinner />;

  const source = {
    type: view.type === "favorites" ? "favorites" : view.type,
    id: sourceId(view),
    name: data.title,
    image: data.image,
    allTracks: data.tracks,
  };
  const albumMode = view.type === "album";
  const media: MediaItemType | null =
    view.type === "album"
      ? { type: "album", id: view.id, title: data.title, cover: data.image }
      : view.type === "playlist"
        ? {
            type: "playlist",
            uuid: view.uuid,
            title: data.title,
            image: data.image,
          }
        : view.type === "mix"
          ? {
              type: "mix",
              mixId: view.mixId,
              title: data.title,
              image: data.image,
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
          : fav.addFavoriteAlbum(view.id, data.album)
        : view.type === "playlist"
          ? liked
            ? fav.removeFavoritePlaylist(view.uuid)
            : fav.addFavoritePlaylist(view.uuid, data.playlist)
          : view.type === "mix"
            ? liked
              ? fav.removeFavoriteMix(view.mixId)
              : fav.addFavoriteMix(view.mixId, {
                  id: view.mixId,
                  title: data.title,
                  subTitle: data.subtitle ?? "",
                  images: data.image
                    ? {
                        SMALL: { url: data.image },
                        MEDIUM: { url: data.image },
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
    data.playlist?.creator?.id === userId;
  const removeFromPlaylist = async (index: number) => {
    if (view.type !== "playlist") return;
    const track = data.tracks[index];
    try {
      await removeTrackFromPlaylist(view.uuid, index);
      update((d) => ({
        ...d,
        tracks: d.tracks.filter((_, i) => i !== index),
      }));
      // The removed row had focus: move it to the row that took its place
      // (or the new last one), once the menu has closed and the list has
      // re-rendered.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const rows =
            listRef.current?.querySelectorAll<HTMLElement>(
              "[data-tv-has-menu]",
            ) ?? [];
          const next = rows[Math.min(index, rows.length - 1)];
          if (next) focusElement(next);
        }),
      );
      showToast(`Removed "${track?.title ?? "track"}" from playlist`);
    } catch {
      showToast("Failed to remove track", "error");
    }
  };

  const totalSecs = data.tracks.reduce((s, t) => s + (t.duration ?? 0), 0);

  // Same as the desktop pages: Play follows the shuffle setting, Shuffle is
  // a one-off shuffled run that leaves the setting alone.
  const playAll = () => {
    void playAllFromSource(data.tracks, { source, albumMode });
    nav.showNowPlaying();
  };
  const shufflePlay = () => {
    const playable = data.tracks.filter((t) => !isTrackUnavailable(t));
    if (playable.length === 0) return;
    const pick = Math.floor(Math.random() * playable.length);
    const rest = playable.filter((_, i) => i !== pick);
    setShuffledQueue(rest, { source, albumMode });
    void playTrack(playable[pick]);
    nav.showNowPlaying();
  };

  const subtitle = [
    data.subtitle,
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
          {data.heart ? (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-th-accent to-th-surface">
              <Heart
                className="w-[38%] h-[38%] text-white"
                fill="currentColor"
              />
            </div>
          ) : (
            <TidalImage
              src={data.image || undefined}
              alt={data.title}
              type="album"
              className="w-full h-full"
            />
          )}
        </div>
        {data.kicker && (
          <p className="mt-[1.4rem] text-[0.65rem] font-bold uppercase tracking-[0.15em] text-th-text-muted">
            {data.kicker}
          </p>
        )}
        <h1 className="text-[1.8rem] font-extrabold leading-tight text-th-text-primary line-clamp-2">
          {data.title}
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
          {data.artist && (
            <TvButton
              label={data.artist.name}
              title={`Go to ${data.artist.name}`}
              onClick={() =>
                nav.push({
                  type: "artist",
                  id: data.artist!.id,
                  name: data.artist!.name,
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
        className="tv-scroll flex-1 min-w-0 h-full overflow-y-auto pl-[0.5rem] pr-[2rem] pt-[2.5rem] pb-[3rem]"
      >
        {data.tracks.length === 0 ? (
          <p className="px-[1rem] text-[0.85rem] text-th-text-muted">
            No tracks here yet.
          </p>
        ) : (
          data.tracks.map((track, i) => (
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
              onSelect={() =>
                nav.playTrack(track, data.tracks, { source, albumMode })
              }
            />
          ))
        )}
      </div>
    </div>
  );
}
