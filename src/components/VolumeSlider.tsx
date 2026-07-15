import { memo, useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { Volume2, VolumeX, Volume1 } from "lucide-react";
import {
  volumeAtom,
  bitPerfectAtom,
  playbackTargetAtom,
} from "../atoms/playback";
import { currentVideoAtom } from "../atoms/video";
import { sonosMutedAtom, sonosVolumeAtom } from "../atoms/sonos";
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
  const currentVideo = useAtomValue(currentVideoAtom);
  const playbackTarget = useAtomValue(playbackTargetAtom);
  const sonosVolume = useAtomValue(sonosVolumeAtom);
  const sonosMuted = useAtomValue(sonosMutedAtom);
  const setSonosMuted = useSetAtom(sonosMutedAtom);
  const { setVolume } = usePlaybackActions();

  // Bit-perfect locks the slider at unity — but only for LOCAL AUDIO. Video
  // audio is lossy and plays through the <video> element; while casting the
  // slider surfaces the Sonos GROUP volume (0-100 mapped onto the 0-1
  // slider) and setVolume routes by target.
  const casting = playbackTarget.type === "sonos";
  const locked = bitPerfect && !currentVideo && !casting;
  const displayVolume = casting ? sonosVolume / 100 : locked ? 1 : volume;

  const containerRef = useRef<HTMLDivElement>(null);
  const volumeRef = useRef(displayVolume);
  const lockedRef = useRef(locked);

  useEffect(() => {
    volumeRef.current = displayVolume;
    lockedRef.current = locked;
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const WHEEL_STEP = 0.05;
    const handleWheel = (e: WheelEvent) => {
      if (lockedRef.current) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP;
      const next = Math.min(1, Math.max(0, volumeRef.current + delta));
      setVolume(Math.round(next * 100) / 100);
    };
    // passive: false is required for preventDefault to take effect.
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [setVolume]);

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (locked) return;
    setVolume(parseFloat(e.target.value));
  };

  const iconVolume = casting && sonosMuted ? 0 : displayVolume;
  const VolumeIcon =
    iconVolume === 0 ? VolumeX : iconVolume < 0.5 ? Volume1 : Volume2;

  return (
    <div
      ref={containerRef}
      className={`flex items-center gap-2 group/vol ${widthClass} ${locked ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      <button
        onClick={() => {
          if (locked) return;
          if (casting) {
            const next = !sonosMuted;
            setSonosMuted(next);
            invoke("sonos_set_mute", { muted: next }).catch(() => {});
            return;
          }
          setVolume(volume > 0 ? 0 : 1);
        }}
        className={`flex-shrink-0 transition-colors duration-150 ${
          locked
            ? "text-th-text-faint cursor-not-allowed"
            : "text-th-text-secondary hover:text-th-text-primary"
        }`}
        disabled={locked}
      >
        <VolumeIcon size={16} strokeWidth={2} />
      </button>
      <div
        className={`flex-1 relative rounded-full ${locked ? "cursor-not-allowed" : "cursor-pointer"}`}
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
          disabled={locked}
          className={`absolute inset-0 w-full h-full opacity-0 z-10 ${locked ? "cursor-not-allowed" : "cursor-pointer"}`}
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
