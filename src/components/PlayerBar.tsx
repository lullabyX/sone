import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Repeat,
  Shuffle,
  Heart,
  ListMusic,
  Mic2,
  Infinity as InfinityIcon,
  Maximize2,
  MoreHorizontal,
  PictureInPicture2,
} from "lucide-react";
import { getTidalImageUrl, getTrackDisplayTitle } from "../types";
import { formatTime } from "../lib/format";
import TidalImage from "./TidalImage";
import { useCallback, useRef, useState, memo } from "react";
import { useAtomValue, useAtom, useSetAtom } from "jotai";
import {
  currentTrackAtom,
  isPlayingAtom,
  autoplayAtom,
  repeatAtom,
  shuffleAtom,
  playbackSourceAtom,
} from "../atoms/playback";
import { favoriteTrackIdsAtom } from "../atoms/favorites";
import { maximizedPlayerAtom } from "../atoms/ui";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useProgressScrub } from "../hooks/useProgressScrub";
import { useFavorites } from "../hooks/useFavorites";
import { useDrawer } from "../hooks/useDrawer";
import { useNavigation } from "../hooks/useNavigation";
import { useMiniplayerWindow } from "../hooks/useMiniplayerWindow";
import { TrackArtists } from "./TrackArtists";
import QualityBadge from "./QualityBadge";
import VolumeSlider from "./VolumeSlider";
import TrackContextMenu from "./TrackContextMenu";

// ─── TrackInfoSection ──────────────────────────────────────────────────────

const TrackInfoSection = memo(function TrackInfoSection() {
  const currentTrack = useAtomValue(currentTrackAtom);
  const { toggleDrawer } = useDrawer();
  const { navigateToAlbum } = useNavigation();

  if (!currentTrack) {
    return <div className="text-th-text-faint text-sm">No track playing</div>;
  }

  return (
    <>
      <div
        onClick={toggleDrawer}
        className="w-16 h-16 rounded-md bg-th-surface-hover flex-shrink-0 overflow-hidden shadow-lg shadow-black/40 group cursor-pointer"
      >
        <TidalImage
          src={getTidalImageUrl(currentTrack.album?.cover, 160)}
          alt={currentTrack.album?.title || currentTrack.title}
          className="w-full h-full object-cover transform group-hover:scale-110 transition-transform duration-500"
        />
      </div>
      <div className="flex flex-col justify-center min-w-0">
        <span
          onClick={() =>
            currentTrack.album?.id && navigateToAlbum(currentTrack.album.id)
          }
          className="text-th-text-primary text-[13px] font-semibold truncate hover:underline cursor-pointer leading-tight"
        >
          {getTrackDisplayTitle(currentTrack)}
        </span>
        <span className="text-th-text-secondary text-[11px] truncate mt-0.5">
          <TrackArtists
            artists={currentTrack.artists}
            artist={currentTrack.artist}
            className="hover:text-th-text-primary hover:underline cursor-pointer transition-colors duration-200"
          />
        </span>
        <PlayingFromLabel />
      </div>
    </>
  );
});

// ─── FavoriteButton ────────────────────────────────────────────────────────

const FavoriteButton = memo(function FavoriteButton() {
  const currentTrack = useAtomValue(currentTrackAtom);
  const favoriteTrackIds = useAtomValue(favoriteTrackIdsAtom);
  const { addFavoriteTrack, removeFavoriteTrack } = useFavorites();

  const isLiked = currentTrack ? favoriteTrackIds.has(currentTrack.id) : false;

  const toggleLike = useCallback(async () => {
    if (!currentTrack) return;
    // Optimistic — addFavoriteTrack / removeFavoriteTrack update the atom
    // synchronously before the await, so the UI reflects the change instantly.
    try {
      if (isLiked) {
        await removeFavoriteTrack(currentTrack.id);
      } else {
        await addFavoriteTrack(currentTrack.id, currentTrack);
      }
    } catch (err) {
      console.error("Failed to toggle track favorite:", err);
    }
  }, [currentTrack, isLiked, addFavoriteTrack, removeFavoriteTrack]);

  if (!currentTrack) return null;

  return (
    <button
      onClick={toggleLike}
      className={`ml-1 flex-shrink-0 transition-[color,transform] duration-200 active:scale-90 ${
        isLiked ? "text-th-accent" : "text-th-text-faint hover:text-th-text-primary"
      }`}
    >
      <Heart
        size={16}
        fill={isLiked ? "currentColor" : "none"}
        strokeWidth={isLiked ? 0 : 2}
      />
    </button>
  );
});

