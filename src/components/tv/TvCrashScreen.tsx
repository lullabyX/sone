import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { useVideoPlayback } from "../../hooks/useVideoPlayback";
import { TvButton } from "./TvParts";
import { useTvLocalNav } from "./useTvLocalNav";

export default function TvCrashScreen({
  onReload,
  onExit,
}: {
  onReload: () => void;
  onExit: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { closeVideo } = useVideoPlayback();
  useTvLocalNav(rootRef, null);

  // The video player outlives the crash and sits above it.
  useEffect(() => {
    closeVideo();
  }, [closeVideo]);

  return (
    <div
      ref={rootRef}
      className="tv-root h-full w-full flex items-center justify-center bg-th-base text-th-text-primary"
    >
      <div className="flex flex-col items-center gap-[1.2rem] text-center">
        <AlertTriangle className="w-[3rem] h-[3rem] text-th-text-disabled" />
        <p className="text-[1.6rem] font-bold">Something went wrong</p>
        <div className="mt-[0.8rem] flex gap-[0.8rem]">
          <TvButton primary autoFocus label="Reload" onClick={onReload} />
          <TvButton label="Exit TV mode" onClick={onExit} />
        </div>
      </div>
    </div>
  );
}
