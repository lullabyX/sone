import type { SignalPath } from "../../atoms/playback";
import type { StreamInfo, Track } from "../../types";

export interface SignalPathViewProps {
  sp: SignalPath | null;
  streamInfo: StreamInfo | null;
  currentTrack: Track | null;
  onClose: () => void;
}

export const EPS = 1e-3;

function normalizeFormat(s: string): string {
  return s
    .toLowerCase()
    .replace(/[_-]/g, "")       // strip underscores and dashes
    .replace(/^float(32|64)?$/, "float");  // f32/float32/float → float
}

/**
 * Compare two PCM format strings for semantic equivalence.
 * Tolerates GStreamer ("S24LE"), ALSA ("S24_LE"), and pactl ("s24le") naming.
 */
export function formatsEquivalent(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return normalizeFormat(a) === normalizeFormat(b);
}

export function formatRate(hz: number | null | undefined): string | null {
  if (!hz) return null;
  return hz >= 1000
    ? `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz`
    : `${hz} Hz`;
}

export function gainFactorToDb(factor: number): string {
  if (Math.abs(factor - 1.0) < EPS) return "0.0 dB";
  if (factor <= 0) return "−∞ dB";
  const db = 20 * Math.log10(factor);
  return `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

export function deriveAlterations(sp: SignalPath | null) {
  const userVol = sp?.userVolume ?? 1.0;
  const normFactor = sp?.normGainFactor ?? 1.0;
  const userVolAltered = Math.abs(userVol - 1.0) > EPS;
  const normAltered =
    !!sp?.volumeNormalization && Math.abs(normFactor - 1.0) > EPS;
  const isDirectAlsa = sp?.backend === "DirectAlsa";

  // "Pristine" is a strict claim. Requires:
  //  - DirectAlsa backend (we own the ALSA device; OS mixer is bypassed)
  //  - exclusiveMode (no shared access could mix into our stream)
  //  - bitPerfect (pipeline excludes modifying stages by construction)
  //  - No per-stage alteration detected (resample, format fallback, vol, RG)
  //  - DAC kernel hw_params matches our pipeline's output format/rate
  //    (or no DAC info available, in which case we don't punish)
  // What feeds the kernel? DirectAlsa: our pipeline's appsink output (we own
  // the ALSA device directly). Normal: the OS mixer's per-sink spec
  // (PipeWire/Pulse owns the device, our pipeline only hands off audio).
  const upstreamFormat = isDirectAlsa
    ? sp?.outputFormat
    : sp?.osMixer?.sinkFormat ?? sp?.outputFormat;
  const upstreamRate = isDirectAlsa
    ? sp?.outputRate
    : sp?.osMixer?.sinkRate ?? sp?.outputRate;

  const dacMatchesPipeline =
    !sp?.dac ||
    sp.dac.state !== "Active" ||
    (formatsEquivalent(sp.dac.format, upstreamFormat ?? null) &&
      sp.dac.rate === upstreamRate);

  const isPristine =
    !!sp &&
    isDirectAlsa &&
    !!sp.exclusiveMode &&
    !!sp.bitPerfect &&
    sp.resampledFrom == null &&
    sp.formatFallbackFrom == null &&
    !userVolAltered &&
    !normAltered &&
    dacMatchesPipeline;

  return {
    userVol,
    normFactor,
    userVolAltered,
    normAltered,
    isDirectAlsa,
    isPristine,
  };
}
