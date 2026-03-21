import { memo } from "react";
import { useAtomValue } from "jotai";
import { Play, Pause } from "lucide-react";
import { isPlayingAtom, playbackSourceAtom } from "../atoms/playback";
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
  const playbackSource = useAtomValue(playbackSourceAtom);
  const { pauseTrack, resumeTrack } = usePlaybackActions();

  const fromThisSource =
    playbackSource?.type === sourceType && playbackSource?.id === sourceId;
  const buttonState = fromThisSource
    ? isPlaying
      ? "pause"
      : "resume"
    : "play";

  const handleClick = async () => {
    if (fromThisSource) {
      if (isPlaying) {
        await pauseTrack();
      } else {
        await resumeTrack();
      }
      return;
    }
    onPlay();
  };

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-2 px-6 py-2.5 bg-th-accent text-black font-bold text-sm rounded-full shadow-lg hover:brightness-110 hover:scale-[1.03] transition-[transform,filter] duration-150"
    >
      {buttonState === "pause" ? (
        <Pause size={18} fill="black" className="text-black" />
      ) : (
        <Play size={18} fill="black" className="text-black" />
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
