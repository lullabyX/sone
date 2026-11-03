import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useAtom, useAtomValue, useStore } from "jotai";
import {
  ChevronDown,
  Heart,
  ListX,
  Maximize2,
  Mic2,
  MoreHorizontal,
  Volume1,
  Volume2,
  VolumeX,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Trash2,
} from "lucide-react";
import TidalImage from "../TidalImage";
import SignalPathPanel from "../SignalPathPanel";
import TvNativeLayer from "./TvNativeLayer";
import {
  currentTrackAtom,
  isPlayingAtom,
  manualQueueAtom,
  queueAtom,
  repeatAtom,
  shuffleAtom,
  streamInfoAtom,
  volumeAtom,
  preMuteVolumeAtom,
  bitPerfectAtom,
} from "../../atoms/playback";
import {
  currentVideoAtom,
  videoExpandedAtom,
  videoPlayingAtom,
} from "../../atoms/video";
import { tvLyricsAtom } from "../../atoms/tv";
import { useFavorites } from "../../hooks/useFavorites";
import { usePlaybackActions } from "../../hooks/usePlaybackActions";
import { formatTime } from "../../lib/format";
import { getInterpolatedPosition } from "../../lib/playbackPosition";
import { getTidalImageUrl } from "../../types";
import {
  formatStreamQuality,
  getTrackArtistDisplay,
  trackCoverId,
} from "../../utils/itemHelpers";
import { TvScreenContext, useTvInitialFocus, useTvNav } from "./TvNavContext";
import { focusElement, focusFirstIn } from "../../lib/spatialNav";
import { useToast } from "../../contexts/ToastContext";
import { TvButton, TvTrackRow } from "./TvParts";
import { TvLyricsPanel } from "./TvLyrics";
import { useTvLyrics } from "./useTvLyrics";
import { useTvMiniVideo, useTvVideoAspect } from "./useTvMiniVideo";

const SEEK_STEP_SECS = 10;
const UP_NEXT_SHOWN = 20;

/** The playing video's element (the video player's, wherever it is shown). */
function videoElement(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>("[role='dialog'] video");
}

/** Re-reads the playback position a few times a second: the audio player's
 *  interpolated one, or a video's from its own element. */
function usePosition(video: boolean): number {
  const read = useCallback(
    () =>
      video ? (videoElement()?.currentTime ?? 0) : getInterpolatedPosition(),
    [video],
  );
  const [pos, setPos] = useState(read);
  useEffect(() => {
    const id = setInterval(() => setPos(read()), 250);
    return () => clearInterval(id);
  }, [read]);
  return pos;
}

const VOLUME_STEP = 0.05;

/** Volume bar: Left/Right change it in 5% steps, Enter mutes. Locked while
 *  bit-perfect output is on, since the DAC must get unscaled samples. */
