import type { Track } from "../types";
import { getApiStatus } from "./errorUtils";

/**
 * True if a track's metadata indicates it cannot be played right now.
 * Undefined fields are treated as available, so responses that omit
 * availability flags don't regress to grey-out everything.
 */
export function isTrackUnavailable(track: Track | null | undefined): boolean {
  if (!track) return false;
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
  return status === 404 || status === 410 || status === 451;
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
