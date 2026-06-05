import type { SignalPath } from "../../atoms/playback";
import type { StreamInfo, Track } from "../../types";

export interface SignalPathViewProps {
  sp: SignalPath | null;
  streamInfo: StreamInfo | null;
  currentTrack: Track | null;
  onClose: () => void;
}

export const EPS = 1e-3;

/** ALSA naming → canonical GStreamer naming. Pure mapping table. */
const ALSA_TO_GSTREAMER: Record<string, string> = {
  S16_LE: "S16LE",
  S24_LE: "S24_32LE",
  S24_3LE: "S24LE",
  S32_LE: "S32LE",
  FLOAT_LE: "F32LE",
  S16_BE: "S16BE",
  S24_BE: "S24_32BE",
  S24_3BE: "S24BE",
  S32_BE: "S32BE",
  FLOAT_BE: "F32BE",
};

/** Convert any naming convention (ALSA / GStreamer / pactl) to canonical GStreamer form. */
function toGstreamerFormat(s: string): string {
  // Uppercase and convert pactl's dashes to underscores.
  const upper = s.toUpperCase().replace(/-/g, "_");
  // ALSA → GStreamer.
  if (ALSA_TO_GSTREAMER[upper]) return ALSA_TO_GSTREAMER[upper];
  // pactl float aliases.
  if (upper === "FLOAT" || upper === "FLOAT32" || upper === "FLOAT32LE")
    return "F32LE";
  if (upper === "FLOAT64" || upper === "FLOAT64LE") return "F64LE";
  // Already canonical (or unknown — leave as-is).
  return upper;
}

/**
 * Render a PCM format for the UI. Canonicalizes to GStreamer naming so
 * S24_32LE (4-byte container) and S24LE (3-byte packed) stay visibly
 * distinct regardless of whether the source string came from /proc/asound
 * (ALSA), GStreamer pad caps, or pactl.
 */
export function displayFormat(s: string | null | undefined): string {
  if (!s) return "—";
  return toGstreamerFormat(s);
}

/**
 * Compare two PCM format strings for semantic equivalence across naming
 * conventions. ALSA "S24_LE" matches GStreamer "S24_32LE"; pactl "s32le"
 * matches ALSA "S32_LE"; etc.
 */
