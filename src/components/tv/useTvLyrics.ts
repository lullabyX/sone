import { useEffect, useState } from "react";
import { getTrackLyrics } from "../../api/tidal";
import { parseLrc, type LrcLine } from "../../lib/lrc";

export type TvLyricsData =
  | { kind: "synced"; lines: LrcLine[]; rtl: boolean; provider?: string }
  | { kind: "plain"; text: string; rtl: boolean; provider?: string };

/**
 * The current track's lyrics: synced (timed lines) when TIDAL has them, else
 * plain text, else null. `undefined` while the first ones load. On a track
 * change the last lyrics stay until the new ones arrive, so the lyrics panel
 * (and the remote's focus on it) does not drop out in between; `forId` says
 * which track they belong to. A video has none and clears them.
 */
export function useTvLyrics(trackId: number | undefined): {
  lyrics: TvLyricsData | null | undefined;
  forId: number | undefined;
} {
  const [loaded, setLoaded] = useState<{
    id: number;
    lyrics: TvLyricsData | null;
  }>();
  if (trackId == null && loaded !== undefined) setLoaded(undefined);

  useEffect(() => {
    if (trackId == null) return;
    let cancelled = false;
    const settle = (lyrics: TvLyricsData | null) => {
      if (!cancelled) setLoaded({ id: trackId, lyrics });
    };
    getTrackLyrics(trackId)
      .then((l) => {
        const rtl = l.isRightToLeft ?? false;
        const provider = l.lyricsProvider;
        const lines = l.subtitles ? parseLrc(l.subtitles) : [];
        settle(
          lines.length > 0
            ? { kind: "synced", lines, rtl, provider }
            : l.lyrics?.trim()
              ? { kind: "plain", text: l.lyrics.trim(), rtl, provider }
              : null,
        );
      })
      .catch(() => settle(null));
    return () => {
      cancelled = true;
    };
  }, [trackId]);

  return trackId == null
    ? { lyrics: null, forId: undefined }
    : { lyrics: loaded?.lyrics, forId: loaded?.id };
}
