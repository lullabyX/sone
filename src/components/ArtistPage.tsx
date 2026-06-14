import {
  Play,
  Pause,
  User,
  X,
  Shuffle,
  Plus,
  Check,
  Radio,
  Share,
  MoreHorizontal,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useStore } from "jotai";
import { isPlayingAtom, currentTrackAtom } from "../atoms/playback";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useFavorites } from "../hooks/useFavorites";
import { useNavigation } from "../hooks/useNavigation";
import { useToast } from "../contexts/ToastContext";
import { getArtistPage } from "../api/tidal";
import { getApiStatus, safeErrorMessage } from "../lib/errorUtils";
import NotFoundPage from "./NotFoundPage";
import {
  getTidalImageUrl,
  getTidalArtistImageUrl,
  type ArtistPageData,
  type ArtistPageSection,
  type MediaItemType,
} from "../types";
import MediaContextMenu from "./MediaContextMenu";
import TrackContextMenu from "./TrackContextMenu";
import { fetchCachedImageUrl } from "./TidalImage";
import TrackList from "./TrackList";
import { ArtistPageSkeleton } from "./PageSkeleton";
import {
  getItemImage,
  getItemTitle,
  getItemSubtitle,
  isMixItem,
  getShareUrl,
} from "../utils/itemHelpers";
import BioText, { stripBio } from "./BioText";
import CardScrollSection from "./CardScrollSection";
import PageContainer from "./PageContainer";

// Fades the stitched banner into the page background at its bottom edge.
const HERO_FADE =
  "linear-gradient(to bottom, #000 0%, #000 60%, transparent 100%)";

function HeaderAction({
  icon,
  label,
  onClick,
  active = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`flex flex-col items-center gap-1.5 transition-colors ${
        active
          ? "text-th-accent hover:brightness-110"
          : "text-th-text-secondary hover:text-th-text-primary"
      }`}
    >
      {icon}
      <span className="text-[11px] font-semibold">{label}</span>
    </button>
  );
}

interface ArtistPageProps {
  artistId: number;
  artistInfo?: { name: string; picture?: string };
  onBack: () => void;
}

