import { memo } from "react";
import { useAtomValue } from "jotai";
import { Play, Pause } from "lucide-react";
import { isPlayingAtom, playbackSourceAtom } from "../atoms/playback";
import { currentVideoAtom, videoPlayingAtom } from "../atoms/video";
import { usePlaybackActions } from "../hooks/usePlaybackActions";

interface SourcePlayButtonProps {
  sourceType: string;
  sourceId: string | number;
  onPlay: () => void;
}

const SourcePlayButton = memo(function SourcePlayButton({
  sourceType,
  sourceId,
  onPlay,
}: SourcePlayButtonProps) {
  const isPlaying = useAtomValue(isPlayingAtom);
  const currentVideo = useAtomValue(currentVideoAtom);
  const videoPlaying = useAtomValue(videoPlayingAtom);
  const playbackSource = useAtomValue(playbackSourceAtom);
  const { togglePlayPause } = usePlaybackActions();

  // A video source plays through the shared <video> element (videoPlayingAtom),
  // not the audio pipeline (isPlayingAtom); reflect whichever is live so the
  // pause/resume icon is correct for both. For audio sources currentVideo is null,
  // so this is identical to the previous isPlaying-only behavior.
  const effectivePlaying = currentVideo ? videoPlaying : isPlaying;
  const fromThisSource =
    playbackSource?.type === sourceType && playbackSource?.id === sourceId;
  const buttonState = fromThisSource
    ? effectivePlaying
      ? "pause"
      : "resume"
    : "play";

  const handleClick = async () => {
    if (fromThisSource) {
      await togglePlayPause();
      return;
    }
    onPlay();
  };

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-2 px-6 py-2.5 bg-th-accent text-th-on-accent font-bold text-sm rounded-full shadow-lg hover:brightness-110 hover:scale-[1.03] transition-[transform,filter] duration-150"
    >
      {buttonState === "pause" ? (
        <Pause size={18} fill="currentColor" className="text-th-on-accent" />
      ) : (
        <Play size={18} fill="currentColor" className="text-th-on-accent" />
      )}
      {buttonState === "pause"
        ? "Pause"
        : buttonState === "resume"
          ? "Resume"
          : "Play"}
    </button>
  );
});

export default SourcePlayButton;
