import { getTidalImageUrl } from "../types";

/**
 * Shared helpers for extracting data from raw Tidal API JSON items.
 * These handle both V1 (direct fields) and V2 (unwrapped from data.{}) formats.
 */

export function getItemImage(item: any, size: number = 320): string {
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
      "/"
    )}/${size}x${size}.jpg`;
  return "";
}

export function getItemTitle(item: any): string {
  if (item.title) return item.title;
  if (item.name) return item.name;
  if (item.titleTextInfo?.text) return item.titleTextInfo.text;
  return "";
}

export function getItemSubtitle(item: any): string {
  if (item.subTitle) return item.subTitle;
  if (item.shortSubtitle) return item.shortSubtitle;
  if (item.subtitleTextInfo?.text) return item.subtitleTextInfo.text;
  if (item.subTitleTextInfo?.text) return item.subTitleTextInfo.text;
  if (item.shortSubtitleTextInfo?.text) return item.shortSubtitleTextInfo.text;
  if (item.artist?.name) return item.artist.name;
  if (item.artists && item.artists.length > 0)
    return item.artists.map((a: any) => a.name).join(", ");
  if (item.creator?.name) return `By ${item.creator.name}`;
  if (item.description) return item.description;
  return "";
}

export function getItemId(item: any): string {
  return (
    item.id?.toString() || item.uuid || item.mixId || item.apiPath || Math.random().toString(36)
  );
}

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
      item.artist !== undefined &&
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
