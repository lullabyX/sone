import type {
  FeedItem,
  MediaItemType,
  PlaybackSource,
  PlaylistOrFolder,
  Track,
} from "../../types";
import { getTidalImageUrl, getTidalPromoImageUrl } from "../../types";
import { isNavigableSource } from "../../lib/playbackSource";
import { type ContentPrefs, isContentBlocked } from "../../lib/contentFilter";
import { isTrackUnavailable } from "../../lib/trackAvailability";
import {
  buildMediaItem,
  folderSubtitle,
  getItemImage,
  getItemSubtitle,
  getItemTitle,
  getItemType,
  getMagazineData,
  isMagazineItem,
  isMyTracksItem,
  isTrackItem,
} from "../../utils/itemHelpers";

/** A screen of the TV interface. The rail's roots come first. */
export type TvView =
  | { type: "home" }
  | { type: "settings" }
  | { type: "search" }
  | { type: "collection" }
  | { type: "nowPlaying" }
  | { type: "favorites" }
  | { type: "explore" }
  | { type: "feed" }
  | { type: "profile" }
  /** A TIDAL page by its API path: an Explore genre, mood or shortcut, or
   *  (with `all`) every item of a home row behind "View all". */
  | { type: "page"; title: string; apiPath: string; all?: boolean }
  /** Everything in one of the user's collection rows, or behind an artist
   *  page row's "View all". */
  | { type: "list"; title: string; source: TvListSource }
  | { type: "album"; id: number; title?: string; image?: string }
  | { type: "playlist"; uuid: string; title?: string; image?: string }
  | {
      type: "mix";
      mixId: string;
      title?: string;
      image?: string;
      mixType?: string;
      /** A track radio's seed artist. */
      artist?: { id: number; name: string };
    }
  | { type: "artist"; id: number; name?: string; image?: string }
  /** Every top track of an artist, behind its page's "View all". */
  | { type: "artistTracks"; artistId: number; name: string };

export type TvListSource =
  | {
      kind: "collection";
      what: "playlists" | "albums" | "artists" | "mixes" | "videos";
      folderId?: string;
    }
  | { kind: "artist"; artistId: number; apiPath: string };

export type TvAction =
  | { kind: "open"; view: TvView }
  | { kind: "playTrack"; track: Track }
  | { kind: "playVideo"; item: Extract<MediaItemType, { type: "video" }> }
  /** An external link, shown as a QR code (a remote cannot follow it). */
  | { kind: "showLink"; url: string; title: string };

export interface TvEntry {
  key: string;
  title: string;
  subtitle: string;
  image: string;
  round?: boolean;
  /** Drawn in place of artwork when the entry has none: the heart for My
   *  Tracks, a labelled tile for page links (genres, moods, "View all"), a
   *  folder glyph for playlist folders. */
  icon?: "heart" | "link" | "more" | "folder";
  /** What the action menu acts on, for cards that have one. */
  media?: MediaItemType;
  explicit?: boolean;
  ai?: boolean;
  action: TvAction;
}

/** How a card shows under the content settings, as the desktop does: a track
 *  card greys like a TrackList row (blocked or unavailable) and always carries
 *  its badges; a media card greys only for AI, like MediaCard, and shows the
 *  explicit badge only where the desktop passes `showExplicit`. */
export function entryState(
  entry: TvEntry,
  prefs: ContentPrefs,
  opts?: { showExplicit?: boolean },
): { dimmed: boolean; explicitBadge: boolean; aiBadge: boolean } {
  if (entry.action.kind === "playTrack") {
    const track = entry.action.track;
    return {
      dimmed: isContentBlocked(track, prefs) || isTrackUnavailable(track),
      explicitBadge: !!track.explicit,
      aiBadge: !!track.ai,
    };
  }
  return {
    dimmed: !prefs.allowAi && !!entry.ai,
    explicitBadge: !!opts?.showExplicit && !!entry.explicit,
    aiBadge: !!entry.ai,
  };
}

