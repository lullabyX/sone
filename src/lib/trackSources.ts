import {
  getAlbumPage,
  getArtistTopTracksAll,
  getFavoriteTracks,
  getFavoriteVideos,
  getMixItems,
  getPlaylistTracksPage,
} from "../api/tidal";
import { videoToTrack } from "../utils/itemHelpers";
import type { MediaItemType, Track } from "../types";

export interface TrackPage {
  items: Track[];
  hasMore: boolean;
  /** Raw server offset of the next page. Defaults to the requested offset plus
   *  items.length, which is only right when every position in the window comes
   *  back as an item. */
  nextOffset?: number;
}

type TrackPager = (offset: number) => Promise<TrackPage>;

export interface PlayableSource {
  meta: {
    type: string;
    id: string | number;
    name: string;
    image?: string;
    subtitle?: string;
    mixType?: string;
  };
  /** Raw items already fetched, in server order. */
  loaded: Track[];
  /** Omit for complete sources. */
  fetchPage?: TrackPager;
  /** Raw server offset to resume from. Defaults to loaded.length. */
  nextOffset?: number;
  /** Defaults to true when fetchPage is set. */
  hasMore?: boolean;
  include?: (t: Track) => boolean;
  /** Drop repeated track ids — only for sources whose pages can overlap. */
  dedupe?: boolean;
  albumMode?: boolean;
}

export const ARTIST_TRACKS_PAGE_SIZE = 50;
export const PLAYLIST_PAGE_SIZE = 100;
export const FAVORITE_TRACKS_PAGE_SIZE = 100;
export const FAVORITE_VIDEOS_PAGE_SIZE = 50;

export const artistTopTracksPager =
  (artistId: number): TrackPager =>
  (offset) =>
    getArtistTopTracksAll(artistId, offset, ARTIST_TRACKS_PAGE_SIZE);

// TIDAL counts tracks that are no longer available in totalNumberOfItems and
// in the offset, but leaves them out of `items` (and the playlist parser skips
// entries without an item), so a page can come back shorter than its window, or
// empty, before the total. These pagers advance by the window requested: by the
// items received, the next request re-reads part of the previous window and
// queues those tracks twice, and an empty window ends the source early.
export const playlistTracksPager =
  (playlistId: string, order?: string, direction?: string): TrackPager =>
  async (offset) => {
    const page = await getPlaylistTracksPage(
      playlistId,
      offset,
      PLAYLIST_PAGE_SIZE,
      order,
      direction,
    );
    const nextOffset = offset + PLAYLIST_PAGE_SIZE;
    return {
      items: page.items,
      hasMore: nextOffset < page.totalNumberOfItems,
      nextOffset,
    };
  };

export const favoriteTracksPager =
  (userId: number, order: string, direction: string): TrackPager =>
  async (offset) => {
    const page = await getFavoriteTracks(
      userId,
      offset,
      FAVORITE_TRACKS_PAGE_SIZE,
      order,
      direction,
    );
    const nextOffset = offset + FAVORITE_TRACKS_PAGE_SIZE;
    return {
      items: page.items,
      hasMore: nextOffset < page.totalNumberOfItems,
      nextOffset,
    };
  };

export const favoriteVideosPager =
  (userId: number): TrackPager =>
  async (offset) => {
    const videos = await getFavoriteVideos(
      userId,
      offset,
      FAVORITE_VIDEOS_PAGE_SIZE,
    );
    return {
      items: videos.map(videoToTrack),
      hasMore: videos.length === FAVORITE_VIDEOS_PAGE_SIZE,
    };
  };

export async function playableFromMedia(
  item: MediaItemType,
): Promise<PlayableSource | null> {
  switch (item.type) {
    case "album": {
      const { page } = await getAlbumPage(item.id);
      return {
        meta: {
          type: "album",
          id: item.id,
          name: item.title,
          image: item.cover,
        },
        loaded: page.tracks,
        albumMode: true,
      };
    }
    case "playlist":
      return {
        meta: {
          type: "playlist",
          id: item.uuid,
          name: item.title,
          image: item.image,
        },
        loaded: [],
        fetchPage: playlistTracksPager(item.uuid),
      };
    case "mix": {
      const result = await getMixItems(item.mixId);
      return {
        meta: {
          type: "mix",
          id: item.mixId,
          name: item.title,
          image: item.image,
          subtitle: item.subtitle,
          mixType: result.mixType ?? undefined,
        },
        loaded: result.tracks,
      };
    }
    case "artist":
      return {
        meta: { type: "artist", id: item.id, name: item.name },
        loaded: [],
        fetchPage: artistTopTracksPager(item.id),
        dedupe: true,
      };
    default:
      return null;
  }
}
