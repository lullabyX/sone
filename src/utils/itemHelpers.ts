import { getTidalImageUrl, type MediaItemType } from "../types";

/**
 * Shared helpers for extracting data from raw Tidal API JSON items.
 * These handle both V1 (direct fields) and V2 (unwrapped from data.{}) formats.
 */

export function getItemImage(item: any, size: number = 320): string {
  // MAGAZINE: data.imageURL is already a full URL — return as-is, no CDN builder.
  if (isMagazineItem(item)) {
    return item.data?.imageURL ?? "";
  }
  // DEEP_LINK: no image in payload.
  if (isDeepLinkItem(item)) {
    return "";
  }
  // Mix items: images.SMALL/MEDIUM/LARGE
  if (item.images) {
    if (typeof item.images === "object" && !Array.isArray(item.images)) {
      if (size <= 320 && item.images.SMALL?.url) return item.images.SMALL.url;
      if (size <= 640 && item.images.MEDIUM?.url) return item.images.MEDIUM.url;
      if (item.images.LARGE?.url) return item.images.LARGE.url;
      if (item.images.SMALL?.url) return item.images.SMALL.url;
    }
  }
  // V2 mix images (array of {url, width, height})
  if (
    item.mixImages &&
    Array.isArray(item.mixImages) &&
    item.mixImages.length > 0
  ) {
    return item.mixImages[0]?.url || "";
  }
  // V2 detail images
  if (
    item.detailImages &&
    typeof item.detailImages === "object" &&
    !Array.isArray(item.detailImages)
  ) {
    if (item.detailImages.MEDIUM?.url) return item.detailImages.MEDIUM.url;
    if (item.detailImages.SMALL?.url) return item.detailImages.SMALL.url;
  }
  if (
    item.detailMixImages &&
    Array.isArray(item.detailMixImages) &&
    item.detailMixImages.length > 0
  ) {
    return item.detailMixImages[0]?.url || "";
  }
  // Album/playlist cover UUID
  if (item.cover) return getTidalImageUrl(item.cover, size);
  if (item.squareImage) return getTidalImageUrl(item.squareImage, size);
  if (item.image) return getTidalImageUrl(item.image, size);
  // Artist picture UUID
  if (item.picture) return getTidalImageUrl(item.picture, size);
  // Nested album cover
  if (item.album?.cover) return getTidalImageUrl(item.album.cover, size);
  // V2 imageUrl direct
  if (item.imageUrl) return item.imageUrl;
  // Video items
  if (item.imageId) return getTidalImageUrl(item.imageId, size);
  if (item.imagePath)
    return `https://resources.tidal.com/images/${item.imagePath.replace(
      /-/g,
      "/",
    )}/${size}x${size}.jpg`;
  return "";
}

export function getItemTitle(item: any): string {
  if (isMagazineItem(item)) {
    return item.data?.shortHeader ?? "";
  }
  if (isDeepLinkItem(item)) {
    return item.data?.title ?? "";
  }
  if (item.title) return item.title;
  if (item.name) return item.name;
  if (item.titleTextInfo?.text) return item.titleTextInfo.text;
  return "";
}

export function getItemSubtitle(item: any, userId?: number): string {
  if (isMagazineItem(item)) {
    return item.data?.shortSubHeader ?? "";
  }
  if (item.subTitle) return item.subTitle;
  if (item.shortSubtitle) return item.shortSubtitle;
  if (item.subtitleTextInfo?.text) return item.subtitleTextInfo.text;
  if (item.subTitleTextInfo?.text) return item.subTitleTextInfo.text;
  if (item.shortSubtitleTextInfo?.text) return item.shortSubtitleTextInfo.text;
  if (item.artists && item.artists.length > 0)
    return item.artists.map((a: any) => a.name).join(", ");
  if (item.artist?.name) return item.artist.name;
  if (item.creator) {
    const creatorLabel =
      userId != null && item.creator.id === userId
        ? "By You"
        : item.creator.name
          ? `By ${item.creator.name}`
          : item.creator.id === 0
            ? "By TIDAL"
            : undefined;
    const trackCount =
      item.numberOfTracks != null
        ? `${item.numberOfTracks} track${item.numberOfTracks !== 1 ? "s" : ""}`
        : undefined;
    const parts = [creatorLabel, trackCount].filter(Boolean);
    if (parts.length > 0) return parts.join(" · ");
  }
  if (item.description) return item.description;
  return "";
}

