import type { SignalPath } from "../../atoms/playback";
import type { StreamInfo, Track } from "../../types";

export interface SignalPathViewProps {
  sp: SignalPath | null;
  streamInfo: StreamInfo | null;
  currentTrack: Track | null;
  onClose: () => void;
}

export const EPS = 1e-3;

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

  // "Untouched" is a strict claim. Requires:
  //  - DirectAlsa backend (we own the ALSA device; OS mixer is bypassed)
  //  - exclusiveMode (no shared access could mix into our stream)
  //  - bitPerfect (pipeline is CONSTRUCTED to exclude modifying stages —
  //    no GStreamer `volume`/`audioresample`/dithering, just decode → ALSA)
  //  - No per-stage alteration detected (resample, format fallback, vol, RG)
  //
  // Without bitPerfect mode, the pipeline includes processing elements at
  // unity values — they SHOULD be passthrough but it's not guaranteed.
  // Calling that "untouched" would be overclaiming.
  const isUntouched =
    !!sp &&
    isDirectAlsa &&
    !!sp.exclusiveMode &&
    !!sp.bitPerfect &&
    sp.resampledFrom == null &&
    sp.formatFallbackFrom == null &&
    !userVolAltered &&
    !normAltered;

  return {
    userVol,
    normFactor,
    userVolAltered,
    normAltered,
    isDirectAlsa,
    isUntouched,
  };
}
