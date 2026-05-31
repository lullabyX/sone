import type { Track, QueuedTrack } from "../types";
import { isTrackUnavailable } from "./trackAvailability";

/**
 * Pure decision logic for gapless next-track prediction (extracted from
 * `predictNextTrack` in usePlaybackActions for unit-testing).
 *
 * Returns the track to pre-register for a gapless transition, or null when the
 * boundary must fall back to the per-track `track-finished → playNext` path:
 *   - repeat-one (repeat === 2) → null
 *   - head = manualHead ?? contextHead
 *   - null if no head, the head is unavailable, or the head carries a `_source`
 *     whose id differs from the current playback source (source switch is not
 *     gapless in v1, so "Playing from" context never goes wrong).
 */
export function pickGaplessNext(args: {
  repeat: number;
  manualHead: Track | null;
  contextHead: Track | null;
  currentSourceId: string | number | null | undefined;
}): Track | null {
  const { repeat, manualHead, contextHead, currentSourceId } = args;
  if (repeat === 2) return null; // repeat-one → EOS→playNext path
  const head = manualHead ?? contextHead ?? null;
  if (!head || isTrackUnavailable(head)) return null; // unavailable head → playNext drains it
  const headSource = (head as QueuedTrack)._source;
  if (headSource && headSource.id !== currentSourceId) return null; // source switch → not gapless in v1
  return head;
}
