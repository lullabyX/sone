/**
 * SignalPathPanel — modal that surfaces what's happening between the
 * decoded source and the DAC. Compact verdict by default; expand for
 * the full flow diagram.
 */

import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { ArrowRight, X } from "lucide-react";
import {
  signalPathAtom,
  streamInfoAtom,
  currentTrackAtom,
} from "../atoms/playback";
import FlowDiagramBody from "./signal-path/FlowDiagramBody";
import {
  amplitudeToSliderPercent,
  dacDisplayName,
  deriveAlterations,
  displayFormat,
  formatRate,
  gainFactorToDb,
} from "./signal-path/types";
import { useSignalPathRefresh } from "../hooks/useSignalPathRefresh";

interface SignalPathPanelProps {
  open: boolean;
  onClose: () => void;
}

export default function SignalPathPanel({
  open,
  onClose,
}: SignalPathPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const sp = useAtomValue(signalPathAtom);
  const streamInfo = useAtomValue(streamInfoAtom);
  const currentTrack = useAtomValue(currentTrackAtom);

  useSignalPathRefresh(open);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Reset expanded state when the modal closes so it always opens at the
  // compact verdict, not where the user left it.
  useEffect(() => {
    if (!open) setExpanded(false);
  }, [open]);

  if (!open) return null;

  const {
    userVol,
    normFactor,
    userVolAltered,
    normAltered,
    isDirectAlsa,
    isPristine,
    lossyFormatChange,
  } = deriveAlterations(sp);

  const sourceBits = streamInfo?.bitDepth;
  const sourceRate = streamInfo?.sampleRate;
  const sourceCodec = streamInfo?.codec;
  const sourceSummary = [
    sourceCodec?.toUpperCase(),
    sourceBits && sourceRate
      ? `${sourceBits}/${(sourceRate / 1000).toFixed(sourceRate % 1000 === 0 ? 0 : 1)}`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  let headline: string;
  if (!sp || !sp.backend) {
    headline = "Idle — no track playing";
  } else if (!sp.dac && !sp.outputFormat) {
    headline = "Pipeline starting…";
  } else if (sp.dac?.state === "Closed") {
    headline = "DAC inactive — output may be routed elsewhere";
  } else if (isPristine) {
    headline = sourceSummary
      ? `${sourceSummary} reaches your DAC untouched`
      : "Source PCM reaches your DAC untouched";
  } else if (sp?.resampledFrom && sp?.resampledTo) {
    headline = `Resampled ${formatRate(sp.resampledFrom)} → ${formatRate(sp.resampledTo)}`;
  } else if (sp?.formatFallbackFrom && sp?.formatFallbackTo) {
    headline = `DAC refused ${sp.formatFallbackFrom} — fell back to ${sp.formatFallbackTo}`;
  } else if (lossyFormatChange) {
    headline = `Bit-depth reduced ${displayFormat(sp?.decodedFormat)} → ${displayFormat(sp?.outputFormat)}`;
  } else if (normAltered && userVolAltered) {
    headline = "Samples scaled by volume slider and ReplayGain";
  } else if (normAltered) {
    headline = `ReplayGain applied · ${gainFactorToDb(normFactor)}`;
  } else if (userVolAltered) {
    headline = `Volume slider scaling samples · ${amplitudeToSliderPercent(userVol)}%`;
  } else if (sp?.osMixer && !isDirectAlsa) {
    headline = `Routed through ${sp.osMixer.server}`;
  } else if (sp && !sp.bitPerfect) {
    headline = "Bit-perfect mode off — pipeline at unity, not guaranteed";
  } else {
    headline = "Pipeline pass-through";
  }

  const verdictWord = isPristine ? "PRISTINE" : "MODIFIED";
  const ringColor = isPristine ? "border-green-400" : "border-amber-400";
  const wordColor = isPristine ? "text-green-400" : "text-amber-300";
  const dotColor = isPristine ? "bg-green-400" : "bg-amber-400";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={panelRef}
        className="bg-th-elevated rounded-xl shadow-2xl overflow-hidden relative transition-[width] duration-500"
        style={{
          width: expanded ? 680 : 480,
          transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
          animation: "fadeIn 0.2s ease-out",
        }}
      >
        <div className="absolute top-3 right-3 z-20">
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-th-inset transition-colors text-th-text-muted hover:text-th-text-primary"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content-swap: two independent single-track grids, each toggling
            its track between 1fr (full content) and 0fr (collapsed). Using
            separate grids avoids the two-row `1fr 0fr` quirk where the
            inactive row's max-content can leak into the container's
            auto height. The modal's height is now strictly the active
            child's content height. */}
        <div>
          {/* Compact verdict */}
          <div
            className="grid transition-[grid-template-rows] duration-500"
            style={{
              gridTemplateRows: expanded ? "0fr" : "1fr",
              transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          >
          <div className="overflow-hidden min-h-0">
            <div
              className="transition-opacity duration-300"
              style={{
                opacity: expanded ? 0 : 1,
                transitionDelay: expanded ? "0ms" : "200ms",
              }}
            >
              <div className="px-8 pt-12 pb-7 flex flex-col items-center text-center">
                <div
                  className="relative w-44 h-44 mb-7 flex items-center justify-center"
                  style={{
                    animation: "signalPathPulse 2.8s ease-in-out infinite",
                  }}
                >
                  <div
                    className={`absolute inset-0 rounded-full border-[3px] ${ringColor}`}
                    style={{ opacity: 0.55 }}
                  />
                  <div
                    className={`absolute inset-2 rounded-full border ${ringColor}`}
                    style={{ opacity: 0.18 }}
                  />
                  <span
                    className={`text-[19px] font-bold tracking-[0.18em] ${wordColor}`}
                    style={{ fontFamily: "ui-monospace, monospace" }}
                  >
                    {verdictWord}
                  </span>
                </div>

                <div className="text-[13px] text-th-text-primary max-w-[360px] mb-4 leading-relaxed">
                  {headline}
                </div>

                {/* Source quality + DAC name — gives the compact view enough
                    factual context to be useful without expanding. */}
                {(sourceSummary || dacDisplayName(sp)) && (
                  <div className="flex flex-col items-center gap-0.5 mb-4 max-w-[360px]">
                    {sourceSummary && (
                      <div className="text-[11px] font-mono text-th-text-muted">
                        {sourceSummary}
                        {streamInfo?.audioQuality && (
                          <>
                            <span className="text-th-text-faint/40"> · </span>
                            <span className="text-th-text-faint">
                              {streamInfo.audioQuality}
                            </span>
                          </>
                        )}
                      </div>
                    )}
                    {dacDisplayName(sp) && (
                      <div className="text-[11px] text-th-text-muted truncate max-w-[360px]">
                        {dacDisplayName(sp)}
                      </div>
                    )}
                  </div>
                )}

                {(sp?.exclusiveMode ||
                  sp?.bitPerfect ||
                  sp?.backend ||
                  (sp?.osMixer && !isDirectAlsa)) && (
                  <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10.5px] font-mono text-th-text-faint mb-6 uppercase tracking-wider">
                    {sp?.exclusiveMode && <span>exclusive</span>}
                    {sp?.bitPerfect && (
                      <>
                        {sp?.exclusiveMode && (
                          <span className="text-th-text-faint/40">·</span>
                        )}
                        <span>bit-perfect</span>
                      </>
                    )}
                    {sp?.osMixer && !isDirectAlsa && (
                      <>
                        {(sp?.exclusiveMode || sp?.bitPerfect) && (
                          <span className="text-th-text-faint/40">·</span>
                        )}
                        <span>{sp.osMixer.server}</span>
                      </>
                    )}
                    {sp?.backend && (
                      <>
                        {(sp?.exclusiveMode ||
                          sp?.bitPerfect ||
                          (sp?.osMixer && !isDirectAlsa)) && (
                          <span className="text-th-text-faint/40">·</span>
                        )}
                        <span>{sp.backend}</span>
                      </>
                    )}
                  </div>
                )}

                <button
                  onClick={() => setExpanded(true)}
                  className="group flex items-center gap-2 px-4 py-2 rounded-full text-[11px] font-medium tracking-wider text-th-text-muted bg-th-surface/60 hover:bg-th-button-hover hover:text-th-text-primary transition-all border border-th-border-subtle hover:border-th-text-faint/30"
                >
                  <span>SEE THE FULL PATH</span>
                  <ArrowRight
                    size={12}
                    className="transition-transform group-hover:translate-x-0.5"
                  />
                </button>
              </div>
            </div>
          </div>
          </div>

          {/* Flow diagram */}
          <div
            className="grid transition-[grid-template-rows] duration-500"
            style={{
              gridTemplateRows: expanded ? "1fr" : "0fr",
              transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          >
          <div className="overflow-hidden min-h-0">
            <div
              className="transition-opacity duration-300"
              style={{
                opacity: expanded ? 1 : 0,
                transitionDelay: expanded ? "200ms" : "0ms",
              }}
            >
              <div className="pl-6 pr-24 pt-5 pb-3 flex items-center gap-3 border-b border-th-border-subtle">
                <div className={`w-2.5 h-2.5 rounded-full ${dotColor} shrink-0`} />
                <div className="flex-1 min-w-0">
                  <div
                    className={`text-[14px] font-bold tracking-[0.15em] ${wordColor}`}
                    style={{ fontFamily: "ui-monospace, monospace" }}
                  >
                    {verdictWord}
                  </div>
                  <div className="text-[11px] text-th-text-muted mt-0.5 truncate">
                    {headline}
                  </div>
                </div>
              </div>

              <FlowDiagramBody
                sp={sp}
                streamInfo={streamInfo}
                currentTrack={currentTrack}
                onBack={() => setExpanded(false)}
              />
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}
