import { Heart, Shuffle, Clapperboard } from "lucide-react";
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  startTransition,
} from "react";
import { useAtomValue, useAtom } from "jotai";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useAuth } from "../hooks/useAuth";
import { useFavorites } from "../hooks/useFavorites";
import { useViewTab } from "../hooks/useViewTab";
import { useNavigation } from "../hooks/useNavigation";
import {
  getFavoriteTracks,
  getFavoriteVideos,
  getPageSection,
} from "../api/tidal";
import { safeErrorMessage } from "../lib/errorUtils";
import { buildMediaItem, getItemTitle, videoToTrack } from "../utils/itemHelpers";
import { favoriteTrackIdsAtom, trackSortPrefsAtom } from "../atoms/favorites";
import { type Track, type TidalVideo, type MediaItemType } from "../types";
import TrackList from "./TrackList";
import MediaGrid from "./MediaGrid";
import MediaCard from "./MediaCard";
import MediaContextMenu from "./MediaContextMenu";
import LovedTracksBanner from "./LovedTracksBanner";
import DebouncedFilterInput from "./DebouncedFilterInput";
import PageContainer from "./PageContainer";
import SourcePlayButton from "./SourcePlayButton";
import { DetailPageSkeleton } from "./PageSkeleton";

interface FavoritesViewProps {
  onBack: () => void;
}

const PAGE_SIZE = 100;
const VIDEO_PAGE_SIZE = 50;

/** A favorite video as a queue-ready Track (itemType "video") so it flows through
 *  playFromSource/playAllFromSource exactly like an audio track — giving the video
 *  tab a full queue with working prev/next, like the tracks tab. */
