import type { Track } from "../types";
import { getTrackArtistDisplay } from "../utils/itemHelpers";

/** Queue-entry display metadata for the Sonos native queue. One definition
 *  so every enqueue path (play, cast handoff, tail mirror) stays in sync. */
export function buildSonosMeta(track: Track) {
  return {
    title: track.title ?? "",
    artist: getTrackArtistDisplay(track),
    album: track.album?.title ?? "",
  };
}
