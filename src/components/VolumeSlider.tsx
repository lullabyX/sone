import { memo } from "react";
import { useAtomValue } from "jotai";
import { Volume2, VolumeX, Volume1 } from "lucide-react";
import { volumeAtom, bitPerfectAtom } from "../atoms/playback";
import { usePlaybackActions } from "../hooks/usePlaybackActions";

interface VolumeSliderProps {
  /** Container width class (default "w-[120px]") */
  widthClass?: string;
  /** Ref to signal parent that a drag is in progress */
  isDraggingRef?: React.MutableRefObject<boolean>;
  /** Callback when drag ends */
  onDragEnd?: () => void;
}

const VolumeSlider = memo(function VolumeSlider({
  widthClass = "w-[120px]",
  isDraggingRef,
  onDragEnd,
}: VolumeSliderProps) {
  const volume = useAtomValue(volumeAtom);
  const bitPerfect = useAtomValue(bitPerfectAtom);
  const { setVolume } = usePlaybackActions();

  const displayVolume = bitPerfect ? 1 : volume;

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (bitPerfect) return;
    setVolume(parseFloat(e.target.value));
  };

  const VolumeIcon =
    displayVolume === 0 ? VolumeX : displayVolume < 0.5 ? Volume1 : Volume2;

  return (
    <div
      className={`flex items-center gap-2 group/vol ${widthClass} ${bitPerfect ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      <button
        onClick={() => {
          if (bitPerfect) return;
          setVolume(volume > 0 ? 0 : 1);
        }}
        className={`flex-shrink-0 transition-colors duration-150 ${
          bitPerfect
            ? "text-th-text-faint cursor-not-allowed"
            : "text-th-text-secondary hover:text-th-text-primary"
        }`}
        disabled={bitPerfect}
      >
        <VolumeIcon size={16} strokeWidth={2} />
      </button>
      <div
        className={`flex-1 relative rounded-full ${bitPerfect ? "cursor-not-allowed" : "cursor-pointer"}`}
      >
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={displayVolume}
          onChange={handleVolumeChange}
          onMouseDown={
            isDraggingRef
              ? () => {
                  isDraggingRef.current = true;
                  const onUp = () => {
                    isDraggingRef.current = false;
                    onDragEnd?.();
                    document.removeEventListener("mouseup", onUp);
                  };
                  document.addEventListener("mouseup", onUp);
                }
              : undefined
          }
          disabled={bitPerfect}
          className={`absolute inset-0 w-full h-full opacity-0 z-10 ${bitPerfect ? "cursor-not-allowed" : "cursor-pointer"}`}
        />
        <div className="relative h-[3px] group-hover/vol:h-[4px] transition-[height] duration-100 rounded-full">
          <div className="absolute inset-0 bg-th-slider-track rounded-full" />
          <div
            className="absolute h-full bg-th-slider-fill group-hover/vol:bg-th-accent rounded-full transition-colors duration-100"
            style={{ width: `${displayVolume * 100}%` }}
          />
          <div
            className="absolute top-1/2 -translate-y-1/2 w-[10px] h-[10px] bg-th-text-primary rounded-full shadow-sm opacity-0 group-hover/vol:opacity-100 transition-opacity duration-100"
            style={{ left: `calc(${displayVolume * 100}% - 5px)` }}
          />
        </div>
      </div>
    </div>
  );
});

export default VolumeSlider;
