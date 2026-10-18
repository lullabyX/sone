import { useEffect, useState } from "react";
import { getTrackLyrics } from "../../api/tidal";
import { parseLrc, type LrcLine } from "../../lib/lrc";

export type TvLyricsData =
  | { kind: "synced"; lines: LrcLine[]; rtl: boolean }
  | { kind: "plain"; text: string; rtl: boolean };

/**
 * The current track's lyrics: synced (timed lines) when TIDAL has them, else
 * plain text, else null. `undefined` while loading. Results are keyed by
 * track id, so a track change never shows the previous track's lyrics.
 */
export function useTvLyrics(
  trackId: number | undefined,
): TvLyricsData | null | undefined {
  const [result, setResult] = useState<{
    id: number;
    data: TvLyricsData | null;
  } | null>(null);

  useEffect(() => {
    if (trackId == null) return;
    let cancelled = false;
    getTrackLyrics(trackId)
      .then((l) => {
        const rtl = l.isRightToLeft ?? false;
        const lines = l.subtitles ? parseLrc(l.subtitles) : [];
        const data: TvLyricsData | null =
          lines.length > 0
            ? { kind: "synced", lines, rtl }
            : l.lyrics?.trim()
              ? { kind: "plain", text: l.lyrics.trim(), rtl }
              : null;
        if (!cancelled) setResult({ id: trackId, data });
      })
      .catch(() => {
        if (!cancelled) setResult({ id: trackId, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [trackId]);

  if (trackId == null) return null;
  return result?.id === trackId ? result.data : undefined;
}
