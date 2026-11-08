import { useEffect, useState } from "react";
import { getMixItems } from "../api/tidal";
import type { Track } from "../types";

/** The current track's track mix, reloaded when the track changes. */
export function useSuggestedTracks(track: Track | null): {
  tracks: Track[];
  loading: boolean;
  error: string | null;
} {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!track) return;

    let active = true;
    setLoading(true);
    setError(null);

    const trackMixId = track.mixes?.TRACK_MIX;
    if (trackMixId) {
      getMixItems(trackMixId)
        .then(({ tracks }) => {
          if (active) setTracks(tracks);
        })
        .catch((err) => {
          if (active) setError(String(err));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    } else {
      setTracks([]);
      setLoading(false);
    }

    return () => {
      active = false;
    };
  }, [track?.id]);

  return { tracks, loading, error };
}