/** The view a media item opens, or a play action for a video. */
export function actionForMedia(item: MediaItemType): TvAction {
  switch (item.type) {
    case "album":
      return {
        kind: "open",
        view: {
          type: "album",
          id: item.id,
          title: item.title,
          image: getTidalImageUrl(item.cover, 640),
        },
      };
    case "playlist":
      return {
        kind: "open",
        view: {
          type: "playlist",
          uuid: item.uuid,
          title: item.title,
          image: getTidalImageUrl(item.image, 640),
        },
      };
    case "mix":
      return {
        kind: "open",
        view: {
          type: "mix",
          mixId: item.mixId,
          title: item.title,
          image: item.image,
        },
      };
    case "artist":
      return {
        kind: "open",
        view: { type: "artist", id: item.id, name: item.name },
      };
    case "video":
      return { kind: "playVideo", item };
  }
}

/** The screen of what playback comes from, as the desktop drawer opens it;
 *  null for a source with no page. */
export function viewForSource(source: PlaybackSource | null): TvView | null {
  if (!source || !isNavigableSource(source.type)) return null;
  const { id, name: title, image } = source;
  switch (source.type) {
    case "album":
      return { type: "album", id: Number(id), title, image };
    case "playlist":
      return { type: "playlist", uuid: String(id), title, image };
    case "playlist-recs":
      return { type: "playlist", uuid: String(id) };
    case "mix":
      return {
        type: "mix",
        mixId: String(id),
        title,
        image,
        mixType: source.mixType,
      };
    case "radio":
      return {
        type: "mix",
        mixId: String(id),
        title,
        image,
        mixType: source.mixType ?? "TRACK_MIX",
      };
    case "artist":
      return { type: "artist", id: Number(id), name: title };
    case "artist-tracks":
      return { type: "artistTracks", artistId: Number(id), name: title };
    case "favorites":
      return { type: "favorites" };
    default:
      return null;
  }
}

/**
 * Map a raw catalog item (home feed, artist page, search, collection) to a
 * TV card. Mirrors HomeSection's click routing so a card does on the TV what
 * it does on the desktop. Returns null for items with nowhere to go.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTvEntry(item: any, sectionType?: string): TvEntry | null {
  if (!item) return null;
  const title = getItemTitle(item);
  const subtitle = getItemSubtitle(item);

  if (isMyTracksItem(item)) {
    return {
      key: "my-tracks",
      title: title || "My Tracks",
      subtitle: subtitle || "Your favorite tracks",
      image: getItemImage(item, 640),
      icon: "heart",
      action: { kind: "open", view: { type: "favorites" } },
    };
  }

  // MULTIPLE_TOP_PROMOTIONS ("Featured") and MAGAZINE cards reference their
  // content by artifactId (HomeSection's rule).
  const magazine = isMagazineItem(item);
  const promo = magazine ? getMagazineData(item) : item;
  if (promo?.artifactId && promo?.type) {
    const promoTitle = promo.shortHeader || promo.header || "";
    const image = getTidalPromoImageUrl(promo.imageURL || promo.imageId);
    const id = String(promo.artifactId);
    const base = {
      key: `promo:${promo.type}:${id}`,
      title: promoTitle,
      subtitle: promo.shortSubHeader || promo.subHeader || "",
      image,
    };
    switch (promo.type) {
      case "PLAYLIST":
        return {
          ...base,
          media: { type: "playlist", uuid: id, title: promoTitle },
          action: {
            kind: "open",
            view: { type: "playlist", uuid: id, title: promoTitle },
          },
        };
      case "ALBUM":
        return {
          ...base,
          media: { type: "album", id: Number(id), title: promoTitle },
          action: {
            kind: "open",
            view: { type: "album", id: Number(id), title: promoTitle },
          },
        };
      case "ARTIST":
        return {
          ...base,
          media: { type: "artist", id: Number(id), name: promoTitle },
          action: {
            kind: "open",
            view: { type: "artist", id: Number(id), name: promoTitle },
          },
        };
      case "VIDEO": {
        const video = {
          type: "video" as const,
          id: Number(id),
          title: promoTitle,
          imageId: promo.imageId,
        };
        return {
          ...base,
          media: video,
          action: { kind: "playVideo", item: video },
        };
      }
      case "EXTURL":
        return {
          ...base,
          action: { kind: "showLink", url: id, title: promoTitle },
        };
      default:
        return null;
    }
  }
  if (magazine) return null;

  // Explore links (genres, moods, decades, shortcuts) lead to another page.
  // They have no artwork (an `icon` is a small glyph, not a cover), so they
  // show as tiles carrying their name.
  if (item.apiPath && item.uuid == null && item.id == null) {
    if (!title) return null;
    return {
      key: `link:${item.apiPath}`,
      title,
      subtitle: "",
      image: "",
      icon: "link",
      action: {
        kind: "open",
        view: { type: "page", title, apiPath: item.apiPath },
      },
    };
  }

  const media = buildMediaItem(item, sectionType);
  if (media) {
    return {
      key: `${media.type}:${"uuid" in media ? media.uuid : "mixId" in media ? media.mixId : media.id}`,
      title,
      subtitle,
      image: getItemImage(item, 640),
      round: media.type === "artist",
      media,
      explicit: item.explicit,
      ai: item.ai,
      action: actionForMedia(media),
    };
  }

  if (isTrackItem(item, sectionType) && item.id != null) {
    return {
      key: `track:${item.id}`,
      title,
      subtitle,
      image: getItemImage(item, 640),
      explicit: item.explicit,
      ai: item.ai,
      action: { kind: "playTrack", track: item as Track },
    };
  }

  return null;
}

/** The section's items as cards, plus the tracks among them (for building a
 *  queue when one of them is played). A mixed row ignores its section type,
 *  which the backend derives from the first item only. */
