import { useAtomValue } from "jotai";
import { Heart, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import TidalImage from "../TidalImage";
import { currentTrackAtom, isPlayingAtom } from "../../atoms/playback";
import { currentVideoAtom, videoPlayingAtom } from "../../atoms/video";
import { getTidalImageUrl, type Track } from "../../types";
import { getTrackArtistDisplay, trackCoverId } from "../../utils/itemHelpers";
import { useTvNav } from "./TvNavContext";
import { useTvLike } from "./useTvLike";
import { useTvMediaCommands } from "./useTvMediaCommands";

const buttonClass =
  "tv-button inline-flex items-center justify-center w-[2.6rem] h-[2.6rem] rounded-full shrink-0";
const icon = "w-[1.1rem] h-[1.1rem]";

function MiniLike({ track }: { track: Track }) {
  const { liked, label, toggle } = useTvLike(track);
  return (
    <button
      data-tv-focusable
      aria-label={label}
      title={label}
      aria-pressed={liked}
      onClick={toggle}
      className={`${buttonClass} bg-th-button ${
        liked ? "text-th-accent" : "text-th-text-primary"
      }`}
    >
      <Heart className={icon} fill={liked ? "currentColor" : "none"} />
    </button>
  );
}

/** Slim now-playing strip along the bottom: the track opens Now Playing,
 *  the buttons control playback without leaving the screen. */
export default function TvMiniBar() {
  const nav = useTvNav();
  const media = useTvMediaCommands();
  const track = useAtomValue(currentTrackAtom);
  const isPlaying = useAtomValue(isPlayingAtom);
  const currentVideo = useAtomValue(currentVideoAtom);
  const videoPlaying = useAtomValue(videoPlayingAtom);
  if (!track) return null;
  const playing = currentVideo ? videoPlaying : isPlaying;
  return (
    <div
      data-tv-dock
      data-tv-remember
      role="region"
      aria-label="Now playing"
      className="shrink-0 flex items-center gap-[1rem] h-[3.6rem] pl-[1.5rem] pr-[3rem] bg-th-surface border-t border-th-border-subtle"
    >
      <button
        data-tv-focusable
        aria-label="Open Now Playing"
        onClick={() => nav.openNowPlaying()}
        className="tv-track min-w-0 flex-1 flex items-center gap-[1rem] h-[3rem] px-[0.5rem] rounded-[0.5rem] text-left"
      >
        <TidalImage
          src={getTidalImageUrl(trackCoverId(track), 160) || undefined}
          alt=""
          className="w-[2.6rem] h-[2.6rem] rounded-[0.3rem] overflow-hidden shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.8rem] font-semibold text-th-text-primary">
            {track.title}
          </div>
          <div className="truncate text-[0.75rem] text-th-text-muted">
            {getTrackArtistDisplay(track)}
          </div>
        </div>
      </button>
      <MiniLike track={track} />
      <button
        data-tv-focusable
        aria-label="Previous"
        title="Previous"
        onClick={() => media({ kind: "previous" })}
        className={`${buttonClass} bg-th-button text-th-text-primary`}
      >
        <SkipBack className={icon} fill="currentColor" />
      </button>
      <button
        data-tv-focusable
        data-tv-default
        aria-label={playing ? "Pause" : "Play"}
        title={playing ? "Pause" : "Play"}
        onClick={() => media({ kind: "toggle" })}
        className={`${buttonClass} bg-th-accent text-th-on-accent`}
      >
        {playing ? (
          <Pause className={icon} fill="currentColor" />
        ) : (
          <Play className={icon} fill="currentColor" />
        )}
      </button>
      <button
        data-tv-focusable
        aria-label="Next"
        title="Next"
        onClick={() => media({ kind: "next" })}
        className={`${buttonClass} bg-th-button text-th-text-primary`}
      >
        <SkipForward className={icon} fill="currentColor" />
      </button>
    </div>
  );
}
