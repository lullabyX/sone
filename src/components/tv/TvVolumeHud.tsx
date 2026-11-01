import { useEffect, useState } from "react";
import { useAtomValue, useStore } from "jotai";
import { Lock, Volume1, Volume2, VolumeX } from "lucide-react";
import { volumeAtom } from "../../atoms/playback";
import { tvVolumeLimitPingAtom, tvVolumeLockedPingAtom } from "../../atoms/tv";

const HUD_MS = 2000;

/** Shows the volume for a moment after each change (any source), or why it
 *  cannot change while bit-perfect output locks it. Never takes focus. */
export default function TvVolumeHud() {
  const store = useStore();
  const volume = useAtomValue(volumeAtom);
  const [mode, setMode] = useState<"level" | "locked" | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    const show = (next: "level" | "locked") => {
      setMode(next);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setMode(null), HUD_MS);
    };
    const offVolume = store.sub(volumeAtom, () => show("level"));
    const offLimit = store.sub(tvVolumeLimitPingAtom, () => show("level"));
    const offLocked = store.sub(tvVolumeLockedPingAtom, () => show("locked"));
    return () => {
      offVolume();
      offLimit();
      offLocked();
      window.clearTimeout(timer);
    };
  }, [store]);

  if (!mode) return null;
  const pct = Math.round(volume * 100);
  const muted = mode === "level" && volume === 0;
  const Icon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div className="fixed inset-0 z-[10000] tv-overlay pointer-events-none flex items-start justify-end">
      <div
        role="status"
        aria-live="polite"
        data-muted={muted || undefined}
        className="m-[1.5rem] flex items-center gap-[0.8rem] rounded-[0.9rem] bg-th-elevated px-[1.1rem] py-[0.8rem] shadow-2xl"
      >
        {mode === "locked" ? (
          <>
            <Lock className="w-[1.3rem] h-[1.3rem] text-th-text-secondary shrink-0" />
            <span className="text-[0.95rem] font-semibold text-th-text-primary whitespace-nowrap">
              Volume fixed · bit-perfect output
            </span>
          </>
        ) : (
          <>
            <Icon className="w-[1.3rem] h-[1.3rem] text-th-text-primary shrink-0" />
            <span className="relative w-[9rem] h-[0.35rem] rounded-full bg-th-slider-track">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-th-accent"
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="w-[2.8rem] text-right text-[0.95rem] font-semibold text-th-text-primary tabular-nums">
              {pct}%
            </span>
          </>
        )}
      </div>
    </div>
  );
}