export function sectionEntries(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items: any[],
  sectionType?: string,
): { entries: TvEntry[]; tracks: Track[] } {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const mixed =
    new Set(list.map((i) => getItemType(i)).filter(Boolean)).size > 1;
  const hint = mixed ? undefined : sectionType;
  const entries: TvEntry[] = [];
  const tracks: Track[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const entry = toTvEntry(item, hint);
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    entries.push(entry);
    if (entry.action.kind === "playTrack") tracks.push(entry.action.track);
  }
  return { entries, tracks };
}

/** A level of the user's playlist folders as cards: folders (with the
 *  desktop's local renames and count adjustments) open their playlists. */
export function libraryEntries(
  items: PlaylistOrFolder[],
  names: Map<string, string>,
  counts: Map<string, number>,
): TvEntry[] {
  const entries: TvEntry[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    let entry: TvEntry | null;
    if (item.kind === "folder") {
      const { id, name, totalNumberOfItems } = item.data;
      const title = names.get(id) ?? name;
      entry = {
        key: `folder:${id}`,
        title,
        subtitle: folderSubtitle(
          (totalNumberOfItems ?? 0) + (counts.get(id) ?? 0),
        ),
        image: "",
        icon: "folder",
        action: {
          kind: "open",
          view: {
            type: "list",
            title,
            source: { kind: "collection", what: "playlists", folderId: id },
          },
        },
      };
    } else {
      entry = toTvEntry(item.data, "PLAYLIST_LIST");
    }
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    entries.push(entry);
  }
  return entries;
}

/** Feed entries (new releases from followed artists, history mixes) as
 *  cards; entries of an unknown kind are left out, as on the desktop. */
export function feedEntries(items: FeedItem[]): TvEntry[] {
  const entries: TvEntry[] = [];
  const seen = new Set<string>();
  for (const f of items) {
    if (f.kind === "unknown") continue;
    const entry = toTvEntry(
      f.item,
      f.kind === "mix" ? "MIX_LIST" : "ALBUM_LIST",
    );
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    entries.push(entry);
  }
  return entries;
}

/** An album's tracks by disc, in the order the discs first appear; a track
 *  without a disc number is on disc 1 (AlbumView's rule). */
export function groupByVolume(tracks: Track[]): Map<number, Track[]> {
  const groups = new Map<number, Track[]>();
  for (const track of tracks) {
    const vol = track.volumeNumber ?? 1;
    let group = groups.get(vol);
    if (!group) {
      group = [];
      groups.set(vol, group);
    }
    group.push(track);
  }
  return groups;
}
