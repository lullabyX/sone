import type { Track } from "../types";
import { getApiStatus } from "./errorUtils";

/**
 * True if a track's metadata indicates it cannot be played right now.
 * Undefined fields are treated as available, so responses that omit
 * availability flags don't regress to grey-out everything.
 */
export function isTrackUnavailable(track: Track | null | undefined): boolean {
  if (!track) return false;
  if (track.itemType === "video") return false; // videos aren't audio-stream-gated
  if (track.streamReady === false) return true;
  if (track.allowStreaming === false) return true;
  if (track.streamStartDate) {
    const ts = Date.parse(track.streamStartDate);
    if (!Number.isNaN(ts) && ts > Date.now()) return true;
  }
  return false;
}

/**
 * True if a playback error means "this specific track is not playable" —
 * as opposed to auth expiry, rate-limit, server outage, or a network glitch.
 * Narrow allowlist:
 *   - 404 Not Found   → catalog removal / wrong ID
 *   - 410 Gone        → catalog removal (explicit)
 *   - 451 Unavailable for Legal Reasons → region-licensed-out
 * Everything else (401/403/429/5xx/Network/decode/etc.) is "transient":
 * halt playback, keep the failed track in the queue, do not auto-skip.
 */
export function isUnplayableError(error: unknown): boolean {
  const parsed = typeof error === "string" ? safeJsonParse(error) : error;
  const status = getApiStatus(parsed);
  if (status === 404 || status === 410 || status === 451) return true;
  // Sonos UPnP faults meaning "this item can't be played from the linked
  // service": 714/716 unplayable resource, 800 service/account rejection.
  // Same skip-loop semantics as the local 404/410/451 set.
  const sonos = parsed as { kind?: string; message?: { code?: number } };
  if (sonos?.kind === "SonosUpnp") {
    const code = sonos.message?.code;
    return code === 714 || code === 716 || code === 800;
  }
  return false;
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
