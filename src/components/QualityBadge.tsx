import { memo } from "react";
import { useAtomValue } from "jotai";
import { currentTrackAtom, streamInfoAtom } from "../atoms/playback";
import { isCastingAtom } from "../atoms/tidalConnect";

interface QualityBadgeProps {
  onClick?: () => void;
}

const QualityBadge = memo(function QualityBadge({
  onClick,
}: QualityBadgeProps) {
  const currentTrack = useAtomValue(currentTrackAtom);
  const streamInfo = useAtomValue(streamInfoAtom);
  // While a TIDAL Connect receiver is selected the badge still names the
  // stream tier (the receiver pulls the same CDN tier), but a CAST chip
  // marks that playback is NOT running through the local pipeline.
  const isCasting = useAtomValue(isCastingAtom);

  const quality = streamInfo?.audioQuality || currentTrack?.audioQuality;
  if (!quality) return null;

  const isMax = quality === "HI_RES_LOSSLESS" || quality === "HI_RES";
  const isHiFi = quality === "LOSSLESS";

  const parts: string[] = [];
  if (streamInfo?.bitDepth) parts.push(`${streamInfo.bitDepth}-BIT`);
  if (streamInfo?.sampleRate) {
    const sr = streamInfo.sampleRate;
    parts.push(
      sr >= 1000
        ? `${(sr / 1000).toFixed(sr % 1000 === 0 ? 0 : 1)}kHz`
        : `${sr}Hz`,
    );
  }
  if (streamInfo?.codec) parts.push(streamInfo.codec);
  const detail = parts.join(" ");

  const label = isMax ? "HI-RES LOSSLESS" : isHiFi ? "LOSSLESS" : "HIGH";

  const tierPill = (
    <span
      className={`px-2 py-0.5 text-[9px] font-black rounded tracking-wider leading-none ${
        isMax
          ? "bg-th-accent text-th-on-accent"
          : isHiFi
            ? "bg-th-accent/70 text-th-on-accent"
            : "bg-th-button-hover text-th-text-primary"
      }`}
    >
      {label}
    </span>
  );

  const content = (
    <>
      {detail && (
        <span className="text-[9px] text-th-text-faint font-medium tracking-wide inline">
          {detail}
        </span>
      )}
      <span className="flex items-center gap-1">
        {tierPill}
        {isCasting && (
          <span className="px-1.5 py-0.5 text-[9px] font-black rounded tracking-wider leading-none border border-th-accent/60 text-th-accent">
            CAST
          </span>
        )}
      </span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title="Show signal path"
        className="flex flex-col items-end gap-0.5 cursor-pointer hover:opacity-80 transition-opacity"
      >
        {content}
      </button>
    );
  }

  return <div className="flex flex-col items-end gap-0.5">{content}</div>;
});

export default QualityBadge;