export function formatsEquivalent(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return toGstreamerFormat(a) === toGstreamerFormat(b);
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

/**
 * Recover the in-app slider position (0-100) from the amplitude factor the
 * backend reports. The backend applies a cubic taper (slider^3 → amplitude)
 * in `slider_to_amplitude`, so `cbrt(amplitude)` returns the slider position.
 * Use this for display so the panel matches what the user sees on the
 * volume widget rather than the lower amplitude-percent.
 */
export function amplitudeToSliderPercent(amplitude: number): number {
  if (amplitude <= 0) return 0;
  return Math.round(Math.cbrt(amplitude) * 100);
}

/**
 * Friendly DAC name for compact display. Strips the ALSA driver prefix
 * ("USB-Audio - ", "HDA-Intel - ") and the trailing bus location
 * (" at usb-0000:..."). Falls back to outputDevice path. Returns null when
 * nothing usable is available.
 *
 * Example transformations:
 *   "USB-Audio - iFi (by AMR) HD USB Audio at usb-0000:00:14.0-3, high speed"
 *     → "iFi (by AMR) HD USB Audio"
 *   "HDA-Intel - HDA Intel PCH" → "HDA Intel PCH"
 */
export function dacDisplayName(sp: SignalPath | null): string | null {
  const cardName = sp?.dac?.cardName;
  if (cardName) {
    let s = cardName;
    const dashIdx = s.indexOf(" - ");
    if (dashIdx > 0) s = s.slice(dashIdx + 3);
    const atIdx = s.indexOf(" at ");
    if (atIdx > 0) s = s.slice(0, atIdx);
    const trimmed = s.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return sp?.outputDevice ?? null;
}

/**
 * Effective audio-bit precision per sample for a PCM format. Endianness is
 * ignored on purpose — LE↔BE swaps are bit-exact byte reorders, not
 * quantizations. Float is treated as 24-bit equivalent (24-bit mantissa
 * captures the precision of any integer source FLAC produces).
 */
function audioBitDepth(format: string | null | undefined): number {
  if (!format) return 0;
  switch (toGstreamerFormat(format)) {
    case "S16LE":
    case "S16BE":
      return 16;
    case "S24LE":
    case "S24BE":
    case "S24_32LE":
    case "S24_32BE":
      return 24;
    case "S32LE":
    case "S32BE":
      return 32;
    case "F32LE":
    case "F32BE":
      return 24;
    default:
      return 0;
  }
}

/**
 * Classify a PCM format/rate transition between two pipeline stages.
 *
 * Lossy ONLY when audio bits are discarded — i.e. the destination has fewer
 * audio bits than the source (narrowing), or the sample rate changes (a
 * resample alters the timeline). Bit-depth WIDENING (16/24 → 32) and pure
 * container/byte-layout repacks (S24_32LE ↔ S24LE) preserve every audio bit
 * and are therefore "altered" (lossless), not "lossy".
 *
 * Mirrors the `lossyFormatChange` rule used by `deriveAlterations` so the
 * detailed flow view and the minimalist verdict agree.
 */
export function conversionState(
  fromFmt: string | null | undefined,
  toFmt: string | null | undefined,
  fromRate: number | null | undefined,
  toRate: number | null | undefined,
): "altered" | "lossy" {
  const rateChanged = fromRate != null && toRate != null && fromRate !== toRate;
  const narrowed = audioBitDepth(toFmt) < audioBitDepth(fromFmt);
  return rateChanged || narrowed ? "lossy" : "altered";
}

export function deriveAlterations(sp: SignalPath | null) {
  const userVol = sp?.userVolume ?? 1.0;
  const normFactor = sp?.normGainFactor ?? 1.0;
  const userVolAltered = Math.abs(userVol - 1.0) > EPS;
  const normAltered =
    !!sp?.volumeNormalization && Math.abs(normFactor - 1.0) > EPS;
  const isDirectAlsa = sp?.backend === "DirectAlsa";

  // "Pristine" means: every audio sample the decoder produced reaches the
  // DAC with all its bits intact. Empirical, not mode-based — a non-bit-
  // perfect chain can still be pristine if no lossy stage actually fired.
  // Requires:
  //  - DirectAlsa backend (we own the ALSA device; OS mixer is bypassed)
  //  - exclusiveMode (no shared access could mix into our stream)
  //  - No rate change (resample alters the timeline)
  //  - No ALSA format fallback recorded
  //  - No user-volume / ReplayGain scaling (any non-unity multiply is
  //    destructive on integer PCM)
  //  - No bit-depth narrowing between decoded and output (S24_32LE → S32LE
  //    or S24_32LE → S24LE are lossless container changes and DO NOT
  //    disqualify; S32LE → S16LE narrows and DOES)
  //  - DAC kernel hw_params matches our pipeline's output format/rate
  //    (or no DAC info available, in which case we don't punish)
  // What feeds the kernel? DirectAlsa: our pipeline's appsink output (we own
  // the ALSA device directly). Normal: the OS mixer's per-sink spec
  // (PipeWire/Pulse owns the device, our pipeline only hands off audio).
  const upstreamFormat = isDirectAlsa
    ? sp?.outputFormat
    : (sp?.osMixer?.sinkFormat ?? sp?.outputFormat);
  const upstreamRate = isDirectAlsa
    ? sp?.outputRate
    : (sp?.osMixer?.sinkRate ?? sp?.outputRate);

  const dacMatchesPipeline =
    !sp?.dac ||
    sp.dac.state !== "Active" ||
    (formatsEquivalent(sp.dac.format, upstreamFormat ?? null) &&
      sp.dac.rate === upstreamRate);

  // Lossless format conversions (container repack, bit-width widening) keep
  // all audio bits; only the byte layout changes. A conversion is lossy iff
  // the destination has fewer audio bits than the source.
  const formatChanged =
    !!sp?.decodedFormat &&
    !!sp?.outputFormat &&
    !formatsEquivalent(sp.decodedFormat, sp.outputFormat);
  const lossyFormatChange =
    formatChanged &&
    audioBitDepth(sp!.outputFormat) < audioBitDepth(sp!.decodedFormat);

  // A format change that preserved every audio bit (widening to a larger
  // container, or a same-depth byte-layout repack). Used to distinguish a
  // truly untouched pristine path from one that stayed bit-transparent
  // through a lossless promotion.
  const losslessPromotion = formatChanged && !lossyFormatChange;

  const isPristine =
    !!sp &&
    isDirectAlsa &&
    !!sp.exclusiveMode &&
    sp.resampledFrom == null &&
    sp.formatFallbackFrom == null &&
    !userVolAltered &&
    !normAltered &&
    !lossyFormatChange &&
    dacMatchesPipeline;

  return {
    userVol,
    normFactor,
    userVolAltered,
    normAltered,
    isDirectAlsa,
    isPristine,
    lossyFormatChange,
    losslessPromotion,
  };
}