function VolumeControl() {
  const volume = useAtomValue(volumeAtom);
  const bitPerfect = useAtomValue(bitPerfectAtom);
  const store = useStore();
  const { setVolume } = usePlaybackActions();
  const pct = Math.round(volume * 100);
  const Icon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  if (bitPerfect) {
    return (
      <span className="inline-flex items-center gap-[0.5rem] text-[0.7rem] text-th-text-muted">
        <Volume2 className="w-[1.1rem] h-[1.1rem]" />
        Volume fixed (bit-perfect)
      </span>
    );
  }

  const toggleMute = () => {
    if (volume > 0) {
      store.set(preMuteVolumeAtom, volume);
      void setVolume(0);
    } else {
      void setVolume(store.get(preMuteVolumeAtom) || 0.5);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const delta = e.key === "ArrowLeft" ? -VOLUME_STEP : VOLUME_STEP;
      void setVolume(
        Math.round(Math.max(0, Math.min(1, volume + delta)) * 100) / 100,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      toggleMute();
    }
  };

  return (
    <div
      data-tv-focusable
      tabIndex={0}
      role="slider"
      aria-label="Volume"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      onKeyDown={onKeyDown}
      onClick={toggleMute}
      className="tv-progress inline-flex items-center gap-[0.6rem] h-[2.6rem] px-[0.9rem] rounded-full bg-th-button outline-none"
    >
      <Icon className="w-[1.1rem] h-[1.1rem] text-th-text-primary shrink-0" />
      <span className="relative w-[7rem] h-[0.3rem] rounded-full bg-th-slider-track">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-th-accent"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="w-[2.2rem] text-right text-[0.7rem] text-th-text-secondary tabular-nums">
        {pct}%
      </span>
    </div>
  );
}

/** How long after the last Left/Right press the seek is actually sent. */
const SEEK_SETTLE_MS = 350;
/** How long the target keeps showing after the seek, while the playback
 *  position catches up, so the bar does not snap back and forth. */
const SEEK_HOLD_MS = 700;

function Progress({
  duration,
  video,
}: {
  duration: number;
  /** A video: position, play state and seeking go through its element. */
  video: boolean;
}) {
  const live = Math.min(usePosition(video), duration || Infinity);
  const audioPlaying = useAtomValue(isPlayingAtom);
  const videoPlaying = useAtomValue(videoPlayingAtom);
  const isPlaying = video ? videoPlaying : audioPlaying;
  const { seekTo: seekAudio } = usePlaybackActions();
  const seekTo = async (secs: number) => {
    if (!video) return seekAudio(secs);
    const el = videoElement();
    if (el) el.currentTime = secs;
  };
  // While seeking with the remote the bar shows where it is going, and the
  // seek itself goes out once the presses stop: one smooth jump instead of a
  // thumb that bounces between each request and the real position.
  const [target, setTarget] = useState<number | null>(null);
  const targetRef = useRef<number | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(
    () => () => timers.current.forEach((t) => window.clearTimeout(t)),
    [],
  );
  const position = target ?? live;
  const pct = duration > 0 ? (position / duration) * 100 : 0;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (duration <= 0) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const delta = e.key === "ArrowLeft" ? -SEEK_STEP_SECS : SEEK_STEP_SECS;
    const next = Math.max(
      0,
      Math.min(duration - 1, (targetRef.current ?? live) + delta),
    );
    targetRef.current = next;
    setTarget(next);
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [
      window.setTimeout(() => {
        void seekTo(next).finally(() => {
          timers.current.push(
            window.setTimeout(() => {
              targetRef.current = null;
              setTarget(null);
            }, SEEK_HOLD_MS),
          );
        });
      }, SEEK_SETTLE_MS),
    ];
  };

  // Between position samples the bar glides instead of stepping.
  const glide = target === null && isPlaying ? "250ms linear" : "0ms linear";

  return (
    <div className="w-full">
      <div
        data-tv-focusable
        tabIndex={0}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(position)}
        onKeyDown={onKeyDown}
        className="tv-progress relative h-[0.35rem] w-full rounded-full bg-th-slider-track outline-none"
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-th-accent"
          style={{ width: `${pct}%`, transition: `width ${glide}` }}
        />
        <div
          className="tv-progress-thumb absolute top-1/2 h-[0.9rem] w-[0.9rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-th-text-primary opacity-0"
          style={{ left: `${pct}%`, transition: `left ${glide}` }}
        />
      </div>
      <div className="mt-[0.4rem] flex justify-between text-[0.7rem] text-th-text-muted tabular-nums">
        <span className={target !== null ? "text-th-text-primary" : ""}>
          {formatTime(position)}
        </span>
        <span>{duration > 0 ? formatTime(duration) : ""}</span>
      </div>
    </div>
  );
}