export function getItemId(item: any): string {
  if (isMagazineItem(item)) {
    return item.data?.artifactId ?? String(item.data?.id ?? "");
  }
  if (isDeepLinkItem(item)) {
    return String(item.data?.id ?? item.data?.url ?? "");
  }
  return (
    item.id?.toString() ||
    item.uuid ||
    item.mixId ||
    item.apiPath ||
    Math.random().toString(36)
  );
}

/** @public */
export function getItemType(item: any): string {
  return item._itemType || item.type || "";
}

export function isArtistItem(item: any, sectionType?: string): boolean {
  return (
    sectionType === "ARTIST_LIST" ||
    getItemType(item) === "ARTIST" ||
    (item.picture !== undefined &&
      !item.cover &&
      !item.album &&
      !item.images &&
      !item.mixType)
  );
}

export function isTrackItem(item: any, sectionType?: string): boolean {
  return (
    sectionType === "TRACK_LIST" ||
    getItemType(item) === "TRACK" ||
    (item.duration !== undefined &&
      (item.artist !== undefined || item.artists !== undefined) &&
      item.album !== undefined)
  );
}

export function isMixItem(item: any, sectionType?: string): boolean {
  return (
    sectionType === "MIX_LIST" ||
    getItemType(item) === "MIX" ||
    item.mixType !== undefined ||
    item.mixImages !== undefined
  );
}

export function isMagazineItem(item: any): boolean {
  return item?.type === "MAGAZINE" || item?._itemType === "MAGAZINE";
}

export function isDeepLinkItem(item: any): boolean {
  return item?.type === "DEEP_LINK" || item?._itemType === "DEEP_LINK";
}

/** Detect the special "My Tracks" shortcut from Tidal's v2 feed. */
export function isMyTracksItem(item: any): boolean {
  if (
    typeof item?.id === "string" &&
    item.id === "tidal://my-collection/tracks"
  ) {
    return true;
  }
  if (isDeepLinkItem(item)) {
    const url = item.data?.url ?? item.data?.id;
    return url === "tidal://my-collection/tracks";
  }
  return (
    getItemTitle(item) === "My Tracks" &&
    !item.uuid &&
    !item.mixId &&
    !item.cover
  );
}

/** Convert a raw API item into a typed MediaItemType for playback/context menu use. */
export function buildMediaItem(
  item: any,
  sectionType?: string,
): MediaItemType | null {
  // MAGAZINE promo card wraps a playlist artifact.
  if (isMagazineItem(item)) {
    const d = item.data;
    if (d?.type === "PLAYLIST" && d?.artifactId) {
      return {
        type: "playlist",
        uuid: d.artifactId,
        title: d.shortHeader ?? "",
        image: d.imageURL,
      };
    }
    return null;
  }
  if (isMixItem(item, sectionType)) {
    const mixId = item.mixId || item.id?.toString();
    if (mixId) {
      return {
        type: "mix",
        mixId,
        title: getItemTitle(item),
        image: getItemImage(item),
        subtitle: getItemSubtitle(item),
      };
    }
  } else if (isArtistItem(item, sectionType)) {
    if (item.id) {
      return {
        type: "artist",
        id: item.id,
        name: item.name || getItemTitle(item),
        picture: item.picture,
      };
    }
  } else if (item.uuid) {
    return {
      type: "playlist",
      uuid: item.uuid,
      title: item.title || getItemTitle(item),
      image: item.squareImage || item.image,
      creatorName:
        item.creator?.name || (item.creator?.id === 0 ? "TIDAL" : undefined),
    };
  } else if (item.id && !isTrackItem(item, sectionType)) {
    return {
      type: "album",
      id: item.id,
      title: item.title || getItemTitle(item),
      cover: item.cover,
      artistName: item.artist?.name || item.artists?.[0]?.name,
    };
  }
  return null;
}

