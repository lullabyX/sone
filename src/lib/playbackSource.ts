export const NAVIGABLE_SOURCE_TYPES = new Set([
  "album",
  "playlist",
  "playlist-recs",
  "mix",
  "artist",
  "artist-tracks",
  "favorites",
  "radio",
]);

export const isNavigableSource = (type?: string): boolean =>
  !!type && NAVIGABLE_SOURCE_TYPES.has(type);
