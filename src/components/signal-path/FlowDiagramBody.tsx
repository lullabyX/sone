import { ArrowLeft } from "lucide-react";
import { dacDisplayName, type SignalPathViewProps } from "./types";
import { buildSignalFlow, type CableState } from "./flow";

type FlowProps = Omit<SignalPathViewProps, "onClose"> & {
  /** When true, hide the track header (caller already shows track context). */
  hideTrackHeader?: boolean;
  /** When provided, render a back-arrow inside the verdict footer (left side). */
  onBack?: () => void;
};

export default function FlowDiagramBody({
  sp,
  streamInfo,
  currentTrack,
  hideTrackHeader = false,
  onBack,
}: FlowProps) {
  const {
    nodes,
    cables,
    allAlterations,
    lossyCount,
    alteredCount,
    isPristineVerdict,
    losslessPromotion,
    trackTitle,
    trackArtist,
    sourceQualityLine,
    sourceQuality,
  } = buildSignalFlow(sp, streamInfo, currentTrack);

  const cableColor = (s: CableState): string =>
    s === "pristine"
      ? "bg-green-400"
      : s === "altered"
        ? "bg-amber-400"
        : "bg-red-400";

  const cableTextColor = (s: CableState): string =>
    s === "pristine"
      ? "text-green-400"
      : s === "altered"
        ? "text-amber-300"
        : "text-red-400";

  return (
    <>
      {/* Track header */}
      {!hideTrackHeader && (
        <div className="px-6 pt-5 pb-3">
          <div className="text-[13px] text-th-text-primary truncate pr-10">
            {trackTitle ? (
              <>
                <span className="font-medium">{trackTitle}</span>
                {trackArtist && (
                  <span className="text-th-text-muted"> — {trackArtist}</span>
                )}
              </>
            ) : (
              <span className="text-th-text-muted">No track</span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[10px] font-mono text-th-text-faint">
            {sourceQualityLine && <span>{sourceQualityLine}</span>}
            {sourceQuality && (
              <>
                <span className="text-th-text-faint/50">·</span>
                <span>{sourceQuality}</span>
              </>
            )}
            {dacDisplayName(sp) && (
              <>
                <span className="text-th-text-faint/50">·</span>
                <span className="truncate max-w-[260px]">
                  {dacDisplayName(sp)}
                </span>
              </>
            )}
            <div className="flex gap-1.5 ml-auto pr-2">
              {sp?.exclusiveMode && (
                <span className="px-1.5 py-0.5 rounded bg-th-inset text-th-text-muted tracking-wider">
                  EXCLUSIVE
                </span>
              )}
              {sp?.bitPerfect && (
                <span className="px-1.5 py-0.5 rounded bg-th-inset text-green-400 tracking-wider">
                  BIT-PERFECT
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Flow diagram */}
      <div className="px-6 pt-2 pb-5">
        <div className="flex items-stretch">
          {nodes.map((node, i) => (
            <div key={node.title} className="flex items-stretch flex-1">
              <div className="w-[120px] shrink-0 bg-th-surface border border-th-border-subtle rounded-lg px-2 py-2.5 flex flex-col items-center text-center">
                <div className="text-[10px] font-bold tracking-wider text-th-text-faint">
                  {node.title}
                </div>
                <div
                  className="text-[12px] font-mono text-th-text-primary mt-1.5 leading-tight"
                  style={{ fontFamily: "ui-monospace, monospace" }}
                >
                  {node.primary}
                </div>
                {node.secondary && (
                  <div
                    className="text-[11px] font-mono text-th-text-muted leading-tight"
                    style={{ fontFamily: "ui-monospace, monospace" }}
                  >
                    {node.secondary}
                  </div>
                )}
                {node.tertiary && (
                  <div className="text-[9px] text-th-text-faint mt-1 tracking-wide">
                    {node.tertiary}
                  </div>
                )}
              </div>

              {i < nodes.length - 1 && (
                <div className="flex-1 flex flex-col justify-center items-center relative px-1 min-w-[40px]">
                  <div className="w-full relative flex flex-col items-center justify-center h-8">
                    {cables[i].state === "pristine" ? (
                      <>
                        <div
                          className={`w-full h-[2px] ${cableColor(cables[i].state)}`}
                        />
                        <div className="h-[3px]" />
                        <div
                          className={`w-full h-[2px] ${cableColor(cables[i].state)}`}
                        />
                      </>
                    ) : (
                      <>
                        <div
                          className={`w-full h-[4px] ${cableColor(cables[i].state)}`}
                        />
                        <div
                          className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-th-elevated border-2 flex items-center justify-center text-[11px] font-bold ${
                            cables[i].state === "lossy"
                              ? "border-red-400 text-red-400"
                              : "border-amber-400 text-amber-300"
                          }`}
                        >
                          ╳
                        </div>
                      </>
                    )}
                  </div>
                  <div
                    className={`absolute -bottom-1 text-[9px] font-mono tracking-wide whitespace-nowrap ${cableTextColor(cables[i].state)}`}
                    style={{ fontFamily: "ui-monospace, monospace" }}
                  >
                    {cables[i].caption}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-7 flex items-center justify-center gap-4 text-[9px] text-th-text-faint tracking-wider">
          <div className="flex items-center gap-1.5">
            <div className="flex flex-col gap-[2px]">
              <div className="w-4 h-[2px] bg-green-400" />
              <div className="w-4 h-[2px] bg-green-400" />
            </div>
            <span>PRISTINE</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-[3px] bg-amber-400" />
            <span>ALTERED LOSSLESS</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-[3px] bg-red-400" />
            <span className="text-red-400/70">╳</span>
            <span>LOSSY</span>
          </div>
        </div>
      </div>

      {/* Alterations rows */}
      {allAlterations.length > 0 && (
        <div className="px-6 pb-4 border-t border-th-border-subtle pt-4 space-y-2">
          {allAlterations.map((a, idx) => (
            <div key={idx} className="flex items-start gap-3 text-[11px]">
              <span
                className={`mt-[1px] text-[12px] font-bold ${a.state === "lossy" ? "text-red-400" : "text-amber-300"}`}
              >
                ╳
              </span>
              <div
                className={`font-bold tracking-wider w-[120px] shrink-0 ${a.state === "lossy" ? "text-red-400" : "text-amber-300"}`}
              >
                {a.label}
              </div>
              <div
                className="font-mono text-th-text-primary w-[170px] shrink-0"
                style={{ fontFamily: "ui-monospace, monospace" }}
              >
                {a.detail}
              </div>
              <div className="text-th-text-muted flex-1">{a.reason}</div>
            </div>
          ))}
        </div>
      )}

      {/* Verdict line */}
      <div
        className={`relative px-4 py-3 border-t border-th-border-subtle flex items-center justify-center text-[11px] font-bold tracking-[0.15em] ${
          isPristineVerdict
            ? "text-green-400"
            : lossyCount > 0
              ? "text-red-400"
              : "text-amber-300"
        }`}
      >
        {onBack && (
          <button
            onClick={onBack}
            className="group absolute left-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium tracking-wider text-th-text-muted bg-th-surface/60 hover:bg-th-button-hover hover:text-th-text-primary transition-all border border-th-border-subtle hover:border-th-text-faint/30"
            aria-label="Back to verdict"
            title="Back to verdict"
          >
            <ArrowLeft
              size={11}
              className="transition-transform group-hover:-translate-x-0.5"
            />
            <span>BACK</span>
          </button>
        )}
        <span className="text-center">
          {isPristineVerdict
            ? losslessPromotion
              ? "PRISTINE · BIT-TRANSPARENT — LOSSLESS PROMOTION"
              : "PRISTINE — NO ALTERATIONS DETECTED"
            : lossyCount > 0
              ? `NOT PRISTINE — ${lossyCount} LOSSY STAGE${lossyCount === 1 ? "" : "S"}${
                  alteredCount > 0 ? ` · ${alteredCount} MODIFIED` : ""
                }`
              : alteredCount > 0
                ? `MODIFIED — ${alteredCount} STAGE${alteredCount === 1 ? "" : "S"}`
                : "MODIFIED"}
        </span>
      </div>
    </>
  );
}
