import type { SignalPath } from "../../atoms/playback";
import type { StreamInfo, Track } from "../../types";
import {
  amplitudeToSliderPercent,
  conversionState,
  deriveAlterations,
  signalHeadline,
  displayFormat,
  formatRate,
  formatsEquivalent,
  gainFactorToDb,
} from "./types";

export type CableState = "pristine" | "altered" | "lossy";

export interface Alteration {
  state: "altered" | "lossy";
  label: string;
  detail: string;
  reason: string;
  /** The verdict's one-line summary when this is the first lossy change. */
  headline?: string;
  /** Just the numbers that changed, where `detail` is long (the TV rail). */
  short?: string;
}

export interface NodeSpec {
  title: string;
  primary: string;
  secondary: string | null;
  tertiary: string | null;
}

export interface CableSpec {
  state: CableState;
  caption: string;
  alterations: Alteration[];
}

function shortRate(hz: number | null | undefined): string {
  if (!hz) return "—";
  if (hz % 1000 === 0) return `${hz / 1000}k`;
  return `${(hz / 1000).toFixed(1)}k`;
}

/** "S24_32LE/192 kHz → S16LE/48 kHz": one conversion in a single short
 *  line, for the TV rail's pills. */
function shortConversion(
  fromFmt: string | null | undefined,
  fromRate: number | null | undefined,
  toFmt: string | null | undefined,
  toRate: number | null | undefined,
): string {
  const side = (
    fmt: string | null | undefined,
    hz: number | null | undefined,
  ) => (hz ? `${displayFormat(fmt)}/${formatRate(hz)}` : displayFormat(fmt));
  return `${side(fromFmt, fromRate)} → ${side(toFmt, toRate)}`;
}

/** The signal path as stages (nodes) joined by cables, each cable with the
 *  changes made to the audio on it. Shared by the desktop diagram and the
 *  TV Signal path rail. */
