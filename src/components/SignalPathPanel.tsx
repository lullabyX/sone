/**
 * SignalPathPanel — bit-perfect transparency panel.
 *
 * Honest visualization of how audio flows from TIDAL to the DAC. No
 * cryptographic claim — TIDAL doesn't expose source PCM hashes — just an
 * unblinking display of what each stage of the pipeline reports, with the
 * "Untouched signal path" verdict only awarded when bit-perfect+exclusive
 * are on and nothing along the way altered the bits.
 */

import { useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { X, Check, AlertTriangle } from "lucide-react";
import {
  signalPathAtom,
  streamInfoAtom,
  currentTrackAtom,
} from "../atoms/playback";

interface SignalPathPanelProps {
  open: boolean;
  onClose: () => void;
}

const EPS = 1e-3;

function formatRate(hz: number | null | undefined): string | null {
  if (!hz) return null;
  return hz >= 1000
    ? `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz`
    : `${hz} Hz`;
}

function gainFactorToDb(factor: number): string {
  if (Math.abs(factor - 1.0) < EPS) return "0.0 dB";
  if (factor <= 0) return "−∞ dB";
  const db = 20 * Math.log10(factor);
  return `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

export default function SignalPathPanel({
  open,
  onClose,
}: SignalPathPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const sp = useAtomValue(signalPathAtom);
  const streamInfo = useAtomValue(streamInfoAtom);
  const currentTrack = useAtomValue(currentTrackAtom);

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

  if (!open) return null;

  const sourceBits = streamInfo?.bitDepth;
  const sourceRate = streamInfo?.sampleRate;
  const sourceCodec = streamInfo?.codec;
  const sourceQuality =
    streamInfo?.audioQuality || currentTrack?.audioQuality || null;

  const sourceParts: string[] = [];
  if (sourceCodec) sourceParts.push(sourceCodec.toUpperCase());
  if (sourceBits) sourceParts.push(`${sourceBits}-bit`);
  const srStr = formatRate(sourceRate);
  if (srStr) sourceParts.push(srStr);

  const decodedParts: string[] = [];
  if (sp?.decodedFormat) decodedParts.push(sp.decodedFormat);
  const decRate = formatRate(sp?.decodedRate ?? null);
  if (decRate) decodedParts.push(decRate);
  if (sp?.decodedChannels) decodedParts.push(`${sp.decodedChannels}ch`);

  const outputParts: string[] = [];
  if (sp?.outputFormat) outputParts.push(sp.outputFormat);
  const outRate = formatRate(sp?.outputRate ?? null);
  if (outRate) outputParts.push(outRate);
  if (sp?.outputChannels) outputParts.push(`${sp.outputChannels}ch`);

  const userVol = sp?.userVolume ?? 1.0;
  const normFactor = sp?.normGainFactor ?? 1.0;
  const userVolAltered = Math.abs(userVol - 1.0) > EPS;
  const normAltered =
    sp?.volumeNormalization && Math.abs(normFactor - 1.0) > EPS;

  const isDirectAlsa = sp?.backend === "DirectAlsa";
  const isUntouched =
    isDirectAlsa &&
    !!sp?.bitPerfect &&
    !!sp?.exclusiveMode &&
    sp?.resampledFrom == null &&
    sp?.formatFallbackFrom == null &&
    !userVolAltered &&
    !normAltered;

  const alterations: { label: string; detail?: string; lossless?: boolean }[] =
    [];

  if (sp?.resampledFrom && sp?.resampledTo) {
    alterations.push({
      label: "Resampled",
      detail: `${formatRate(sp.resampledFrom)} → ${formatRate(sp.resampledTo)}`,
    });
  }

  if (sp?.promotedFrom && sp?.promotedTo) {
    alterations.push({
      label: "Container promoted",
      detail: `${sp.promotedFrom} → ${sp.promotedTo} (lossless zero-pad)`,
      lossless: true,
    });
  }

  if (sp?.formatFallbackFrom && sp?.formatFallbackTo) {
    alterations.push({
      label: "Format fallback",
      detail: `${sp.formatFallbackFrom} → ${sp.formatFallbackTo} (DAC didn't accept requested)`,
    });
  }

  if (normAltered) {
    alterations.push({
      label: "ReplayGain",
      detail: gainFactorToDb(normFactor),
    });
  }

  if (userVolAltered) {
    alterations.push({
      label: "Software volume",
      detail: `${Math.round(userVol * 100)}%`,
    });
  }

  if (!isDirectAlsa) {
    alterations.push({
      label: "System mixer",
      detail: "PulseAudio/PipeWire — may resample to 48 kHz",
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={panelRef}
        className="w-[440px] bg-th-elevated rounded-xl shadow-2xl max-h-[80vh] flex flex-col overflow-hidden"
        style={{ animation: "slideUp 0.2s ease-out" }}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h2 className="text-[16px] font-bold text-th-text-primary">
            Signal path
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-th-inset transition-colors text-th-text-muted hover:text-th-text-primary"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-4 overflow-y-auto">
          {/* Verdict */}
          <div
            className={`flex items-start gap-2 p-3 rounded-lg ${
              isUntouched
                ? "bg-green-500/10 border border-green-500/30"
                : "bg-amber-500/10 border border-amber-500/30"
            }`}
          >
            {isUntouched ? (
              <Check size={18} className="text-green-400 mt-0.5 shrink-0" />
            ) : (
              <AlertTriangle
                size={18}
                className="text-amber-400 mt-0.5 shrink-0"
              />
            )}
            <div>
              <div
                className={`text-[13px] font-semibold ${
                  isUntouched ? "text-green-300" : "text-amber-300"
                }`}
              >
                {isUntouched ? "Untouched signal path" : "Signal modified"}
              </div>
              <div className="text-[11px] text-th-text-muted mt-0.5">
                {isUntouched
                  ? "Bit-exact: source PCM reaches the DAC unaltered."
                  : "See alterations below for what changed the bits."}
              </div>
            </div>
          </div>

          {/* Stages */}
          <div className="space-y-2">
            <Stage
              label="SOURCE"
              line1={sourceParts.join(" · ") || "—"}
              line2={sourceQuality ?? undefined}
            />
            <Arrow />
            <Stage
              label="DECODED (GStreamer)"
              line1={
                decodedParts.join(" · ") ||
                (isDirectAlsa ? "—" : "Hidden by system mixer")
              }
            />
            <Arrow />
            <Stage
              label="OUTPUT (ALSA)"
              line1={
                outputParts.join(" · ") ||
                (isDirectAlsa ? "—" : "autoaudiosink (system mixer)")
              }
              line2={sp?.outputDevice ?? undefined}
            />
          </div>

          {/* Mode flags */}
          <div className="flex flex-wrap gap-2">
            {sp?.exclusiveMode && <ModeBadge label="Exclusive" />}
            {sp?.bitPerfect && <ModeBadge label="Bit-perfect" highlight />}
            {sp?.volumeNormalization && <ModeBadge label="ReplayGain" />}
            {!isDirectAlsa && <ModeBadge label="System mixer" muted />}
          </div>

          {/* Alterations */}
          {alterations.length > 0 && (
            <div>
              <div className="text-[10px] font-bold tracking-wider text-th-text-faint mb-1.5">
                ALTERATIONS
              </div>
              <ul className="space-y-1">
                {alterations.map((a, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-[12px] text-th-text-primary"
                  >
                    <span
                      className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${
                        a.lossless ? "bg-th-text-muted" : "bg-amber-400"
                      }`}
                    />
                    <span>
                      <span className="font-medium">{a.label}</span>
                      {a.detail && (
                        <span className="text-th-text-muted">
                          {" "}
                          — {a.detail}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {sp?.backend && (
            <div className="text-[10px] text-th-text-faint pt-1 border-t border-th-border-subtle">
              Backend: {sp.backend}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stage({
  label,
  line1,
  line2,
}: {
  label: string;
  line1: string;
  line2?: string;
}) {
  return (
    <div className="rounded-md bg-th-surface px-3 py-2">
      <div className="text-[10px] font-bold tracking-wider text-th-text-faint">
        {label}
      </div>
      <div className="text-[13px] font-mono text-th-text-primary mt-0.5">
        {line1}
      </div>
      {line2 && (
        <div className="text-[11px] font-mono text-th-text-muted truncate">
          {line2}
        </div>
      )}
    </div>
  );
}

function Arrow() {
  return (
    <div className="flex justify-center text-th-text-faint text-sm leading-none -my-1">
      ↓
    </div>
  );
}

function ModeBadge({
  label,
  highlight,
  muted,
}: {
  label: string;
  highlight?: boolean;
  muted?: boolean;
}) {
  const cls = highlight
    ? "bg-th-accent text-black"
    : muted
      ? "bg-th-button-hover text-th-text-muted"
      : "bg-th-accent/30 text-th-accent";
  return (
    <span
      className={`px-2 py-0.5 text-[10px] font-bold tracking-wider rounded ${cls}`}
    >
      {label}
    </span>
  );
}
