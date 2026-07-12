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
  Maximize2,
  MoreHorizontal,
  PictureInPicture2,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getTidalImageUrl, getTrackDisplayTitle, type Track } from "../types";
import ExplicitBadge from "./ExplicitBadge";
import { formatTime } from "../lib/format";
import { isNavigableSource } from "../lib/playbackSource";
import TidalImage from "./TidalImage";
import { useCallback, useRef, useState, useEffect, memo } from "react";
import { useAtomValue, useAtom, useSetAtom } from "jotai";
import {
  currentTrackAtom,
  isPlayingAtom,
  repeatAtom,
  shuffleAtom,
  playbackSourceAtom,
} from "../atoms/playback";
import {
  currentVideoAtom,
  videoPlayingAtom,
  videoFullscreenAtom,
} from "../atoms/video";
import { favoriteTrackIdsAtom, favoriteVideoIdsAtom } from "../atoms/favorites";
import { maximizedPlayerAtom } from "../atoms/ui";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useVideoPlayback } from "../hooks/useVideoPlayback";
import { useProgressScrub } from "../hooks/useProgressScrub";
import { videoElementRef } from "../lib/videoElement";
import { useFavorites } from "../hooks/useFavorites";
import { useDrawer } from "../hooks/useDrawer";
import { useNavigation } from "../hooks/useNavigation";
import { useMiniplayerWindow } from "../hooks/useMiniplayerWindow";
import { TrackArtists } from "./TrackArtists";
import QualityBadge from "./QualityBadge";
import SignalPathPanel from "./SignalPathPanel";
import VolumeSlider from "./VolumeSlider";
import TrackContextMenu from "./TrackContextMenu";

/** Build a video-session input from a restored/queued video-typed track. */
function videoInputFromTrack(t: Track) {
  return {
    id: t.id,
    title: t.title,
    imageId: t.imageId,
    artist: t.artist?.name ?? t.artists?.[0]?.name,
    duration: t.duration,
  };
}

// ─── TrackInfoSection ──────────────────────────────────────────────────────

