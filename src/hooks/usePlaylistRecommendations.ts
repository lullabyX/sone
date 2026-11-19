import { useCallback, useEffect, useMemo, useState } from "react";
import { getPlaylistRecommendations, invalidateCache } from "../api/tidal";
import type { Track } from "../types";

const RECS_BATCH = 50;
const RECS_PAGE = 10;

export function usePlaylistRecommendations(playlistId: string) {
  const [recPool, setRecPool] = useState<Track[]>([]);
  const [recPageIndex, setRecPageIndex] = useState(0);
  const [recApiOffset, setRecApiOffset] = useState(0);
  const [loadingRecs, setLoadingRecs] = useState(false);

  // Fetch a batch of recommendations
  const fetchRecBatch = useCallback(
    async (offset: number) => {
      setLoadingRecs(true);
      try {
        const res = await getPlaylistRecommendations(
          playlistId,
          offset,
          RECS_BATCH,
        );
        return res.items;
      } catch {
        return [];
      } finally {
        setLoadingRecs(false);
      }
    },
    [playlistId],
  );

  // Current slice of recommendations to display
  const visibleRecs = useMemo(
    () =>
      recPool.slice(recPageIndex * RECS_PAGE, (recPageIndex + 1) * RECS_PAGE),
    [recPool, recPageIndex],
  );

  const handleRefreshRecs = useCallback(async () => {
    const nextPage = recPageIndex + 1;
    const nextStart = nextPage * RECS_PAGE;
    if (nextStart < recPool.length) {
      // Still have cached tracks
      setRecPageIndex(nextPage);
    } else {
      // Exhausted current batch — fetch next from API
      const newOffset = recApiOffset + RECS_BATCH;
      invalidateCache(`playlist-recs:${playlistId}`);
      const newTracks = await fetchRecBatch(newOffset);
      if (newTracks.length > 0) {
        setRecPool(newTracks);
        setRecApiOffset(newOffset);
        setRecPageIndex(0);
      } else {
        // API returned empty — wrap around to beginning
        const freshTracks = await fetchRecBatch(0);
        setRecPool(freshTracks);
        setRecApiOffset(0);
        setRecPageIndex(0);
      }
    }
  }, [recPageIndex, recPool.length, recApiOffset, playlistId, fetchRecBatch]);

  const removeLocal = useCallback((id: number) => {
    setRecPool((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const restore = useCallback((track: Track) => {
    setRecPool((prev) => {
      if (prev.some((t) => t.id === track.id)) return prev;
      return [...prev, track];
    });
  }, []);

  // Fetch initial batch of recommendations when playlist changes
  useEffect(() => {
    setRecPool([]);
    setRecPageIndex(0);
    setRecApiOffset(0);
    if (playlistId === "") return;
    fetchRecBatch(0).then((tracks) => {
      setRecPool(tracks);
    });
  }, [playlistId, fetchRecBatch]);

  return {
    visible: visibleRecs,
    loading: loadingRecs,
    refresh: handleRefreshRecs,
    removeLocal,
    restore,
  };
}