// ─── ContextMenuButton ────────────────────────────────────────────────────

const ContextMenuButton = memo(function ContextMenuButton() {
  const currentTrack = useAtomValue(currentTrackAtom);
  const [showMenu, setShowMenu] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  if (!currentTrack) return null;

  return (
    <>
      <button
        ref={anchorRef}
        onClick={() => setShowMenu(true)}
        className="ml-0.5 flex-shrink-0 text-th-text-faint hover:text-th-text-primary transition-colors duration-200 active:scale-90"
        title="More options"
      >
        <MoreHorizontal size={16} />
      </button>
      {showMenu && (
        <TrackContextMenu
          track={currentTrack}
          index={0}
          anchorRef={anchorRef}
          onClose={() => setShowMenu(false)}
        />
      )}
    </>
  );
});

// ─── PlayingFromLabel ─────────────────────────────────────────────────────

const navigableSourceTypes = new Set([
  "album",
  "playlist",
  "mix",
  "artist",
  "artist-tracks",
  "favorites",
  "radio",
]);

const PlayingFromLabel = memo(function PlayingFromLabel() {
  const source = useAtomValue(playbackSourceAtom);
  const {
    navigateToAlbum,
    navigateToPlaylist,
    navigateToMix,
    navigateToArtist,
    navigateToArtistTracks,
    navigateToFavorites,
  } = useNavigation();

  const navigateToSource = useCallback(() => {
    if (!source) return;
    switch (source.type) {
      case "album":
        navigateToAlbum(source.id as number);
        break;
      case "playlist":
        navigateToPlaylist(source.id as string, {
          title: source.name,
          image: source.image,
        });
        break;
      case "mix":
        navigateToMix(source.id as string, {
          title: source.name,
          image: source.image,
          subtitle: source.subtitle,
          mixType: source.mixType,
        });
        break;
      case "artist":
        navigateToArtist(source.id as number);
        break;
      case "artist-tracks":
        navigateToArtistTracks(source.id as number, source.name);
        break;
      case "favorites":
        navigateToFavorites();
        break;
      case "radio":
        navigateToMix(source.id.toString(), {
          title: source.name,
          image: source.image,
          mixType: "TRACK_MIX",
        });
        break;
    }
  }, [
    source,
    navigateToAlbum,
    navigateToPlaylist,
    navigateToMix,
    navigateToArtist,
    navigateToArtistTracks,
    navigateToFavorites,
  ]);

  if (!source) return null;

  const isNavigable = navigableSourceTypes.has(source.type);

  return (
    <span className="flex items-center text-th-text-faint text-[10px] mt-1.5 min-w-0">
      <span className="flex-shrink-0">Playing from&nbsp;</span>
      {isNavigable ? (
        <button
          onClick={navigateToSource}
          className="underline hover:text-th-text-primary transition-colors truncate"
        >
          {source.name}
        </button>
      ) : (
        <span className="underline truncate">{source.name}</span>
      )}
    </span>
  );
});

// ─── ProgressScrubber ──────────────────────────────────────────────────────

