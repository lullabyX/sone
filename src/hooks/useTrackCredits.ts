import { useEffect, useState } from "react";
import { getTrackCredits } from "../api/tidal";
import type { Credit } from "../types";

/** A track's credits, reloaded when the track changes. */
export function useTrackCredits(trackId: number | undefined): {
  credits: Credit[];
  loading: boolean;
  error: string | null;
} {
  const [credits, setCredits] = useState<Credit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (trackId === undefined) return;

    let active = true;
    setLoading(true);
    setError(null);
    setCredits([]);

    getTrackCredits(trackId)
      .then((result) => {
        if (active) setCredits(result);
      })
      .catch((err) => {
        if (active) setError(String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [trackId]);

  return { credits, loading, error };
}