/** Return comma-separated artist names for a track (plain text, no links). */
export function getTrackArtistDisplay(track: {
  artist?: { name?: string };
  artists?: { name: string }[];
}): string {
  if (track.artists && track.artists.length > 0) {
    return track.artists.map((a) => a.name).join(", ");
  }
  return track.artist?.name || "Unknown Artist";
}

/** The single primary artist to scrobble to Audioscrobbler providers (Last.fm/Libre.fm).
 *  The runtime artist field is `type` ("MAIN"/"FEATURED"); `artistType` is accepted as a
 *  fallback for the (inaccurate) TS interface. Discord/MPRIS/UI display are unaffected. */
export function getTrackPrimaryArtist(track: {
  artist?: { name?: string };
  artists?: { name: string; type?: string; artistType?: string }[];
}): string {
  if (track.artists && track.artists.length > 0) {
    const typeOf = (a: { type?: string; artistType?: string }) =>
      a.artistType ?? a.type;
    const main = track.artists.find((a) => typeOf(a) === "MAIN");
    return main?.name ?? track.artists[0].name;
  }
  return track.artist?.name || "Unknown Artist";
}

/** Format artists with "ft." notation for Discord Rich Presence. */
export function getTrackArtistDiscordDisplay(track: {
  artist?: { name?: string };
  artists?: { name: string; artistType?: string }[];
}): string {
  if (!track.artists || track.artists.length === 0) {
    return track.artist?.name || "Unknown Artist";
  }
  if (track.artists.length === 1) {
    return track.artists[0].name;
  }
  const main = track.artists.filter((a) => a.artistType === "MAIN");
  const featured = track.artists.filter((a) => a.artistType !== "MAIN");

  if (main.length === 0) {
    // No type info — fall back to comma-separated
    return track.artists.map((a) => a.name).join(", ");
  }

  const mainStr = main.map((a) => a.name).join(", ");
  if (featured.length === 0) return mainStr;

  const featStr =
    featured.length === 1
      ? featured[0].name
      : featured
          .slice(0, -1)
          .map((a) => a.name)
          .join(", ") +
        " & " +
        featured[featured.length - 1].name;

  return `${mainStr} ft. ${featStr}`;
}

const TIDAL_SHARE_BASE = "https://tidal.com";

/** Build a Tidal share URL for a track. */
export function getTrackShareUrl(trackId: number): string {
  return `${TIDAL_SHARE_BASE}/track/${trackId}/u`;
}

/** Build a Tidal share URL for a media item (album/playlist/mix/artist). */
export function getShareUrl(item: MediaItemType): string {
  switch (item.type) {
    case "album":
      return `${TIDAL_SHARE_BASE}/album/${item.id}`;
    case "playlist":
      return `${TIDAL_SHARE_BASE}/playlist/${item.uuid}`;
    case "mix":
      return `${TIDAL_SHARE_BASE}/mix/${item.mixId}`;
    case "artist":
      return `${TIDAL_SHARE_BASE}/artist/${item.id}`;
  }
}

export function folderSubtitle(count: number | undefined | null): string {
  if (count == null) return "Folder";
  const n = Math.max(0, count);
  return `${n} playlist${n !== 1 ? "s" : ""}`;
}

export type AudioQualityTier = "max" | "hifi" | "high";

export function getAudioQualityBadge(
  audioQuality: string | undefined,
): { label: string; tier: AudioQualityTier } | null {
  if (!audioQuality) return null;
  switch (audioQuality) {
    case "HI_RES_LOSSLESS":
    case "HI_RES":
      return { label: "HI-RES LOSSLESS", tier: "max" };
    case "LOSSLESS":
      return { label: "LOSSLESS", tier: "hifi" };
    default:
      return { label: "HIGH", tier: "high" };
  }
}

export function getMediaQualityBadge(
  mediaMetadata: { tags?: string[] } | undefined,
  audioQuality: string | undefined,
): { label: string; tier: AudioQualityTier } | null {
  const tags = mediaMetadata?.tags;
  if (tags?.includes("HIRES_LOSSLESS")) {
    return { label: "HI-RES LOSSLESS", tier: "max" };
  }
  if (tags?.includes("LOSSLESS")) {
    return { label: "LOSSLESS", tier: "hifi" };
  }
  return getAudioQualityBadge(audioQuality);
}

export function formatTotalDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}