export default function FavoritesView({ onBack }: FavoritesViewProps) {
  const [trackSortPrefs, setTrackSortPrefs] = useAtom(trackSortPrefsAtom);
  const { authTokens } = useAuth();
  const {
    playTrack,
    playFromSource,
    playAllFromSource,
    setShuffledQueue,
    appendToQueue,
  } = usePlaybackActions();
  const favoriteTrackIds = useAtomValue(favoriteTrackIdsAtom);
  const { favoriteVideoIds, addFavoriteVideo, removeFavoriteVideo } =
    useFavorites();

  const [videos, setVideos] = useState<TidalVideo[]>([]);
  const [loadingMoreVideos, setLoadingMoreVideos] = useState(false);
  const [hasMoreVideos, setHasMoreVideos] = useState(false);
  const [videoContextMenu, setVideoContextMenu] = useState<{
    item: MediaItemType;
    position: { x: number; y: number };
  } | null>(null);
  const videosOffsetRef = useRef(0);
  const hasMoreVideosRef = useRef(true);
  const bgFetchingVideosRef = useRef(false);
  const videosSentinelRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useViewTab<"tracks" | "videos">("tracks");

  const [allTracks, setAllTracks] = useState<Track[]>([]);
  const [totalTracks, setTotalTracks] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const savedSort = trackSortPrefs["__favorites__"];
  const [sortColumn, setSortColumn] = useState<string | null>(
    savedSort?.order ?? "DATE",
  );
  const [sortDirection, setSortDirection] = useState<"ASC" | "DESC" | null>(
    (savedSort?.direction as "ASC" | "DESC") ?? "DESC",
  );
  const [sortLoading, setSortLoading] = useState(false);
  const generationRef = useRef(0);
  const isFirstLoadRef = useRef(true);

  const offsetRef = useRef(0);
  const hasMoreRef = useRef(true);

  const bgFetchingRef = useRef(false);
  const allTracksRef = useRef<Track[]>([]);

  useEffect(() => {
    allTracksRef.current = allTracks;
  }, [allTracks]);

  const handleSort = useCallback(
    (column: string | null, direction: "ASC" | "DESC" | null) => {
      if (column === null) {
        setSortColumn("DATE");
        setSortDirection("DESC");
        setTrackSortPrefs((prev) => {
          const next = { ...prev };
          delete next["__favorites__"];
          return next;
        });
      } else {
        setSortColumn(column);
        setSortDirection(direction);
        setTrackSortPrefs((prev) => ({
          ...prev,
          __favorites__: { order: column, direction: direction! },
        }));
      }
    },
    [setTrackSortPrefs],
  );

  // Load first page only (re-runs on sort change)
  useEffect(() => {
    const gen = ++generationRef.current;
    bgFetchingRef.current = false;

    const userId = authTokens?.user_id;
    if (userId == null) {
      setLoading(false);
      setError("Not authenticated");
      return;
    }

    if (isFirstLoadRef.current) {
      isFirstLoadRef.current = false;
      setLoading(true);
      setError(null);
      setAllTracks([]);
    } else {
      setSortLoading(true);
    }

    offsetRef.current = 0;
    hasMoreRef.current = true;

    const loadFavorites = async () => {
      try {
        const firstPage = await getFavoriteTracks(
          userId,
          0,
          PAGE_SIZE,
          sortColumn ?? "DATE",
          sortDirection ?? "DESC",
        );
        if (generationRef.current !== gen) return;

        setAllTracks(firstPage.items);
        setTotalTracks(firstPage.totalNumberOfItems);
        offsetRef.current = firstPage.items.length;
        hasMoreRef.current =
          firstPage.items.length < firstPage.totalNumberOfItems;
      } catch (err: any) {
        if (generationRef.current !== gen) return;
        console.error("Failed to load favorites:", err);
        setError(safeErrorMessage(err, "Failed to load favorites"));
      } finally {
        if (generationRef.current === gen) {
          setLoading(false);
          setSortLoading(false);
        }
      }
    };

    loadFavorites();
  }, [authTokens?.user_id, sortColumn, sortDirection]);

  // Load favorite videos — first page only; more via infinite scroll (or all at
  // once when the search bar is focused). Mirrors the tracks pagination.
  useEffect(() => {
    const userId = authTokens?.user_id;
    if (userId == null) return;
    let cancelled = false;
    videosOffsetRef.current = 0;
    hasMoreVideosRef.current = true;
    bgFetchingVideosRef.current = false;
    getFavoriteVideos(userId, 0, VIDEO_PAGE_SIZE)
      .then((items) => {
        if (cancelled) return;
        setVideos(items);
        videosOffsetRef.current = items.length;
        hasMoreVideosRef.current = items.length === VIDEO_PAGE_SIZE;
        setHasMoreVideos(hasMoreVideosRef.current);
      })
      .catch((err) => {
        console.error("Failed to load favorite videos:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [authTokens?.user_id]);

  // The `videos` list is the fetched favorites; trim it by the live favorite set so
  // an unfav removes instantly. But do NOT trim before that set has hydrated on
  // restart (it would hide everything). Latch once the set has been non-empty at
  // least once — after that, an empty set means the user genuinely unfaved them all,
  // so the grid must go empty (not fall back to the unfiltered fetch). Latch via a
  // guarded render-phase update (React's supported pattern) instead of a
  // setState-in-effect, which would trip react-hooks/set-state-in-effect.
  const [favIdsHydrated, setFavIdsHydrated] = useState(false);
  if (favoriteVideoIds.size > 0 && !favIdsHydrated) {
    setFavIdsHydrated(true);
  }

  const displayedVideos = useMemo(
    () =>
      favIdsHydrated || favoriteVideoIds.size > 0
        ? videos.filter((v) => favoriteVideoIds.has(v.id))
        : videos,
    [videos, favoriteVideoIds, favIdsHydrated],
  );

  // Load ALL remaining favorite-video pages (so local search covers everything,
  // and — when a queue is playing — so prev/next reach the whole library, matching
  // the tracks tab). `onPageFetched` receives each fresh page as it arrives.
  const fetchRemainingVideos = useCallback(
    async (onPageFetched?: (videos: TidalVideo[]) => void) => {
      if (bgFetchingVideosRef.current || !hasMoreVideosRef.current) return;
      const userId = authTokens?.user_id;
      if (userId == null) return;
      bgFetchingVideosRef.current = true;
      try {
        while (hasMoreVideosRef.current) {
          const page = await getFavoriteVideos(
            userId,
            videosOffsetRef.current,
            VIDEO_PAGE_SIZE,
          );
          startTransition(() => {
            setVideos((prev) => {
              const seen = new Set(prev.map((v) => v.id));
              return [...prev, ...page.filter((v) => !seen.has(v.id))];
            });
          });
          videosOffsetRef.current += page.length;
          hasMoreVideosRef.current = page.length === VIDEO_PAGE_SIZE;
          setHasMoreVideos(hasMoreVideosRef.current);
          onPageFetched?.(page);
        }
      } catch (err) {
        console.error("Failed to background-fetch favorite videos:", err);
      } finally {
        bgFetchingVideosRef.current = false;
      }
    },
    [authTokens?.user_id],
  );

  // Infinite-scroll one more page of favorite videos.
  const loadMoreVideos = useCallback(async () => {
    if (
      loadingMoreVideos ||
      !hasMoreVideosRef.current ||
      bgFetchingVideosRef.current
    )
      return;
    const userId = authTokens?.user_id;
    if (userId == null) return;
    setLoadingMoreVideos(true);
    try {
      const page = await getFavoriteVideos(
        userId,
        videosOffsetRef.current,
        VIDEO_PAGE_SIZE,
      );
      setVideos((prev) => {
        const seen = new Set(prev.map((v) => v.id));
        return [...prev, ...page.filter((v) => !seen.has(v.id))];
      });
      videosOffsetRef.current += page.length;
      hasMoreVideosRef.current = page.length === VIDEO_PAGE_SIZE;
      setHasMoreVideos(hasMoreVideosRef.current);
    } catch (err) {
      console.error("Failed to load more favorite videos:", err);
    } finally {
      setLoadingMoreVideos(false);
    }
  }, [loadingMoreVideos, authTokens?.user_id]);

  // Fetch all remaining pages in the background, appending to state as they arrive
  const fetchRemaining = useCallback(
    async (onPageFetched?: (items: Track[]) => void) => {
      if (bgFetchingRef.current || !hasMoreRef.current) return;
      const userId = authTokens?.user_id;
      if (userId == null) return;
      const gen = generationRef.current;

      bgFetchingRef.current = true;
      try {
        while (hasMoreRef.current && generationRef.current === gen) {
          const page = await getFavoriteTracks(
            userId,
            offsetRef.current,
            PAGE_SIZE,
            sortColumn ?? "DATE",
            sortDirection ?? "DESC",
          );
          if (generationRef.current !== gen) return;

          const newItems = page.items;
          startTransition(() => {
            setAllTracks((prev) => {
              const seen = new Set(prev.map((t) => t.id));
              return [...prev, ...newItems.filter((t) => !seen.has(t.id))];
            });
            setTotalTracks(page.totalNumberOfItems);
          });
          offsetRef.current += newItems.length;
          hasMoreRef.current = offsetRef.current < page.totalNumberOfItems;

          if (onPageFetched) {
            onPageFetched(newItems);
          }
        }
      } catch (err) {
        console.error("Failed to background-fetch favorites:", err);
      } finally {
        bgFetchingRef.current = false;
      }
    },
    [authTokens?.user_id, sortColumn, sortDirection],
  );

  // Manual load-more (infinite scroll trigger) — also kicks off full background fetch
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMoreRef.current) return;
    if (bgFetchingRef.current) return; // background fetch already running

    const gen = generationRef.current;
    setLoadingMore(true);
    try {
      const userId = authTokens?.user_id;
      if (userId == null) return;
      const page = await getFavoriteTracks(
        userId,
        offsetRef.current,
        PAGE_SIZE,
        sortColumn ?? "DATE",
        sortDirection ?? "DESC",
      );
      if (generationRef.current !== gen) return;
      setAllTracks((prev) => {
        const seen = new Set(prev.map((t) => t.id));
        return [...prev, ...page.items.filter((t) => !seen.has(t.id))];
      });
      setTotalTracks(page.totalNumberOfItems);
      offsetRef.current += page.items.length;
      hasMoreRef.current = offsetRef.current < page.totalNumberOfItems;
    } catch (err) {
      console.error("Failed to load more favorites:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, authTokens?.user_id, sortColumn, sortDirection]);

  const hasMore = allTracks.length < totalTracks;

  // Filter out unfavorited tracks in real-time
  const tracks = useMemo(
    () => allTracks.filter((t) => favoriteTrackIds.has(t.id)),
    [allTracks, favoriteTrackIds],
  );

  // Local search / filter (debounce handled inside DebouncedFilterInput)
  const [searchQuery, setSearchQuery] = useState("");
  const isFiltering = searchQuery.trim().length > 0;

  const { filteredTracks, displayNumbers } = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return { filteredTracks: tracks, displayNumbers: undefined };
    const filtered: Track[] = [];
    const numbers: number[] = [];
    tracks.forEach((t, i) => {
      if (
        t.title.toLowerCase().includes(q) ||
        t.artist?.name?.toLowerCase().includes(q) ||
        t.artists?.some((a) => a.name?.toLowerCase().includes(q)) ||
        t.album?.title?.toLowerCase().includes(q)
      ) {
        filtered.push(t);
        numbers.push(i + 1);
      }
    });
    return { filteredTracks: filtered, displayNumbers: numbers };
  }, [tracks, searchQuery]);

  // Local search also filters the Videos tab (title / artist).
  const filteredVideos = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return displayedVideos;
    return displayedVideos.filter((v) => {
      const title = (v.title ?? "").toLowerCase();
      const artist = (
        v.artist?.name ??
        v.artists?.map((a) => a.name).join(" ") ??
        ""
      ).toLowerCase();
      return title.includes(q) || artist.includes(q);
    });
  }, [displayedVideos, searchQuery]);

  // Infinite-scroll observer for the Videos tab (disabled while filtering —
  // focusing the search bar loads everything up front instead).
  useEffect(() => {
    const el = videosSentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMoreVideos();
      },
      { rootMargin: "300px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMoreVideos, hasMoreVideos, tab, isFiltering]);

  const handleSearchFocus = useCallback(() => {
    if (hasMoreRef.current && !bgFetchingRef.current) {
      setTimeout(() => fetchRemaining(), 0);
    }
    if (hasMoreVideosRef.current && !bgFetchingVideosRef.current) {
      setTimeout(() => fetchRemainingVideos(), 0);
    }
  }, [fetchRemaining, fetchRemainingVideos]);

  const { navigateToExplore, navigateToExplorePage } = useNavigation();

  // "Go to videos" CTA: reuse the Explore page's Videos link (its apiPath is
  // runtime data), falling back to the Explore landing if not found.
  const handleGoToVideos = useCallback(async () => {
    try {
      const { sections } = await getPageSection("pages/explore");
      for (const s of sections) {
        const item = (s.items as any[] | undefined)?.find(
          (i) => i?.apiPath && getItemTitle(i) === "Videos",
        );
        if (item) {
          navigateToExplorePage(item.apiPath, "Videos");
          return;
        }
      }
    } catch {
      // fall through
    }
    navigateToExplore();
  }, [navigateToExplore, navigateToExplorePage]);

  // Stable identity so it doesn't destabilize handlePlayTrack (onPlay) and
  // defeat TrackList's memo — otherwise every tab switch re-renders the whole
  // virtualized list.
  const favoritesSource = useCallback(
    (allTracks: Track[]) => ({
      type: "favorites" as const,
      id: "favorites" as const,
      name: "Loved Tracks",
      allTracks,
    }),
    [],
  );

  const handlePlayTrack = useCallback(
    async (track: Track, _index: number) => {
      try {
        await playFromSource(track, tracks, {
          source: favoritesSource(tracks),
        });

        // Fire-and-forget: append remaining pages to queue as they arrive
        if (hasMoreRef.current && !bgFetchingRef.current) {
          fetchRemaining(appendToQueue);
        }
      } catch (err) {
        console.error("Failed to play track:", err);
      }
    },
    [tracks, favoritesSource, fetchRemaining, appendToQueue, playFromSource],
  );

  const handlePlayAll = async () => {
    if (tracks.length === 0) return;
    try {
      await playAllFromSource(tracks, { source: favoritesSource(tracks) });

      if (hasMoreRef.current && !bgFetchingRef.current) {
        fetchRemaining(appendToQueue);
      }
    } catch (err) {
      console.error("Failed to play loved tracks:", err);
    }
  };

  const handleShuffle = async () => {
    if (tracks.length === 0) return;

    if (hasMoreRef.current && !bgFetchingRef.current) {
      await fetchRemaining();
    }

    const pool = (
      allTracksRef.current.length > 0 ? allTracksRef.current : tracks
    ).filter((t) => favoriteTrackIds.has(t.id));
    if (pool.length === 0) return;

    const firstIdx = Math.floor(Math.random() * pool.length);
    const first = pool[firstIdx];
    const rest = pool.filter((_, i) => i !== firstIdx);
    try {
      setShuffledQueue(rest, { source: favoritesSource(pool) });
      await playTrack(first);
    } catch (err) {
      console.error("Failed to shuffle loved tracks:", err);
    }
  };

  // Video-tab counterparts of favoritesSource/handlePlayAll/handleShuffle. A
  // distinct source id ("favorites-videos") lets the header play button reflect
  // the video queue independently of the tracks queue; type stays "favorites" so
  // "Playing from" still navigates back to this page.
  const videosSource = useCallback(
    (list: Track[]) => ({
      type: "favorites" as const,
      id: "favorites-videos" as const,
      name: "Loved Videos",
      allTracks: list,
    }),
    [],
  );

  // Grow the queue to the full favorite-video library in the background, so
  // prev/next reach beyond the currently-loaded pages (mirrors the tracks tab).
  const appendRemainingVideosToQueue = useCallback(() => {
    if (hasMoreVideosRef.current && !bgFetchingVideosRef.current) {
      fetchRemainingVideos((vids) => appendToQueue(vids.map(videoToTrack)));
    }
  }, [fetchRemainingVideos, appendToQueue]);

  const handlePlayVideo = useCallback(
    async (video: TidalVideo) => {
      const list = displayedVideos.map(videoToTrack);
      try {
        await playFromSource(videoToTrack(video), list, {
          source: videosSource(list),
        });
        appendRemainingVideosToQueue();
      } catch (err) {
        console.error("Failed to play video:", err);
      }
    },
    [displayedVideos, playFromSource, videosSource, appendRemainingVideosToQueue],
  );

  const handlePlayAllVideos = async () => {
    const list = displayedVideos.map(videoToTrack);
    if (list.length === 0) return;
    try {
      await playAllFromSource(list, { source: videosSource(list) });
      appendRemainingVideosToQueue();
    } catch (err) {
      console.error("Failed to play loved videos:", err);
    }
  };

  const handleShuffleVideos = async () => {
    const pool = displayedVideos.map(videoToTrack);
    if (pool.length === 0) return;
    const firstIdx = Math.floor(Math.random() * pool.length);
    const first = pool[firstIdx];
    const rest = pool.filter((_, i) => i !== firstIdx);
    try {
      setShuffledQueue(rest, { source: videosSource(pool) });
      await playTrack(first);
      appendRemainingVideosToQueue();
    } catch (err) {
      console.error("Failed to shuffle loved videos:", err);
    }
  };

  if (loading) {
    return <DetailPageSkeleton type="favorites" />;
  }

  if (error) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center px-8">
          <Heart size={48} className="text-th-text-disabled" />
          <p className="text-th-text-primary font-semibold text-lg">
            Couldn't load favorites
          </p>
          <p className="text-th-text-muted text-sm max-w-md">{error}</p>
          <button
            onClick={onBack}
            className="mt-2 px-6 py-2 bg-th-text-primary text-th-base rounded-full text-sm font-bold hover:scale-105 transition-transform"
          >
            Go back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-linear-to-b from-th-surface to-th-base overflow-y-auto scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent">
      {/* Favorites Header — banner bleeds full width, content stays in PageContainer */}
      <div className="relative">
        <LovedTracksBanner />
        <PageContainer>
          <div className="px-8 py-8 flex items-end gap-7 relative z-10">
            <div className="w-[232px] h-[232px] shrink-0 rounded-lg overflow-hidden shadow-2xl bg-linear-to-br from-[#450af5] via-[#8e2de2] to-[#00d2ff] flex items-center justify-center">
              <Heart
                size={80}
                className="text-white drop-shadow-lg"
                fill="white"
              />
            </div>
            <div className="flex flex-col gap-2 pb-1 min-w-0">
              <span className="text-[12px] font-bold text-th-text-secondary uppercase tracking-widest">
                Collection
              </span>
              <h1 className="text-[42px] font-extrabold text-th-text-primary leading-none tracking-tight">
                Loved Tracks
              </h1>
              <div className="text-[12px] text-th-text-muted uppercase tracking-wide mt-2">
                <span>
                  {totalTracks} TRACK{totalTracks !== 1 ? "S" : ""}
                </span>
              </div>
            </div>
          </div>
          {/* Play Controls */}
          <div className="px-8 py-5 flex items-center gap-3 relative z-10">
            <SourcePlayButton
              sourceType="favorites"
              sourceId={tab === "videos" ? "favorites-videos" : "favorites"}
              onPlay={tab === "videos" ? handlePlayAllVideos : handlePlayAll}
            />
            <button
              onClick={tab === "videos" ? handleShuffleVideos : handleShuffle}
              className="flex items-center gap-2 px-6 py-2.5 bg-th-button/40 backdrop-blur-md text-th-text-primary font-bold text-sm rounded-full hover:bg-th-button/60 hover:scale-[1.03] transition-[transform,filter,background-color] duration-150"
            >
              <Shuffle size={18} />
              Shuffle
            </button>
          </div>

          {/* Search / Filter bar */}
          <div className="px-8 pb-4 relative z-10">
            <DebouncedFilterInput
              placeholder="Filter on title, artist or album"
              onChange={setSearchQuery}
              onFocus={handleSearchFocus}
            />
          </div>
        </PageContainer>
      </div>

      <PageContainer>
        {/* Tracks | Videos tab bar (always shown) */}
        <div className="px-8 pb-4 flex items-center gap-2">
          {(["tracks", "videos"] as const).map((id) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`px-4 py-1.5 rounded-full text-[13px] font-medium transition-colors duration-150 ${
                tab === id
                  ? "bg-th-text-primary text-th-base"
                  : "bg-th-hl-med text-th-text-secondary hover:bg-th-inset"
              }`}
            >
              {id === "tracks" ? "Tracks" : "Videos"}
            </button>
          ))}
        </div>

        {/* Track List */}
        <div className={`px-8 pb-8 ${tab !== "tracks" ? "hidden" : ""}`}>
          <TrackList
            tracks={filteredTracks}
            onPlay={handlePlayTrack}
            onLoadMore={isFiltering ? undefined : loadMore}
            hasMore={isFiltering ? false : hasMore}
            loadingMore={isFiltering ? false : loadingMore}
            trackDisplayNumbers={displayNumbers}
            showDateAdded={true}
            showArtist={true}
            showAlbum={true}
            showCover={true}
            context="favorites"
            sortable
            sortColumn={sortColumn}
            sortDirection={sortDirection}
            onSort={handleSort}
            sortLoading={sortLoading}
            virtualize
          />

          {/* End of list */}
          {tracks.length > 0 && (
            <div className="py-6 text-center text-[13px] text-th-text-disabled">
              {totalTracks} TRACK{totalTracks !== 1 ? "S" : ""}
            </div>
          )}

          {/* Empty state */}
          {tracks.length === 0 && (
            <div className="py-16 text-center">
              <Heart size={48} className="text-th-text-disabled mx-auto mb-4" />
              <p className="text-th-text-primary font-semibold text-lg mb-2">
                No loved tracks yet
              </p>
              <p className="text-th-text-muted text-sm">
                Heart tracks on TIDAL to see them here.
              </p>
            </div>
          )}
        </div>

        {/* Videos */}
        <div className={`px-8 pb-8 ${tab !== "videos" ? "hidden" : ""}`}>
          {displayedVideos.length === 0 ? (
            <div className="py-16 text-center">
              <Clapperboard
                size={48}
                className="text-th-text-disabled mx-auto mb-4"
              />
              <p className="text-th-text-primary font-semibold text-lg mb-2">
                No favorite videos yet
              </p>
              <p className="text-th-text-muted text-sm mb-5">
                Favorite a video and it'll show up here.
              </p>
              <button
                onClick={handleGoToVideos}
                className="px-5 py-2 rounded-full bg-th-text-primary text-th-base text-[13px] font-semibold hover:opacity-90 transition-opacity duration-150"
              >
                Go to videos
              </button>
            </div>
          ) : filteredVideos.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-th-text-primary font-semibold text-lg mb-2">
                No results
              </p>
              <p className="text-th-text-muted text-sm">
                No videos match “{searchQuery.trim()}”.
              </p>
            </div>
          ) : (
            <>
              <MediaGrid>
                {filteredVideos.map((video) => {
                  const mediaItem = buildMediaItem(video, "VIDEO_LIST");
                  const isFavorited = favoriteVideoIds.has(video.id);
                  return (
                    <MediaCard
                      key={video.id}
                      item={video}
                      aspect="video"
                      onClick={() => handlePlayVideo(video)}
                      onContextMenu={
                        mediaItem
                          ? (e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setVideoContextMenu({
                                item: mediaItem,
                                position: { x: e.clientX, y: e.clientY },
                              });
                            }
                          : undefined
                      }
                      onPlay={(e) => {
                        e.stopPropagation();
                        handlePlayVideo(video);
                      }}
                      isFavorited={isFavorited}
                      onFavoriteToggle={(e) => {
                        e.stopPropagation();
                        if (isFavorited) removeFavoriteVideo(video.id);
                        else addFavoriteVideo(video.id);
                      }}
                    />
                  );
                })}
              </MediaGrid>
              {!isFiltering && hasMoreVideos && (
                <div ref={videosSentinelRef} className="h-10" />
              )}
              {loadingMoreVideos && (
                <div className="py-4 text-center text-[13px] text-th-text-disabled">
                  Loading…
                </div>
              )}
            </>
          )}
        </div>
        {videoContextMenu && (
          <MediaContextMenu
            item={videoContextMenu.item}
            cursorPosition={videoContextMenu.position}
            onClose={() => setVideoContextMenu(null)}
          />
        )}
      </PageContainer>
    </div>
  );
}