export function buildSignalFlow(
  sp: SignalPath | null,
  streamInfo: StreamInfo | null,
  currentTrack: Track | null,
) {
  const {
    userVol,
    normFactor,
    userVolAltered,
    normAltered,
    isDirectAlsa,
    isPristine,
    losslessPromotion,
  } = deriveAlterations(sp);

  const sourceCodec = streamInfo?.codec?.toUpperCase() ?? null;
  const sourceBits = streamInfo?.bitDepth ?? null;
  const sourceRate = streamInfo?.sampleRate ?? null;
  const sourceQuality =
    streamInfo?.audioQuality || currentTrack?.audioQuality || null;

  const trackTitle = currentTrack?.title ?? null;
  // Prefer the full `artists` list when present (Tidal sets both, with `artist`
  // being only the primary). Falls back to the singular `artist` for sources
  // that only populate that field.
  const trackArtist =
    (currentTrack?.artists && currentTrack.artists.length > 0
      ? currentTrack.artists.map((a) => a.name).join(", ")
      : currentTrack?.artist?.name) ?? null;

  const sourceQualityLine = [
    sourceCodec,
    sourceBits && sourceRate
      ? `${sourceBits}/${(sourceRate / 1000).toFixed(sourceRate % 1000 === 0 ? 0 : 1)}`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  const mixSource: {
    fmt: string | null;
    rate: number | null;
    tertiary: string | null;
  } = isDirectAlsa
    ? {
        fmt: sp?.outputFormat ?? null,
        rate: sp?.outputRate ?? null,
        tertiary: userVolAltered || normAltered ? "+gain stage" : "pass-thru",
      }
    : sp?.osMixer
      ? {
          fmt: sp.osMixer.sinkFormat,
          rate: sp.osMixer.sinkRate,
          tertiary: sp.osMixer.sinkChannels
            ? `${sp.osMixer.server} · ${sp.osMixer.sinkChannels}ch`
            : sp.osMixer.server,
        }
      : { fmt: null, rate: null, tertiary: "sw mixer" };

  const nodes: NodeSpec[] = [
    {
      title: "TIDAL",
      primary: "stream",
      secondary: sourceQualityLine || "—",
      tertiary: sourceQuality ?? null,
    },
    {
      title: "DECODE",
      primary: displayFormat(sp?.decodedFormat ?? null),
      secondary: formatRate(sp?.decodedRate ?? null),
      tertiary: sp?.decodedChannels ? `${sp.decodedChannels}ch` : null,
    },
    {
      title: "MIX",
      primary: displayFormat(mixSource.fmt),
      secondary: formatRate(mixSource.rate),
      tertiary: mixSource.tertiary,
    },
    {
      title: "DAC",
      // Normal mode: our pipeline caps say nothing about the device — the OS mixer owns it.
      primary: displayFormat(
        sp?.dac?.format ?? (isDirectAlsa ? sp?.outputFormat : null) ?? null,
      ),
      secondary: formatRate(
        sp?.dac?.rate ?? (isDirectAlsa ? sp?.outputRate : null) ?? null,
      ),
      tertiary:
        sp?.dac?.cardName ??
        (isDirectAlsa
          ? sp?.outputChannels
            ? `${sp.outputChannels}ch`
            : null
          : sp?.backend
            ? "not detected"
            : null),
    },
  ];

  const cable0: CableSpec = {
    state: "pristine",
    caption: sourceCodec ? `${sourceCodec} → PCM` : "lossless decompression",
    alterations: [],
  };

  const cable1Alterations: Alteration[] = [];
  if (sp?.resampledFrom && sp?.resampledTo) {
    cable1Alterations.push({
      state: "lossy",
      label: "RESAMPLED",
      detail: `${formatRate(sp.resampledFrom)} → ${formatRate(sp.resampledTo)}`,
      reason:
        "DAC does not accept the source rate at the chosen exclusive mode",
    });
  }
  // Only surface promotion when it actually reaches the DAC. If
  // promotedTo !== outputFormat, the promotion was either internal to the
  // pipeline (undone before output) or stale tracker data — we can't
  // honestly claim a transition that isn't visible at either end of the
  // cable.
  const promotionVisible =
    !!sp?.promotedFrom && !!sp?.promotedTo && sp.promotedTo === sp.outputFormat;
  if (promotionVisible) {
    cable1Alterations.push({
      state: "altered",
      label: "PROMOTED",
      detail: `${displayFormat(sp!.promotedFrom)} → ${displayFormat(sp!.promotedTo)}`,
      reason: "Lossless zero-pad — sample values preserved",
    });
  }
  // DirectAlsa mode: detect when audioconvert is doing a lossless container
  // repack (e.g., S24_32LE → S24LE because the DAC doesn't accept the 4-byte
  // form, or S24_32LE → S32LE in non-bit-perfect mode). Audio bits are
  // preserved; only the byte layout differs. Flagged as altered-lossless
  // (yellow), not lossy (red).
  const containerRepack =
    isDirectAlsa &&
    !!sp?.decodedFormat &&
    !!sp?.outputFormat &&
    !formatsEquivalent(sp.decodedFormat, sp.outputFormat);
  if (containerRepack) {
    cable1Alterations.push({
      state: "altered",
      label: "CONTAINER REPACK",
      detail: `${displayFormat(sp!.decodedFormat)} → ${displayFormat(sp!.outputFormat)}`,
      reason:
        "audioconvert repacked the sample container — audio bits preserved, byte layout differs",
    });
  }
  // Normal mode: detect pipeline-output → OS-mixer-input divergence.
  // PipeWire/PulseAudio may resample/convert our pipeline output into its
  // internal mix format. Compare decoded caps (post-audioconvert) against
  // the spec of the sink our stream feeds (empty format / null rate when
  // unknown). Format strings differ in case (GStreamer uses "S24LE", pactl
  // uses "s24le") — compare case-insensitively.
  const mixerRate = sp?.osMixer?.sinkRate ?? null;
  const mixerDiverges =
    !isDirectAlsa &&
    !!sp?.osMixer?.sinkFormat &&
    !!sp?.decodedFormat &&
    (!formatsEquivalent(sp.decodedFormat, sp.osMixer.sinkFormat) ||
      (sp.decodedRate !== null &&
        mixerRate !== null &&
        mixerRate !== sp.decodedRate));
  if (mixerDiverges) {
    const mixState = conversionState(
      sp!.decodedFormat,
      sp!.osMixer!.sinkFormat,
      sp!.decodedRate,
      mixerRate,
    );
    const mixRateChanged =
      sp!.decodedRate !== null &&
      mixerRate !== null &&
      mixerRate !== sp!.decodedRate;
    const mixServer = sp?.osMixer?.server ?? "OS mixer";
    const mixerSpec =
      mixerRate !== null
        ? `${displayFormat(sp!.osMixer!.sinkFormat)}/${formatRate(mixerRate)}`
        : displayFormat(sp!.osMixer!.sinkFormat);
    cable1Alterations.push({
      state: mixState,
      label: "MIX CONVERSION",
      detail: `pipeline ${displayFormat(sp!.decodedFormat)}/${formatRate(sp!.decodedRate)} → mixer ${mixerSpec}`,
      reason:
        mixState === "altered"
          ? `${mixServer} widened/repacked the stream into its internal mix format — audio bits preserved`
          : mixRateChanged
            ? `${mixServer} resampled the stream to its internal mix rate`
            : `${mixServer} reduced bit depth converting into its internal mix format`,
      short: shortConversion(
        sp!.decodedFormat,
        sp!.decodedRate,
        sp!.osMixer!.sinkFormat,
        mixerRate,
      ),
      headline: mixRateChanged
        ? `Resampled ${formatRate(sp!.decodedRate)} → ${formatRate(mixerRate)} by ${mixServer}`
        : `Bit depth reduced ${displayFormat(sp!.decodedFormat)} → ${displayFormat(sp!.osMixer!.sinkFormat)} by ${mixServer}`,
    });
  }
  const cable1State: CableState = cable1Alterations.some(
    (a) => a.state === "lossy",
  )
    ? "lossy"
    : cable1Alterations.length > 0
      ? "altered"
      : "pristine";
  const cable1Caption =
    sp?.resampledFrom && sp?.resampledTo
      ? `resample ${shortRate(sp.resampledFrom)}→${shortRate(sp.resampledTo)}`
      : promotionVisible
        ? `promote ${displayFormat(sp!.promotedFrom)}→${displayFormat(sp!.promotedTo)}`
        : mixerDiverges
          ? "mix conversion"
          : containerRepack
            ? "container repack"
            : "pass-thru";
  const cable1: CableSpec = {
    state: cable1State,
    caption: cable1Caption,
    alterations: cable1Alterations,
  };

  const cable2Alterations: Alteration[] = [];
  if (sp?.formatFallbackFrom && sp?.formatFallbackTo) {
    cable2Alterations.push({
      state: "lossy",
      label: "FORMAT FALLBACK",
      detail: `${displayFormat(sp.formatFallbackFrom)} → ${displayFormat(sp.formatFallbackTo)}`,
      reason: "DAC rejected requested format — fell back to nearest accepted",
    });
  }
  if (userVolAltered) {
    cable2Alterations.push({
      state: "altered",
      label: "VOLUME",
      detail: `${amplitudeToSliderPercent(userVol)}% (${gainFactorToDb(userVol)})`,
      reason: "Software volume scales samples in the writer thread",
    });
  }
  if (normAltered) {
    cable2Alterations.push({
      state: "altered",
      label: "REPLAYGAIN",
      detail: `${gainFactorToDb(normFactor)} (×${normFactor.toFixed(3)})`,
      short: gainFactorToDb(normFactor),
      reason: "Loudness normalization scales samples before output",
    });
  }
  // Normal mode: surface OS mixer mute / volume scaling. We're not the only
  // thing that touches samples — PipeWire/Pulse can mute the sink or apply a
  // per-sink software volume that scales every sample before the kernel write.
  // Skipped for DirectAlsa because we own the device exclusively (OS mixer is
  // bypassed). EPS_VOL guards against floating-point noise around 1.0.
  const EPS_VOL = 1e-3;
  const osMuted = !isDirectAlsa && !!sp?.osMixer && sp.osMixer.sinkMuted;
  const osVolumeAltered =
    !isDirectAlsa &&
    !!sp?.osMixer &&
    !sp.osMixer.sinkMuted &&
    Math.abs(sp.osMixer.sinkVolume - 1.0) > EPS_VOL;
  if (osMuted) {
    cable2Alterations.push({
      state: "lossy",
      label: "OS MUTED",
      detail: `${sp?.osMixer?.server ?? "OS mixer"} sink is muted`,
      reason: "OS mixer is muted — samples are zeroed before reaching the DAC",
      headline: `${sp?.osMixer?.server ?? "The OS mixer"} has the output muted`,
    });
  } else if (osVolumeAltered) {
    cable2Alterations.push({
      state: "altered",
      label: "OS VOLUME",
      detail: `${sp!.osMixer!.sinkVolumePercent}% (${gainFactorToDb(sp!.osMixer!.sinkVolume)})`,
      reason: `${sp?.osMixer?.server ?? "OS mixer"} scales samples by this factor before the kernel write`,
    });
  }
  // Normal mode: virtual sinks (EQ, crossfeed, convolution, loopbacks)
  // between our stream and the device can rewrite samples, and a hop pinned
  // to its own rate resamples. SONE can't see inside them, so surface them.
  const virtualRoute = !isDirectAlsa ? (sp?.osMixer?.virtualRoute ?? []) : [];
  if (virtualRoute.length > 0) {
    cable2Alterations.push({
      state: "altered",
      label: "VIRTUAL ROUTING",
      short:
        virtualRoute.length === 1
          ? virtualRoute[0].name
          : `${virtualRoute.length} virtual sinks`,
      detail: virtualRoute
        .map((h) => (h.rate ? `${h.name} (${shortRate(h.rate)})` : h.name))
        .join(" → "),
      reason:
        "Audio passes through virtual sinks before the DAC — any processing they apply is invisible to SONE",
    });
  }
  // Each change between known hop rates is a resample; a change across an
  // unknown hop still proves at least one.
  const knownHops = virtualRoute.filter((h) => h.rate !== null);
  const routeResamples = knownHops.filter(
    (h, i) => i > 0 && h.rate !== knownHops[i - 1].rate,
  ).length;
  knownHops.forEach((hop, i) => {
    const prev = knownHops[i - 1];
    if (prev && prev.rate !== hop.rate) {
      cable2Alterations.push({
        state: "lossy",
        label: "ROUTE RESAMPLE",
        detail: `${prev.name} ${shortRate(prev.rate)} → ${hop.name} ${shortRate(hop.rate)}`,
        short: `${formatRate(prev.rate)} → ${formatRate(hop.rate)}`,
        reason:
          "Virtual sinks run at different rates — audio is resampled between them",
      });
    }
  });
  // Mode-aware: in Normal mode the "previous stage" is the OS mixer's sink
  // spec (what PipeWire actually delivers to the kernel), NOT our pipeline
  // output. In DirectAlsa we own the device so outputFormat IS what reaches
  // the kernel.
  const upstreamFormat = isDirectAlsa
    ? (sp?.outputFormat ?? null)
    : (sp?.osMixer?.sinkFormat ?? sp?.outputFormat ?? null);
  // A route's last hop is what reaches the device.
  const routeOutRate =
    virtualRoute.length > 0
      ? virtualRoute[virtualRoute.length - 1].rate
      : (sp?.osMixer?.sinkRate ?? null);
  const upstreamRate = isDirectAlsa
    ? (sp?.outputRate ?? null)
    : sp?.osMixer
      ? routeOutRate
      : (sp?.outputRate ?? null);

  const dacDiverges =
    !!sp?.dac &&
    sp.dac.state === "Active" &&
    !!upstreamFormat &&
    upstreamRate !== null &&
    (!formatsEquivalent(sp.dac.format, upstreamFormat) ||
      sp.dac.rate !== upstreamRate);
  // The source's bit depth only bounds what reaches the device when nothing
  // rewrote the samples after hand-off: no virtual sinks, unity OS volume,
  // and the mixer kept our rate.
  const samplesUntouched =
    !isDirectAlsa &&
    virtualRoute.length === 0 &&
    !osMuted &&
    !osVolumeAltered &&
    sp?.decodedRate != null &&
    mixerRate !== null &&
    mixerRate === sp.decodedRate;
  if (dacDiverges) {
    const dacState = conversionState(
      upstreamFormat,
      sp!.dac!.format,
      upstreamRate,
      sp!.dac!.rate,
      samplesUntouched ? sp?.decodedFormat : null,
    );
    const dacRateChanged = sp!.dac!.rate !== upstreamRate;
    const dacServer = sp?.osMixer?.server ?? "OS mixer";
    cable2Alterations.push({
      state: dacState,
      label: "OS-LAYER CONVERSION",
      detail: `${isDirectAlsa ? "pipeline" : "mixer"} ${displayFormat(upstreamFormat)}/${formatRate(upstreamRate)} → DAC ${displayFormat(sp!.dac!.format)}/${formatRate(sp!.dac!.rate)}`,
      short: shortConversion(
        upstreamFormat,
        upstreamRate,
        sp!.dac!.format,
        sp!.dac!.rate,
      ),
      reason:
        dacState === "altered"
          ? `${dacServer} widened/repacked the stream before it reached ALSA — audio bits preserved`
          : dacRateChanged
            ? `${dacServer} resampled the stream before it reached ALSA`
            : `${dacServer} reduced bit depth before it reached ALSA`,
    });
  }
  // No kernel hw_params (Bluetooth, sandbox): the OS still reports the
  // device's running rate, so a pinned last hop's resample isn't hidden.
  const deviceRate = sp?.osMixer?.deviceRate ?? null;
  const deviceResample =
    !isDirectAlsa &&
    sp?.dac?.state !== "Active" &&
    upstreamRate !== null &&
    deviceRate !== null &&
    upstreamRate !== deviceRate;
  if (deviceResample) {
    cable2Alterations.push({
      state: "lossy",
      label: "OS-LAYER CONVERSION",
      detail: `mixer ${formatRate(upstreamRate)} → device ${formatRate(deviceRate)}`,
      short: `${formatRate(upstreamRate)} → ${formatRate(deviceRate)}`,
      reason: `${sp?.osMixer?.server ?? "OS mixer"} resampled the stream before it reached the device`,
    });
  }
  const cable2State: CableState = cable2Alterations.some(
    (a) => a.state === "lossy",
  )
    ? "lossy"
    : cable2Alterations.length > 0
      ? "altered"
      : "pristine";
  const cable2Caption =
    sp?.formatFallbackFrom && sp?.formatFallbackTo
      ? `fallback ${displayFormat(sp.formatFallbackFrom)}→${displayFormat(sp.formatFallbackTo)}`
      : osMuted
        ? "OS muted"
        : dacDiverges || deviceResample
          ? "OS-layer conversion"
          : routeResamples > 0
            ? "route resample"
            : virtualRoute.length > 0
              ? "virtual routing"
              : osVolumeAltered
                ? `OS vol ${gainFactorToDb(sp!.osMixer!.sinkVolume)}`
                : userVolAltered || normAltered
                  ? "gain applied"
                  : "pass-thru";
  const cable2: CableSpec = {
    state: cable2State,
    caption: cable2Caption,
    alterations: cable2Alterations,
  };

  const cables: CableSpec[] = [cable0, cable1, cable2];
  const allAlterations: Alteration[] = cables.flatMap((c) => c.alterations);

  const lossyCount = allAlterations.filter((a) => a.state === "lossy").length;
  const alteredCount = allAlterations.filter(
    (a) => a.state === "altered",
  ).length;
  // Reuse the minimalist's `isPristine` so both views agree. Promotion-only
  // paths (lossless zero-pad) still register as pristine even though the
  // alterations list contains a row for them.
  const isPristineVerdict = isPristine;

  return {
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
  };
}

/** The verdict: pristine (every source bit reaches the DAC), lossy (audio
 *  bits are lost on the way: a resample, a narrowed bit depth, a mute), or
 *  modified (changed without losing bits, or not guaranteed untouched). The
 *  headline leads with the first lossy change. */
export function signalSummary(
  sp: SignalPath | null,
  streamInfo: StreamInfo | null,
  currentTrack: Track | null,
) {
  const flow = buildSignalFlow(sp, streamInfo, currentTrack);
  const { isPristine, lossyFormatChange } = deriveAlterations(sp);
  const lossy = !isPristine && (flow.lossyCount > 0 || lossyFormatChange);
  const verdict: "pristine" | "lossy" | "modified" = isPristine
    ? "pristine"
    : lossy
      ? "lossy"
      : "modified";
  const first = flow.allAlterations.find((a) => a.state === "lossy");
  // The writer's own resample, a format fallback and a narrowed bit depth
  // lead the shared headline already.
  const sharedCovers =
    !!sp?.resampledFrom || !!sp?.formatFallbackFrom || lossyFormatChange;
  const headline =
    lossy && first && !sharedCovers
      ? (first.headline ?? first.reason)
      : signalHeadline(sp, streamInfo);
  return { ...flow, verdict, headline };
}