const ProgressScrubber = memo(function ProgressScrubber() {
  const {
    progressRef,
    currentTrack,
    displayTime,
    duration,
    clampedProgress,
    isDragging,
    isHoveringProgress,
    setIsHoveringProgress,
    handleProgressMouseDown,
  } = useProgressScrub();

  return (
    <div className="w-full flex items-center gap-2 text-th-text-muted">
      <span className="min-w-[40px] text-right text-[11px] tabular-nums select-none">
        {formatTime(displayTime)}
      </span>
      <div
        ref={progressRef}
        onMouseDown={handleProgressMouseDown}
        onMouseEnter={() => setIsHoveringProgress(true)}
        onMouseLeave={() => {
          if (!isDragging) setIsHoveringProgress(false);
        }}
        className="scrubber flex-1 relative cursor-pointer h-[17px] flex items-center"
      >
        <div className="relative w-full h-[5px] rounded-full">
          <div className="absolute inset-0 bg-th-slider-track rounded-full" />
          <div
            className={`absolute left-0 rounded-full transition-[height,top,background-color] duration-100 ${
              isHoveringProgress || isDragging
                ? "h-full top-0 bg-th-accent"
                : "h-[3px] top-[1px] bg-th-slider-fill"
            }`}
            style={{ width: `${clampedProgress}%` }}
          />
          {!(isHoveringProgress || isDragging) && (
            <div className="absolute inset-0 rounded-full">
              <div className="absolute left-0 right-0 top-0 h-[1px] bg-th-elevated" />
              <div className="absolute left-0 right-0 bottom-0 h-[1px] bg-th-elevated" />
            </div>
          )}
        </div>
        <div
          className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-th-text-primary rounded-full shadow-md shadow-black/50 pointer-events-none transition-opacity duration-100 ${
            isHoveringProgress || isDragging ? "opacity-100" : "opacity-0"
          }`}
          style={{
            left: `calc(${clampedProgress}% - 6px)`,
          }}
        />
      </div>
      <span className="min-w-[40px] text-[11px] tabular-nums select-none">
        {currentTrack ? formatTime(duration) : "0:00"}
      </span>
    </div>
  );
});

// ─── TransportControls ─────────────────────────────────────────────────────

const AutoplayButton = memo(function AutoplayButton() {
  const [autoplay, setAutoplay] = useAtom(autoplayAtom);

  return (
    <button
      onClick={() => setAutoplay(!autoplay)}
      className={`w-8 h-8 flex items-center justify-center rounded-full transition-[color,background-color,transform] duration-200 active:scale-90 relative ${
        autoplay
          ? "text-th-accent"
          : "text-th-text-secondary hover:text-th-text-primary hover:bg-th-border-subtle"
      }`}
      title="Autoplay"
    >
      <InfinityIcon size={17} strokeWidth={2.5} />
      {autoplay && (
        <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-th-accent" />
      )}
    </button>
  );
});

const TransportControls = memo(function TransportControls() {
  const isPlaying = useAtomValue(isPlayingAtom);
  const { pauseTrack, resumeTrack, playNext, playPrevious, toggleShuffle } =
    usePlaybackActions();

  const isShuffle = useAtomValue(shuffleAtom);
  const [repeatMode, setRepeatMode] = useAtom(repeatAtom);

  return (
    <div className="flex flex-col items-center w-[40%] max-w-[600px] gap-1">
      {/* Transport buttons */}
      <div className="flex items-center gap-4">
        <button
          onClick={toggleShuffle}
          className={`w-8 h-8 flex items-center justify-center rounded-full transition-[color,background-color,transform] duration-200 active:scale-90 relative ${
            isShuffle
              ? "text-th-accent"
              : "text-th-text-secondary hover:text-th-text-primary hover:bg-th-border-subtle"
          }`}
        >
          <Shuffle size={15} strokeWidth={2} />
          {isShuffle && (
            <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-th-accent" />
          )}
        </button>
        <button
          onClick={playPrevious}
          className="w-8 h-8 flex items-center justify-center rounded-full text-th-text-secondary hover:text-th-text-primary hover:bg-th-border-subtle transition-[color,background-color,transform] duration-150 active:scale-90"
        >
          <SkipBack size={18} fill="currentColor" />
        </button>
        <button
          onClick={() => (isPlaying ? pauseTrack() : resumeTrack())}
          className="w-9 h-9 bg-th-text-primary rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-transform duration-150"
        >
          {isPlaying ? (
            <Pause size={17} fill="currentColor" className="text-th-base" />
          ) : (
            <Play size={17} fill="currentColor" className="text-th-base ml-0.5" />
          )}
        </button>
        <button
          onClick={() => playNext({ explicit: true })}
          className="w-8 h-8 flex items-center justify-center rounded-full text-th-text-secondary hover:text-th-text-primary hover:bg-th-border-subtle transition-[color,background-color,transform] duration-150 active:scale-90"
        >
          <SkipForward size={18} fill="currentColor" />
        </button>
        <button
          onClick={() => setRepeatMode((repeatMode + 1) % 3)}
          className={`w-8 h-8 flex items-center justify-center rounded-full transition-[color,background-color,transform] duration-200 active:scale-90 relative ${
            repeatMode > 0
              ? "text-th-accent"
              : "text-th-text-secondary hover:text-th-text-primary hover:bg-th-border-subtle"
          }`}
        >
          <Repeat size={15} strokeWidth={2} />
          {repeatMode === 2 && (
            <span className="absolute -top-0.5 -right-0.5 text-[7px] font-bold bg-th-accent text-black rounded-full w-3 h-3 flex items-center justify-center leading-none">
              1
            </span>
          )}
          {repeatMode > 0 && (
            <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-th-accent" />
          )}
        </button>
        <AutoplayButton />
      </div>

      {/* Progress bar */}
      <ProgressScrubber />
    </div>
  );
});

// ─── DrawerButtons ─────────────────────────────────────────────────────────

const DrawerButtons = memo(function DrawerButtons() {
  const { openDrawerToTab } = useDrawer();

  return (
    <>
      <button
        onClick={() => openDrawerToTab("lyrics")}
        className="text-th-text-faint hover:text-th-text-primary transition-colors duration-150"
        title="Lyrics"
      >
        <Mic2 size={16} strokeWidth={2} />
      </button>
      <VolumeSlider />
      <button
        onClick={() => openDrawerToTab("queue")}
        className="text-th-text-faint hover:text-th-text-primary transition-colors duration-150"
        title="Play queue"
      >
        <ListMusic size={16} strokeWidth={2} />
      </button>
    </>
  );
});

// ─── MaximizeButton ──────────────────────────────────────────────────────

const MaximizeButton = memo(function MaximizeButton() {
  const setMaximized = useSetAtom(maximizedPlayerAtom);
  const currentTrack = useAtomValue(currentTrackAtom);

  if (!currentTrack) return null;

  return (
    <button
      onClick={() => setMaximized(true)}
      className="text-th-text-faint hover:text-th-text-primary transition-colors duration-150"
      title="Fullscreen player"
    >
      <Maximize2 size={16} strokeWidth={2} />
    </button>
  );
});

// ─── MiniPlayerButton ────────────────────────────────────────────────────

const MiniPlayerButton = memo(function MiniPlayerButton() {
  const { miniplayerOpen, toggleMiniplayer, canToggle } = useMiniplayerWindow();

  if (!canToggle) return null;

  return (
    <button
      onClick={toggleMiniplayer}
      className={`transition-colors duration-150 ${
        miniplayerOpen
          ? "text-th-accent"
          : "text-th-text-faint hover:text-th-text-primary"
      }`}
      title={miniplayerOpen ? "Close miniplayer" : "Open miniplayer"}
    >
      <PictureInPicture2 size={16} strokeWidth={2} />
    </button>
  );
});

// ─── PlayerBar (shell) ─────────────────────────────────────────────────────

export default function PlayerBar() {
  const maximized = useAtomValue(maximizedPlayerAtom);

  return (
    <div className={`player-bar h-[90px] bg-th-elevated border-t border-th-border-subtle px-4 flex items-center justify-between relative z-50 select-none ${maximized ? "invisible" : ""}`}>
      {/* Left: Track Info */}
      <div className="flex items-center gap-3 w-[30%] min-w-[180px]">
        <TrackInfoSection />
        <FavoriteButton />
        <ContextMenuButton />
      </div>

      {/* Center: Controls + Scrubber */}
      <TransportControls />

      {/* Right: Volume & Extras */}
      <div className="flex items-center justify-end gap-4 w-[30%] min-w-[180px]">
        <QualityBadge />
        <DrawerButtons />
        <MiniPlayerButton />
        <MaximizeButton />
      </div>
    </div>
  );
}