const TrackInfoSection = memo(function TrackInfoSection() {
  const currentTrack = useAtomValue(currentTrackAtom);
  const currentVideo = useAtomValue(currentVideoAtom);
  const { toggleDrawer } = useDrawer();
  const { navigateToAlbum } = useNavigation();
  const { expandVideo, playVideo } = useVideoPlayback();

  // Video takes precedence. `currentVideo` is a live session; a video-typed
  // `currentTrack` with no session is a restored/queued video (the session
  // atom isn't persisted) — show it as a video and (re)start it on click.
  const videoItem =
    currentVideo ??
    (currentTrack?.itemType === "video" ? currentTrack : null);
  if (videoItem) {
    const videoArtist =
      videoItem.artist?.name ||
      videoItem.artists?.map((a) => a.name).join(", ") ||
      "";
    const openVideo = currentVideo
      ? expandVideo
      : () => playVideo(videoInputFromTrack(currentTrack!));
    return (
      <>
        <div
          onClick={openVideo}
          className="w-16 h-16 rounded-md bg-th-surface-hover flex-shrink-0 overflow-hidden shadow-lg shadow-black/40 group cursor-pointer"
          title={currentVideo ? "Expand video" : "Play video"}
        >
          <TidalImage
            src={getTidalImageUrl(videoItem.imageId, 160)}
            alt={videoItem.title}
            className="w-full h-full object-cover transform group-hover:scale-110 transition-transform duration-500"
          />
        </div>
        <div className="flex flex-col justify-center min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-th-text-primary text-[13px] font-semibold truncate leading-tight">
              {videoItem.title}
            </span>
            {videoItem.explicit && <ExplicitBadge />}
          </div>
          {videoArtist && (
            <span className="text-th-text-secondary text-[11px] truncate mt-0.5">
              {videoArtist}
            </span>
          )}
        </div>
      </>
    );
  }

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
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            onClick={() =>
              currentTrack.album?.id && navigateToAlbum(currentTrack.album.id)
            }
            className="text-th-text-primary text-[13px] font-semibold truncate hover:underline cursor-pointer leading-tight"
          >
            {getTrackDisplayTitle(currentTrack)}
          </span>
          {currentTrack.explicit && <ExplicitBadge />}
        </div>
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
  const favoriteVideoIds = useAtomValue(favoriteVideoIdsAtom);
  const {
    addFavoriteTrack,
    removeFavoriteTrack,
    addFavoriteVideo,
    removeFavoriteVideo,
  } = useFavorites();

  const isVideo = currentTrack?.itemType === "video";
  const isLiked = currentTrack
    ? (isVideo ? favoriteVideoIds : favoriteTrackIds).has(currentTrack.id)
    : false;

  const toggleLike = useCallback(async () => {
    if (!currentTrack) return;
    // Optimistic — the add/remove helpers update the atom synchronously before
    // the await, so the UI reflects the change instantly.
    try {
      if (isVideo) {
        if (isLiked) await removeFavoriteVideo(currentTrack.id);
        else await addFavoriteVideo(currentTrack.id);
      } else if (isLiked) {
        await removeFavoriteTrack(currentTrack.id);
      } else {
        await addFavoriteTrack(currentTrack.id, currentTrack);
      }
    } catch (err) {
      console.error("Failed to toggle favorite:", err);
    }
  }, [
    currentTrack,
    isVideo,
    isLiked,
    addFavoriteTrack,
    removeFavoriteTrack,
    addFavoriteVideo,
    removeFavoriteVideo,
  ]);

  if (!currentTrack) return null;

  return (
    <button
      onClick={toggleLike}
      className={`ml-1 flex-shrink-0 transition-[color,transform] duration-200 active:scale-90 ${
        isLiked
          ? "text-th-accent"
          : "text-th-text-faint hover:text-th-text-primary"
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

export const PlayingFromLabel = memo(function PlayingFromLabel() {
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
      case "playlist-recs":
        // Recommendations belong to a playlist; the source name is
        // "<title>: Recommended", so navigate by id and let the page load
        // its real title rather than passing the decorated name.
        navigateToPlaylist(source.id as string);
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

  const isNavigable = isNavigableSource(source.type);

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
        <span className="truncate">{source.name}</span>
      )}
    </span>
  );
});

// ─── VideoProgressScrubber ─────────────────────────────────────────────────
// Bound to the shared <video> element (not playbackPosition.ts). Polls via rAF
// but throttles the React state update to ~150 ms — same rationale as the
// overlay scrubber: a progress bar has no need for 60 Hz repaints.

const VideoProgressScrubber = memo(function VideoProgressScrubber() {
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [showTimeLeft, setShowTimeLeft] = useState(false);
  const isDraggingRef = useRef(false);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf: number;
    let last = 0;
    const tick = (now: number) => {
      const v = videoElementRef.current;
      if (v && !isDraggingRef.current && now - last >= 150) {
        last = now;
        setPosition(v.currentTime);
        if (v.duration && !Number.isNaN(v.duration)) setDuration(v.duration);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const seekToClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      const v = videoElementRef.current;
      if (!track || !v || !duration) return;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const target = ratio * duration;
      setPosition(target);
      v.currentTime = target;
    },
    [duration],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);
      isDraggingRef.current = true;
      seekToClientX(e.clientX);

      const onMove = (me: MouseEvent) => seekToClientX(me.clientX);
      const onUp = () => {
        setDragging(false);
        isDraggingRef.current = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [seekToClientX],
  );

  const progress = duration > 0 ? (position / duration) * 100 : 0;
  const clampedProgress = Math.min(100, Math.max(0, progress));

  return (
    <div className="w-full flex items-center gap-2 text-th-text-muted">
      <span className="min-w-[40px] text-right text-[11px] tabular-nums select-none">
        {formatTime(position)}
      </span>
      <div
        ref={trackRef}
        onMouseDown={handleMouseDown}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => {
          if (!dragging) setHovering(false);
        }}
        className="scrubber flex-1 relative cursor-pointer h-[17px] flex items-center"
      >
        <div className="relative w-full h-[5px] rounded-full">
          <div className="absolute inset-0 bg-th-slider-track rounded-full" />
          <div
            className={`absolute left-0 rounded-full transition-[height,top,background-color] duration-100 ${
              hovering || dragging
                ? "h-full top-0 bg-th-accent"
                : "h-[3px] top-[1px] bg-th-slider-fill"
            }`}
            style={{ width: `${clampedProgress}%` }}
          />
          {!(hovering || dragging) && (
            <div className="absolute inset-0 rounded-full">
              <div className="absolute left-0 right-0 top-0 h-[1px] bg-th-elevated" />
              <div className="absolute left-0 right-0 bottom-0 h-[1px] bg-th-elevated" />
            </div>
          )}
        </div>
        <div
          className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-th-text-primary rounded-full shadow-md shadow-black/50 pointer-events-none transition-opacity duration-100 ${
            hovering || dragging ? "opacity-100" : "opacity-0"
          }`}
          style={{ left: `calc(${clampedProgress}% - 6px)` }}
        />
      </div>
      <span
        className="min-w-[40px] text-[11px] tabular-nums select-none cursor-pointer"
        onClick={() => setShowTimeLeft((v) => !v)}
      >
        {showTimeLeft
          ? `-${formatTime(Math.max(0, duration - position))}`
          : formatTime(duration)}
      </span>
    </div>
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
  const [showTimeLeft, setShowTimeLeft] = useState(false);

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
      <span
        className="min-w-[40px] text-[11px] tabular-nums select-none cursor-pointer"
        onClick={() => currentTrack && setShowTimeLeft((v) => !v)}
      >
        {currentTrack
          ? showTimeLeft
            ? `-${formatTime(Math.max(0, duration - displayTime))}`
            : formatTime(duration)
          : "0:00"}
      </span>
    </div>
  );
});