export default function ArtistPage({
  artistId,
  artistInfo,
  onBack,
}: ArtistPageProps) {
  const store = useStore();
  const {
    playTrack,
    pauseTrack,
    resumeTrack,
    setShuffledQueue,
    playFromSource,
    playAllFromSource,
  } = usePlaybackActions();
  const {
    followedArtistIds,
    followArtist,
    unfollowArtist,
    favoriteAlbumIds,
    addFavoriteAlbum,
    removeFavoriteAlbum,
    favoritePlaylistUuids,
    addFavoritePlaylist,
    removeFavoritePlaylist,
    favoriteMixIds,
    addFavoriteMix,
    removeFavoriteMix,
  } = useFavorites();
  const {
    navigateToAlbum,
    navigateToArtist,
    navigateToArtistTracks,
    navigateToPlaylist,
    navigateToMix,
    navigateToViewAll,
  } = useNavigation();
  const { showToast } = useToast();
  const isFollowed = followedArtistIds.has(artistId);

  const [pageData, setPageData] = useState<ArtistPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [showBioModal, setShowBioModal] = useState(false);
  const [heroSrcIdx, setHeroSrcIdx] = useState(0);
  const [lowBlob, setLowBlob] = useState<string | null>(null);
  const [hiBlob, setHiBlob] = useState<string | null>(null);
  const [showLow, setShowLow] = useState<string | null>(null);
  const [showHi, setShowHi] = useState<string | null>(null);

  const [contextMenu, setContextMenu] = useState<{
    item: MediaItemType;
    position: { x: number; y: number };
  } | null>(null);

  const [trackContextMenu, setTrackContextMenu] = useState<{
    track: any;
    index: number;
    position: { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadArtist = async () => {
      setLoading(true);
      setError(null);
      setNotFound(false);

      try {
        const data = await getArtistPage(artistId);
        if (!cancelled) {
          setPageData(data);
        }
      } catch (err: any) {
        if (!cancelled) {
          console.error("Failed to load artist:", err);
          if (getApiStatus(err) === 404) {
            setNotFound(true);
          } else {
            setError(safeErrorMessage(err, "Failed to load artist"));
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadArtist();
    return () => {
      cancelled = true;
    };
  }, [artistId]);

  // Derived state from pageData
  const displayName = pageData?.artistName || artistInfo?.name || "Artist";
  const picture = pageData?.picture || artistInfo?.picture;
  const bio = pageData?.bio || "";
  const bioSource = pageData?.bioSource;
  const topTracks = pageData?.topTracks || [];
  const followers = pageData?.followers;
  const radioMixId = pageData?.radioMixId;
  const fansLabel =
    typeof followers === "number" && followers > 0
      ? `${new Intl.NumberFormat("en", {
          notation: "compact",
          maximumFractionDigits: 1,
        }).format(followers)} fans`
      : null;

  const artworkId = pageData?.artworkId;
  const albumFallback = pageData?.albumCoverFallback;
  // Guaranteed final fallback: the first top track's album cover (always present).
  const firstTrackCover = topTracks[0]?.album?.cover;

  // Image sources in priority order: dedicated artist artwork → legacy picture →
  // album-cover fallbacks. Each loads progressively (small first, hi-res swaps in).
  const heroSources = useMemo(() => {
    const list: { uuid: string; kind: "artist" | "album" }[] = [];
    if (artworkId) list.push({ uuid: artworkId, kind: "artist" });
    if (picture) list.push({ uuid: picture, kind: "artist" });
    if (albumFallback) list.push({ uuid: albumFallback, kind: "album" });
    if (firstTrackCover) list.push({ uuid: firstTrackCover, kind: "album" });
    return list;
  }, [artworkId, picture, albumFallback, firstTrackCover]);

  const heroSourcesKey = heroSources.map((s) => s.uuid).join("|");
  const heroSrcUrl = (
    s: { uuid: string; kind: "artist" | "album" },
    hi: boolean,
  ) =>
    s.kind === "artist"
      ? getTidalArtistImageUrl(s.uuid, hi ? 750 : 160)
      : getTidalImageUrl(s.uuid, hi ? 1280 : 320);
  const heroDisplay = showHi || showLow;

  // Restart resolution whenever the source set changes.
  useEffect(() => {
    setHeroSrcIdx(0);
  }, [heroSourcesKey]);

  // Fetch the low-res blob for the current source — fast first paint.
  useEffect(() => {
    setLowBlob(null);
    setHiBlob(null);
    setShowLow(null);
    setShowHi(null);
    const s = heroSources[heroSrcIdx];
    if (!s) return;
    let cancelled = false;
    fetchCachedImageUrl(heroSrcUrl(s, false))
      .then((b) => {
        if (!cancelled) setLowBlob(b);
      })
      .catch(() => {
        if (!cancelled)
          setHeroSrcIdx((i) => (i + 1 < heroSources.length ? i + 1 : i));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroSrcIdx, heroSourcesKey]);

  // Once the low-res is on screen, fetch the hi-res blob in the background.
  useEffect(() => {
    if (!showLow) return;
    const s = heroSources[heroSrcIdx];
    if (!s) return;
    let cancelled = false;
    fetchCachedImageUrl(heroSrcUrl(s, true))
      .then((b) => {
        if (!cancelled) setHiBlob(b);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showLow]);

  const trackIds = useMemo(
    () => new Set(topTracks.map((t: any) => t.id).filter(Boolean)),
    [topTracks],
  );

  const handlePlayTrack = async (
    track: any,
    _index: number,
    trackList: any[],
  ) => {
    try {
      await playFromSource(track, trackList, {
        source: {
          type: "artist",
          id: artistId,
          name: displayName,
          allTracks: trackList,
        },
      });
    } catch (err) {
      console.error("Failed to play artist track:", err);
    }
  };

  const handlePlayAll = async () => {
    if (topTracks.length === 0) return;

    const currentTrack = store.get(currentTrackAtom);
    const isPlaying = store.get(isPlayingAtom);
    if (currentTrack && trackIds.has(currentTrack.id)) {
      if (isPlaying) {
        await pauseTrack();
      } else {
        await resumeTrack();
      }
      return;
    }

    try {
      await playAllFromSource(topTracks, {
        source: {
          type: "artist",
          id: artistId,
          name: displayName,
          allTracks: topTracks,
        },
      });
    } catch (err) {
      console.error("Failed to play artist tracks:", err);
    }
  };

  const handleShuffle = async () => {
    if (topTracks.length === 0) return;
    const firstIdx = Math.floor(Math.random() * topTracks.length);
    const first = topTracks[firstIdx];
    const rest = topTracks.filter((_, i) => i !== firstIdx);
    try {
      setShuffledQueue(rest, {
        source: {
          type: "artist",
          id: artistId,
          name: displayName,
          allTracks: topTracks,
        },
      });
      await playTrack(first);
    } catch (err) {
      console.error("Failed to shuffle artist tracks:", err);
    }
  };

  const handleToggleFollow = async () => {
    try {
      if (isFollowed) {
        await unfollowArtist(artistId);
      } else {
        await followArtist(artistId, {
          id: artistId,
          name: displayName,
          picture,
        });
      }
    } catch (err) {
      console.error("Failed to toggle follow:", err);
    }
  };

  const handleArtistRadio = () => {
    if (!radioMixId) return;
    navigateToMix(radioMixId, {
      title: `${displayName} Radio`,
      image: picture ? getTidalArtistImageUrl(picture, 480) : undefined,
      mixType: "ARTIST_MIX",
    });
  };

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(
        getShareUrl({ type: "artist", id: artistId, name: displayName }),
      );
      showToast("Copied share link to clipboard");
    } catch {
      showToast("Failed to copy share link");
    }
  };

  const handleMore = (e: React.MouseEvent) => {
    e.stopPropagation();
    setContextMenu({
      item: { type: "artist", id: artistId, name: displayName, picture },
      position: { x: e.clientX, y: e.clientY },
    });
  };

  const handleCardContextMenu = useCallback(
    (e: React.MouseEvent, item: any, sectionType: string) => {
      e.preventDefault();
      e.stopPropagation();
      let mediaItem: MediaItemType | null = null;

      if (sectionType === "ALBUM_LIST") {
        mediaItem = {
          type: "album",
          id: item.id,
          title: item.title || getItemTitle(item),
          cover: item.cover,
          artistName: item.artist?.name || item.artists?.[0]?.name,
        };
      } else if (sectionType === "PLAYLIST_LIST") {
        mediaItem = {
          type: "playlist",
          uuid: item.uuid,
          title: item.title || getItemTitle(item),
          image: item.squareImage || item.image,
          creatorName: item.creator?.name,
        };
      } else if (sectionType === "ARTIST_LIST") {
        mediaItem = {
          type: "artist",
          id: item.id,
          name: item.name || getItemTitle(item),
          picture: item.picture,
        };
      } else if (isMixItem(item, sectionType)) {
        const mixId = item.mixId || item.id?.toString();
        if (mixId) {
          mediaItem = {
            type: "mix",
            mixId,
            title: getItemTitle(item),
            image: getItemImage(item),
            subtitle: getItemSubtitle(item),
          };
        }
      }

      if (mediaItem) {
        setContextMenu({
          item: mediaItem,
          position: { x: e.clientX, y: e.clientY },
        });
      }
    },
    [],
  );

  const handleCardClick = useCallback(
    (item: any, sectionType: string) => {
      if (sectionType === "ALBUM_LIST") {
        navigateToAlbum(item.id, {
          title: item.title,
          cover: item.cover,
          artistName: item.artist?.name || item.artists?.[0]?.name,
        });
      } else if (sectionType === "ARTIST_LIST") {
        navigateToArtist(item.id, {
          name: item.name || getItemTitle(item),
          picture: item.picture,
        });
      } else if (sectionType === "PLAYLIST_LIST") {
        navigateToPlaylist(item.uuid, {
          title: item.title,
          image: item.squareImage || item.image,
          description: item.description,
          creatorName: item.creator?.name,
          numberOfTracks: item.numberOfTracks,
        });
      } else if (isMixItem(item, sectionType)) {
        const mixId = item.mixId || item.id?.toString();
        if (mixId) {
          navigateToMix(mixId, {
            title: getItemTitle(item),
            image: getItemImage(item),
            subtitle: getItemSubtitle(item),
          });
        }
      }
    },
    [navigateToAlbum, navigateToArtist, navigateToPlaylist, navigateToMix],
  );

  const artistPlaying = (() => {
    const ct = store.get(currentTrackAtom);
    return !!(ct && trackIds.has(ct.id) && store.get(isPlayingAtom));
  })();

  if (loading) {
    return <ArtistPageSkeleton />;
  }

  if (notFound) {
    return <NotFoundPage />;
  }

  if (error) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center px-8">
          <User size={48} className="text-th-text-disabled" />
          <p className="text-th-text-primary font-semibold text-lg">
            Couldn't load artist
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
      <PageContainer>
        {/* Artist Hero */}
        <div
          className={`relative w-full h-[560px] overflow-hidden flex items-end mb-8`}
        >
          {/* Low-res blob: confirm it decodes (else step source). Rendered opacity-0
            (not display:none) so WebKitGTK actually loads it and fires events. */}
          {lowBlob && !showLow && (
            <img
              aria-hidden
              alt=""
              src={lowBlob}
              className={`pointer-events-none absolute inset-0 opacity-0`}
              onLoad={() => setShowLow(lowBlob)}
              onError={() =>
                setHeroSrcIdx((i) => (i + 1 < heroSources.length ? i + 1 : i))
              }
            />
          )}
          {/* Hi-res blob: loaded in the background, swaps in once it has decoded. */}
          {hiBlob && !showHi && (
            <img
              aria-hidden
              alt=""
              src={hiBlob}
              className="pointer-events-none absolute inset-0 opacity-0"
              onLoad={() => setShowHi(hiBlob)}
            />
          )}
          {heroDisplay && (
            <div
              className={`absolute inset-0 flex justify-center overflow-hidden ${!hiBlob ? "blur-2xl" : ""}`}
              style={{ maskImage: HERO_FADE, WebkitMaskImage: HERO_FADE }}
            >
              {/* Square copies stitched edge-to-edge; the centre one stays bright,
                the flanking copies are darkened. */}
              {[0, 1, 2, 3, 4].map((i) => (
                <img
                  key={i}
                  src={heroDisplay}
                  alt=""
                  draggable={false}
                  className={`h-full w-auto shrink-0 select-none object-cover ${
                    i === 2 ? "" : "brightness-[0.32]"
                  }`}
                />
              ))}
            </div>
          )}
          {/* Legibility scrims — tinted to the theme base so they track any theme */}
          <div className="absolute inset-0 bg-gradient-to-t from-th-base/85 via-th-base/25 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-r from-th-base/50 to-transparent" />

          {/* Foreground content */}
          <div className="relative z-10 w-full px-8 pb-6">
            <div className="max-w-[820px] min-w-0">
              <h1 className="text-[64px] font-extrabold text-th-text-primary leading-[1.1] tracking-tight line-clamp-2 pb-1">
                {displayName}
              </h1>
              {fansLabel && (
                <p className="mt-4 text-[14px] font-bold text-th-text-secondary">
                  {fansLabel}
                </p>
              )}
              {bio && (
                <div className="mt-2">
                  <p className="text-[14px] text-th-text-muted line-clamp-2">
                    {stripBio(bio)}
                  </p>
                  <button
                    onClick={() => setShowBioModal(true)}
                    className="text-[13px] text-th-text-primary font-semibold hover:underline mt-1"
                  >
                    Read more
                  </button>
                </div>
              )}
            </div>

            {/* Controls */}
            <div className="mt-6 flex items-end justify-between gap-6">
              <div className="flex items-center gap-3">
                <button
                  onClick={handlePlayAll}
                  className="flex items-center gap-2 px-6 py-2.5 bg-th-accent text-black font-bold text-sm rounded-full shadow-lg hover:brightness-110 hover:scale-[1.03] transition-[transform,filter] duration-150"
                >
                  {artistPlaying ? (
                    <Pause size={18} fill="black" className="text-black" />
                  ) : (
                    <Play size={18} fill="black" className="text-black" />
                  )}
                  {artistPlaying ? "Pause" : "Play"}
                </button>
                <button
                  onClick={handleShuffle}
                  className="flex items-center gap-2 px-6 py-2.5 bg-th-button/40 backdrop-blur-md text-th-text-primary font-bold text-sm rounded-full hover:bg-th-button/60 hover:scale-[1.03] transition-[transform,filter,background-color] duration-150"
                >
                  <Shuffle size={18} />
                  Shuffle
                </button>
              </div>
              <div className="flex items-center gap-7">
                <HeaderAction
                  icon={isFollowed ? <Check size={22} /> : <Plus size={22} />}
                  label={isFollowed ? "Following" : "Follow"}
                  active={isFollowed}
                  onClick={handleToggleFollow}
                />
                {radioMixId && (
                  <HeaderAction
                    icon={<Radio size={22} />}
                    label="Artist radio"
                    onClick={handleArtistRadio}
                  />
                )}
                <HeaderAction
                  icon={<Share size={22} />}
                  label="Share"
                  onClick={handleShare}
                />
                <HeaderAction
                  icon={<MoreHorizontal size={22} />}
                  label="More"
                  onClick={handleMore}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Bio Modal */}
        {showBioModal && bio && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => setShowBioModal(false)}
          >
            <div
              className="bg-th-elevated rounded-xl shadow-2xl max-w-[700px] w-[90%] max-h-[80vh] flex flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 px-6 pt-5 pb-4">
                <div className="w-11 h-11 shrink-0 rounded-full overflow-hidden bg-th-surface-hover">
                  {picture ? (
                    <img
                      src={getTidalImageUrl(picture, 160)}
                      alt={displayName}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <User size={20} className="text-th-text-faint" />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-[15px] font-bold text-th-text-primary leading-tight">
                    {displayName}
                  </h3>
                  <p className="text-[13px] text-th-text-muted">Biography</p>
                </div>
                <button
                  onClick={() => setShowBioModal(false)}
                  className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center hover:bg-th-inset transition-colors text-th-text-muted hover:text-th-text-primary"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="px-6 pb-6 overflow-y-auto scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent">
                <BioText
                  bio={bio}
                  onArtistClick={(id, name) => {
                    setShowBioModal(false);
                    navigateToArtist(id, { name });
                  }}
                  className="text-th-text-secondary"
                />
                {bioSource && (
                  <p className="text-[12px] text-th-text-faint mt-6 italic">
                    Artist bio from {bioSource}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Dynamic Sections */}
        {pageData?.sections.map((section, sectionIdx) => {
          if (!section.items || section.items.length === 0) return null;

          if (section.type === "TRACK_LIST") {
            return (
              <TrackSection
                key={sectionIdx}
                section={section}
                onPlayTrack={handlePlayTrack}
                onViewAll={() => navigateToArtistTracks(artistId, displayName)}
              />
            );
          }

          if (
            ["ALBUM_LIST", "ARTIST_LIST", "PLAYLIST_LIST", "MIX_LIST"].includes(
              section.type,
            )
          ) {
            return (
              <CardScrollSection
                key={sectionIdx}
                section={section}
                onCardClick={handleCardClick}
                onContextMenu={handleCardContextMenu}
                onViewAll={
                  section.apiPath
                    ? () =>
                        navigateToViewAll(
                          section.title,
                          section.apiPath!,
                          artistId,
                        )
                    : undefined
                }
                favoriteAlbumIds={favoriteAlbumIds}
                addFavoriteAlbum={addFavoriteAlbum}
                removeFavoriteAlbum={removeFavoriteAlbum}
                favoritePlaylistUuids={favoritePlaylistUuids}
                addFavoritePlaylist={addFavoritePlaylist}
                removeFavoritePlaylist={removeFavoritePlaylist}
                followedArtistIds={followedArtistIds}
                followArtist={followArtist}
                unfollowArtist={unfollowArtist}
                favoriteMixIds={favoriteMixIds}
                addFavoriteMix={addFavoriteMix}
                removeFavoriteMix={removeFavoriteMix}
              />
            );
          }

          return null;
        })}

        {/* Empty state */}
        {pageData &&
          pageData.sections.length === 0 &&
          topTracks.length === 0 && (
            <div className="px-8 py-16 text-center">
              <User size={48} className="text-th-text-disabled mx-auto mb-4" />
              <p className="text-th-text-primary font-semibold text-lg mb-2">
                No content available
              </p>
              <p className="text-th-text-muted text-sm">
                This artist doesn't have any tracks or albums yet.
              </p>
            </div>
          )}
      </PageContainer>

      {contextMenu && (
        <MediaContextMenu
          item={contextMenu.item}
          cursorPosition={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}

      {trackContextMenu && (
        <TrackContextMenu
          track={trackContextMenu.track}
          index={trackContextMenu.index}
          cursorPosition={trackContextMenu.position}
          anchorRef={{ current: null }}
          onClose={() => setTrackContextMenu(null)}
        />
      )}
    </div>
  );
}

// ==================== Track Section ====================

function TrackSection({
  section,
  onPlayTrack,
  onViewAll,
}: {
  section: ArtistPageSection;
  onPlayTrack: (track: any, index: number, trackList: any[]) => void;
  onViewAll: () => void;
}) {
  const items = section.items || [];
  const displayTracks = useMemo(
    () =>
      items.slice(0, 10).map((t: any) => {
        if (!t.artist && t.artists?.[0]) return { ...t, artist: t.artists[0] };
        return t;
      }),
    [items],
  );

  const handlePlay = useCallback(
    (track: any, index: number) => onPlayTrack(track, index, items),
    [onPlayTrack, items],
  );

  return (
    <div className="px-8 pb-6">
      <div className="flex items-center justify-between mb-4">
        {section.title && (
          <h2 className="text-[22px] font-bold text-th-text-primary tracking-tight">
            {section.title}
          </h2>
        )}
        {section.apiPath && (
          <button
            onClick={onViewAll}
            className="px-3 py-1.5 text-[13px] font-bold text-th-text-muted hover:text-th-text-primary transition-colors"
          >
            View all
          </button>
        )}
      </div>
      <TrackList
        tracks={displayTracks}
        onPlay={handlePlay}
        showAlbum={true}
        showCover={true}
        showArtist={false}
        showDateAdded={false}
      />
    </div>
  );
}
