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

/** Mirrors TERMINAL_SUB_STATUSES in src-tauri/src/tidal_api.rs — keep in sync.
 *  Excludes 4006 (privileges lost) and 4033 (subscription up-sell): both
 *  recover, so the track must stay in the queue. */
const TERMINAL_SUB_STATUSES = [4005, 4010, 4030, 4031, 4032, 4034, 4035];

function hasTerminalSubStatus(err: unknown): boolean {
  const body = (err as { message?: { body?: unknown } })?.message?.body;
  if (typeof body !== "string") return false;
  try {
    const sub = (JSON.parse(body) as { subStatus?: unknown }).subStatus;
    return typeof sub === "number" && TERMINAL_SUB_STATUSES.includes(sub);
  } catch {
    return false;
  }
}

/**
 * True if a playback error means "this specific track is not playable" —
 * as opposed to auth expiry, rate-limit, server outage, or a network glitch.
 * Narrow allowlist:
 *   - 404 Not Found   → catalog removal / wrong ID
 *   - 410 Gone        → catalog removal (explicit)
 *   - 451 Unavailable for Legal Reasons → region-licensed-out
 *   - 401 WITH a terminal playbackinfo sub-status → asset will not serve.
 *     A bare 401 stays transient — that one is real auth expiry.
 * Everything else (401/403/429/5xx/Network/decode/etc.) is "transient":
 * halt playback, keep the failed track in the queue, do not auto-skip.
 */
export function isUnplayableError(error: unknown): boolean {
  const parsed = typeof error === "string" ? safeJsonParse(error) : error;
  const status = getApiStatus(parsed);
  if (status === 404 || status === 410 || status === 451) return true;
  return status === 401 && hasTerminalSubStatus(parsed);
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