// ─── TransportControls ─────────────────────────────────────────────────────

const TransportControls = memo(function TransportControls() {
  const isPlaying = useAtomValue(isPlayingAtom);
  const currentVideo = useAtomValue(currentVideoAtom);
  const currentTrack = useAtomValue(currentTrackAtom);
  const videoPlaying = useAtomValue(videoPlayingAtom);
  const { pauseTrack, resumeTrack, playNext, playPrevious, toggleShuffle } =
    usePlaybackActions();
  const { playVideo } = useVideoPlayback();

  const isShuffle = useAtomValue(shuffleAtom);
  const [repeatMode, setRepeatMode] = useAtom(repeatAtom);

  // Videos are queue items, so prev/next/shuffle/repeat operate the shared
  // queue exactly as for audio. Only play/pause + the scrubber target the
  // shared <video> element in video mode.
  const videoMode = !!currentVideo;
  const showPlaying = videoMode ? videoPlaying : isPlaying;

  const toggleVideoPlay = useCallback(() => {
    const v = videoElementRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  const onPlayPause = currentVideo
    ? toggleVideoPlay
    : currentTrack?.itemType === "video"
      ? () => playVideo(videoInputFromTrack(currentTrack))
      : () => (isPlaying ? pauseTrack() : resumeTrack());

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
          onClick={onPlayPause}
          className="w-9 h-9 bg-th-text-primary rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-transform duration-150"
        >
          {showPlaying ? (
            <Pause size={17} fill="currentColor" className="text-th-base" />
          ) : (
            <Play
              size={17}
              fill="currentColor"
              className="text-th-base ml-0.5"
            />
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
            <span className="absolute -top-0.5 -right-0.5 text-[7px] font-bold bg-th-accent text-th-on-accent rounded-full w-3 h-3 flex items-center justify-center leading-none">
              1
            </span>
          )}
          {repeatMode > 0 && (
            <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-th-accent" />
          )}
        </button>
      </div>

      {/* Progress bar */}
      {videoMode ? <VideoProgressScrubber /> : <ProgressScrubber />}
    </div>
  );
});

// ─── DrawerButtons ─────────────────────────────────────────────────────────

const DrawerButtons = memo(function DrawerButtons() {
  const { drawerOpen, drawerTab, toggleDrawerTab } = useDrawer();

  const lyricsActive = drawerOpen && drawerTab === "lyrics";
  const queueActive = drawerOpen && drawerTab === "queue";

  return (
    <>
      <button
        onClick={() => toggleDrawerTab("lyrics")}
        className={`${
          lyricsActive
            ? "text-th-accent"
            : "text-th-text-faint hover:text-th-text-primary"
        } transition-colors duration-150`}
        title="Lyrics"
      >
        <Mic2 size={16} strokeWidth={2} />
      </button>
      <VolumeSlider />
      <button
        onClick={() => toggleDrawerTab("queue")}
        className={`${
          queueActive
            ? "text-th-accent"
            : "text-th-text-faint hover:text-th-text-primary"
        } transition-colors duration-150`}
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
  const currentVideo = useAtomValue(currentVideoAtom);
  const setVideoFullscreen = useSetAtom(videoFullscreenAtom);
  const { expandVideo } = useVideoPlayback();

  if (!currentTrack && !currentVideo) return null;

  // Video takes the video overlay fullscreen; audio opens the maximized player.
  const onClick = currentVideo
    ? () => {
        expandVideo();
        setVideoFullscreen(true);
        getCurrentWindow()
          .setFullscreen(true)
          .catch(() => {});
      }
    : () => setMaximized(true);

  return (
    <button
      onClick={onClick}
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
  const [signalPathOpen, setSignalPathOpen] = useState(false);

  return (
    <div
      className={`player-bar h-[90px] bg-th-elevated border-t border-th-border-subtle px-4 flex items-center justify-between relative z-50 select-none ${maximized ? "invisible" : ""}`}
    >
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
        <QualityBadge onClick={() => setSignalPathOpen(true)} />
        <DrawerButtons />
        <MiniPlayerButton />
        <MaximizeButton />
      </div>

      <SignalPathPanel
        open={signalPathOpen}
        onClose={() => setSignalPathOpen(false)}
      />
    </div>
  );
}
