import type { AppView } from "../types";

export type DeepLinkAction =
  | { kind: "navigate"; view: AppView }
  | { kind: "playTrack"; trackId: number };

export function parseTidalUrl(url: string): DeepLinkAction | null {
  if (!url.startsWith("tidal://")) return null;

  const path = url.slice(8); // strip "tidal://"
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  const contentType = parts[0].toLowerCase();
  const contentId = parts[1];

  switch (contentType) {
    case "track": {
      const id = parseInt(contentId, 10);
      if (isNaN(id)) return null;
      return { kind: "playTrack", trackId: id };
    }
    case "album": {
      const id = parseInt(contentId, 10);
      if (isNaN(id)) return null;
      return { kind: "navigate", view: { type: "album", albumId: id } };
    }
    case "artist": {
      const id = parseInt(contentId, 10);
      if (isNaN(id)) return null;
      return { kind: "navigate", view: { type: "artist", artistId: id } };
    }
    case "playlist":
      return {
        kind: "navigate",
        view: { type: "playlist", playlistId: contentId },
      };
    case "mix":
      return { kind: "navigate", view: { type: "mix", mixId: contentId } };
    default:
      return null;
  }
}