export default function TvNowPlaying() {
  const nav = useTvNav();
  const track = useAtomValue(currentTrackAtom);
  const isPlaying = useAtomValue(isPlayingAtom);
  const streamInfo = useAtomValue(streamInfoAtom);
  const queue = useAtomValue(queueAtom);
  const manualQueue = useAtomValue(manualQueueAtom);
  const shuffle = useAtomValue(shuffleAtom);
  const [repeat, setRepeat] = useAtom(repeatAtom);
  const currentVideo = useAtomValue(currentVideoAtom);
  const [videoExpanded, setVideoExpanded] = useAtom(videoExpandedAtom);
  const [lyricsOn, setLyricsOn] = useAtom(tvLyricsAtom);
  const [signalPathOpen, setSignalPathOpen] = useState(false);
  const lyrics = useTvLyrics(
    track && track.itemType !== "video" ? track.id : undefined,
  );
  const {
    favoriteTrackIds,
    addFavoriteTrack,
    removeFavoriteTrack,
    favoriteVideoIds,
    addFavoriteVideo,
    removeFavoriteVideo,
  } = useFavorites();
  // A video's play state lives on its <video> element, not in the audio
  // player's state.
  const videoPlaying = useAtomValue(videoPlayingAtom);
  const {
    togglePlayPause,
    playNext,
    playPrevious,
    toggleShuffle,
    playFromQueue,
    removeFromQueue,
    clearQueue,
  } = usePlaybackActions();
  const { showToast } = useToast();

  useTvInitialFocus(true);
  const screen = useContext(TvScreenContext);
  const upNextRef = useRef<HTMLElement>(null);
  const videoSlotRef = useRef<HTMLDivElement>(null);
  const showVideoInSlot =
    track?.itemType === "video" &&
    !!currentVideo &&
    !videoExpanded &&
    screen.active &&
    !(lyricsOn && !!lyrics);
  useTvMiniVideo(videoSlotRef, screen.element, showVideoInSlot);
  const videoAspect = useTvVideoAspect(
    track?.itemType === "video" && !!currentVideo,
  );
  // After a row leaves the list, focus the row that took its place (or the
  // player, when the list is now empty).
  const refocusUpNext = (index: number) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const rows =
          upNextRef.current?.querySelectorAll<HTMLElement>(
            "[data-tv-has-menu]",
          ) ?? [];
        const next = rows[Math.min(index, rows.length - 1)];
        if (next) focusElement(next);
        else {
          const el = screen.element();
          if (el) focusFirstIn(el);
        }
      }),
    );

  if (!track) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-[1rem] text-center">
        <p className="text-[1.1rem] font-semibold text-th-text-primary">
          Nothing is playing
        </p>
        <p className="text-[0.8rem] text-th-text-muted">
          Pick something from Home, Search or your Collection.
        </p>
        <TvButton
          autoFocus
          label="Go to Home"
          onClick={() => nav.push({ type: "home" })}
        />
      </div>
    );
  }

  const isVideo = track.itemType === "video";
  const cover = getTidalImageUrl(trackCoverId(track), 1280);
  // The backdrop is blurred anyway: a small image scaled up is soft by
  // itself and needs only a light blur, which is far cheaper to paint on
  // weak integrated graphics than a heavy blur over a full-size cover.
  const backdrop = getTidalImageUrl(trackCoverId(track), 160);
  const liked = isVideo
    ? favoriteVideoIds.has(track.id)
    : favoriteTrackIds.has(track.id);
  const playing = isVideo && currentVideo ? videoPlaying : isPlaying;
  const upNext = [...manualQueue, ...queue].slice(0, UP_NEXT_SHOWN);
  const artist = track.artist ?? track.artists?.[0];
  const quality = isVideo ? "" : formatStreamQuality(streamInfo);
  const icon = "w-[1.2rem] h-[1.2rem]";
  const showLyrics = lyricsOn && !!lyrics;

  return (
    // The player fills the first screen; "Up next" starts below the fold and
    // scrolls into view only when focus moves down into it.
    <div className="relative h-full">
      {/* Blurred cover backdrop */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {backdrop && (
          <TidalImage
            src={backdrop}
            alt=""
            className="absolute inset-0 w-full h-full scale-125 blur-[1.2rem] opacity-35"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-th-base/60 to-th-base" />
      </div>

      <div
        data-tv-scroll-top
        className="relative h-full flex items-center gap-[3.5rem] px-[4rem] py-[2.5rem]"
      >
        {showLyrics ? (
          <div className="shrink-0 h-[min(72vh,40rem)] w-[min(46vw,48rem)]">
            <TvLyricsPanel lyrics={lyrics} duration={track.duration ?? 0} />
          </div>
        ) : (
          <div
            ref={isVideo ? videoSlotRef : undefined}
            className={`shrink-0 overflow-hidden rounded-[1rem] shadow-2xl bg-th-surface ${
              isVideo ? "" : "h-[min(72vh,40rem)] aspect-square"
            }`}
            // A video's spot takes the video's own shape (no black bars),
            // as wide as fits in both directions.
            style={
              isVideo
                ? {
                    aspectRatio: videoAspect,
                    width: `min(55vw, 60rem, calc(72vh * ${videoAspect}))`,
                  }
                : undefined
            }
          >
            <TidalImage
              src={cover || undefined}
              alt=""
              className="w-full h-full"
            />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <h1 className="text-[2.4rem] font-extrabold leading-tight text-th-text-primary line-clamp-2">
            {track.title}
            {track.version && (
              <span className="font-semibold text-th-text-muted">
                {" "}
                ({track.version})
              </span>
            )}
          </h1>
          <p className="mt-[0.4rem] text-[1.1rem] text-th-text-secondary truncate">
            {getTrackArtistDisplay(track)}
          </p>
          {track.album?.title && (
            <p className="mt-[0.2rem] text-[0.85rem] text-th-text-muted truncate">
              {track.album.title}
            </p>
          )}
          {quality && (
            <button
              data-tv-focusable
              onClick={() => setSignalPathOpen(true)}
              title="Signal path"
              className="tv-button mt-[0.8rem] inline-flex items-center gap-[0.5rem] rounded-[0.3rem] border border-th-border-subtle px-[0.5rem] py-[0.15rem] text-[0.6rem] font-bold tracking-[0.12em] text-th-accent"
            >
              {quality}
              <span className="font-semibold tracking-normal text-th-text-muted">
                · Signal path
              </span>
            </button>
          )}
          {signalPathOpen && (
            <TvNativeLayer width={680} height={720}>
              <SignalPathPanel open onClose={() => setSignalPathOpen(false)} />
            </TvNativeLayer>
          )}

          <div className="mt-[2rem]">
            <Progress
              duration={track.duration ?? 0}
              video={isVideo && !!currentVideo}
            />
          </div>

          <div className="mt-[1.4rem] flex flex-wrap items-center gap-[0.8rem]">
            <TvButton
              title="Shuffle"
              active={shuffle}
              icon={<Shuffle className={icon} />}
              onClick={toggleShuffle}
            />
            <TvButton
              title="Previous"
              icon={<SkipBack className={icon} fill="currentColor" />}
              onClick={() => void playPrevious()}
            />
            <TvButton
              primary
              autoFocus
              title={playing ? "Pause" : "Play"}
              icon={
                playing ? (
                  <Pause className={icon} fill="currentColor" />
                ) : (
                  <Play className={icon} fill="currentColor" />
                )
              }
              onClick={() => void togglePlayPause()}
            />
            <TvButton
              title="Next"
              icon={<SkipForward className={icon} fill="currentColor" />}
              onClick={() => void playNext({ explicit: true })}
            />
            <TvButton
              title={
                repeat === 2
                  ? "Repeat one"
                  : repeat === 1
                    ? "Repeat all"
                    : "Repeat off"
              }
              active={repeat !== 0}
              icon={
                repeat === 2 ? (
                  <Repeat1 className={icon} />
                ) : (
                  <Repeat className={icon} />
                )
              }
              onClick={() => setRepeat((repeat + 1) % 3)}
            />
          </div>

          <div className="mt-[1rem] flex flex-wrap items-center gap-[0.8rem]">
            <TvButton
              title={
                isVideo
                  ? liked
                    ? "Remove from favorites"
                    : "Add to favorites"
                  : liked
                    ? "Remove from My Tracks"
                    : "Add to My Tracks"
              }
              active={liked}
              icon={
                <Heart
                  className={icon}
                  fill={liked ? "currentColor" : "none"}
                />
              }
              onClick={() =>
                void (
                  isVideo
                    ? liked
                      ? removeFavoriteVideo(track.id)
                      : addFavoriteVideo(track.id)
                    : liked
                      ? removeFavoriteTrack(track.id)
                      : addFavoriteTrack(track.id, track)
                ).catch(() => {})
              }
            />
            {lyrics && (
              <TvButton
                active={lyricsOn}
                icon={<Mic2 className={icon} />}
                label="Lyrics"
                title={lyricsOn ? "Show cover" : "Show lyrics"}
                onClick={() => setLyricsOn(!lyricsOn)}
              />
            )}
            {isVideo && currentVideo && (
              <TvButton
                icon={<Maximize2 className={icon} />}
                label="Full screen"
                onClick={() => setVideoExpanded(true)}
              />
            )}
            {!isVideo && artist && (
              <TvButton
                label="Artist"
                onClick={() =>
                  nav.push({ type: "artist", id: artist.id, name: artist.name })
                }
              />
            )}
            {!isVideo && track.album?.id && (
              <TvButton
                label="Album"
                onClick={() =>
                  nav.push({
                    type: "album",
                    id: track.album!.id,
                    title: track.album!.title,
                  })
                }
              />
            )}
            <TvButton
              title="More options"
              icon={<MoreHorizontal className={icon} />}
              onClick={() => nav.openMenu(nav.trackMenu(track))}
            />
          </div>

          <div className="mt-[1rem] flex items-center">
            <VolumeControl />
          </div>
        </div>

        {upNext.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-[1rem] flex items-center justify-center gap-[0.4rem] text-[0.7rem] text-th-text-muted">
            <ChevronDown className="w-[1rem] h-[1rem]" />
            <span className="truncate max-w-[40rem]">
              Up next: {upNext[0].title}
            </span>
          </div>
        )}
      </div>

      {upNext.length > 0 && (
        <section
          ref={upNextRef}
          className="relative px-[3rem] pt-[1.5rem] pb-[3rem]"
        >
          <h2 className="text-[1.05rem] font-bold text-th-text-primary px-[1rem] mb-[0.4rem]">
            Up next
          </h2>
          {upNext.map((t, i) => (
            <TvTrackRow
              key={t._qid ?? `${t.id}:${i}`}
              track={t}
              index={i}
              showCover
              menuExtra={[
                {
                  label: "Remove from queue",
                  icon: ListX,
                  onSelect: () => {
                    removeFromQueue(i);
                    refocusUpNext(i);
                  },
                },
                {
                  label: "Clear queue",
                  icon: Trash2,
                  onSelect: () => {
                    clearQueue();
                    showToast("Queue cleared");
                    refocusUpNext(0);
                  },
                },
              ]}
              onSelect={() => {
                void playFromQueue(i);
                // The row just played leaves the list; go back up to the
                // player (Play/Pause) instead of losing focus.
                requestAnimationFrame(() => {
                  const el = screen.element();
                  if (el) focusFirstIn(el);
                });
              }}
            />
          ))}
        </section>
      )}
    </div>
  );
}
