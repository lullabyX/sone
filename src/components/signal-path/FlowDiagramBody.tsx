import {
  deriveAlterations,
  formatRate,
  gainFactorToDb,
  type SignalPathViewProps,
} from "./types";

type CableState = "pristine" | "altered" | "lossy";

interface Alteration {
  state: "altered" | "lossy";
  label: string;
  detail: string;
  reason: string;
}

interface NodeSpec {
  title: string;
  primary: string;
  secondary: string | null;
  tertiary: string | null;
}

interface CableSpec {
  state: CableState;
  caption: string;
  alterations: Alteration[];
}

function shortRate(hz: number | null | undefined): string {
  if (!hz) return "—";
  if (hz % 1000 === 0) return `${hz / 1000}k`;
  return `${(hz / 1000).toFixed(1)}k`;
}

type FlowProps = Omit<SignalPathViewProps, "onClose"> & {
  /** When true, hide the track header (caller already shows track context). */
  hideTrackHeader?: boolean;
};

export default function FlowDiagramBody({
  sp,
  streamInfo,
  currentTrack,
  hideTrackHeader = false,
}: FlowProps) {
  const {
    userVol,
    normFactor,
    userVolAltered,
    normAltered,
    isDirectAlsa,
    isPristine,
  } = deriveAlterations(sp);

  const sourceCodec = streamInfo?.codec?.toUpperCase() ?? null;
  const sourceBits = streamInfo?.bitDepth ?? null;
  const sourceRate = streamInfo?.sampleRate ?? null;
  const sourceQuality =
    streamInfo?.audioQuality || currentTrack?.audioQuality || null;

  const trackTitle = currentTrack?.title ?? null;
  const trackArtist =
    currentTrack?.artist?.name ??
    currentTrack?.artists?.map((a) => a.name).join(", ") ??
    null;

  const sourceQualityLine = [
    sourceCodec,
    sourceBits && sourceRate
      ? `${sourceBits}/${(sourceRate / 1000).toFixed(sourceRate % 1000 === 0 ? 0 : 1)}`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  const mixSource: { fmt: string | null; rate: number | null; tertiary: string | null } =
    isDirectAlsa
      ? {
          fmt: sp?.outputFormat ?? null,
          rate: sp?.outputRate ?? null,
          tertiary:
            userVolAltered || normAltered ? "+gain stage" : "pass-thru",
        }
      : sp?.osMixer
        ? {
            fmt: sp.osMixer.sinkFormat,
            rate: sp.osMixer.sinkRate,
            tertiary: `${sp.osMixer.server} · ${sp.osMixer.sinkChannels}ch`,
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
      primary: sp?.decodedFormat ?? "—",
      secondary: formatRate(sp?.decodedRate ?? null),
      tertiary: sp?.decodedChannels ? `${sp.decodedChannels}ch` : null,
    },
    {
      title: "MIX",
      primary: mixSource.fmt ?? "—",
      secondary: formatRate(mixSource.rate),
      tertiary: mixSource.tertiary,
    },
    {
      title: "DAC",
      primary: sp?.dac?.format ?? sp?.outputFormat ?? "—",
      secondary: formatRate(sp?.dac?.rate ?? sp?.outputRate ?? null),
      tertiary: sp?.dac?.cardName ?? (sp?.outputChannels ? `${sp.outputChannels}ch` : null),
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
      reason: "DAC does not accept the source rate at the chosen exclusive mode",
    });
  }
  // Only surface promotion when it actually reaches the DAC. If
  // promotedTo !== outputFormat, the promotion was either internal to the
  // pipeline (undone before output) or stale tracker data — we can't
  // honestly claim a transition that isn't visible at either end of the
  // cable.
  const promotionVisible =
    !!sp?.promotedFrom &&
    !!sp?.promotedTo &&
    sp.promotedTo === sp.outputFormat;
  if (promotionVisible) {
    cable1Alterations.push({
      state: "altered",
      label: "PROMOTED",
      detail: `${sp!.promotedFrom} → ${sp!.promotedTo}`,
      reason: "Lossless zero-pad — sample values preserved",
    });
  }
  // Bit-perfect mode OFF on DirectAlsa: pipeline still includes
  // audioresample, audioconvert, GStreamer `volume` elements (even at
  // unity). They SHOULD be passthrough but it's not guaranteed by config.
  // Surface this so the cable color and verdict don't overclaim.
  const pipelineAtUnity =
    isDirectAlsa &&
    !sp?.bitPerfect &&
    !sp?.resampledFrom &&
    !sp?.formatFallbackFrom;
  if (pipelineAtUnity) {
    cable1Alterations.push({
      state: "altered",
      label: "PIPELINE PROCESSING",
      detail: "bit-perfect mode off",
      reason:
        "Pipeline includes volume / audioresample / audioconvert elements at unity — passthrough not guaranteed",
    });
  }
  // Normal mode: detect pipeline-output → OS-mixer-input divergence.
  // PipeWire/PulseAudio may resample/convert our pipeline output into its
  // internal mix format. Compare decoded caps (post-audioconvert) against
  // the OS mixer's per-sink working spec. Format strings differ in case
  // (GStreamer uses "S24LE", pactl uses "s24le") — compare case-insensitively.
  const mixerDiverges =
    !isDirectAlsa &&
    !!sp?.osMixer &&
    !!sp?.decodedFormat &&
    ((sp.decodedFormat.toLowerCase() !== sp.osMixer.sinkFormat.toLowerCase()) ||
      (sp.decodedRate !== null && sp.osMixer.sinkRate !== sp.decodedRate));
  if (mixerDiverges) {
    cable1Alterations.push({
      state: "lossy",
      label: "MIX CONVERSION",
      detail: `pipeline ${sp!.decodedFormat}/${formatRate(sp!.decodedRate)} → mixer ${sp!.osMixer!.sinkFormat}/${formatRate(sp!.osMixer!.sinkRate)}`,
      reason: `${sp?.osMixer?.server ?? "OS mixer"} converted the stream into its internal mix format`,
    });
  }
  const cable1State: CableState = cable1Alterations.some((a) => a.state === "lossy")
    ? "lossy"
    : cable1Alterations.length > 0
      ? "altered"
      : "pristine";
  const cable1Caption =
    sp?.resampledFrom && sp?.resampledTo
      ? `resample ${shortRate(sp.resampledFrom)}→${shortRate(sp.resampledTo)}`
      : promotionVisible
        ? `promote ${sp!.promotedFrom}→${sp!.promotedTo}`
        : mixerDiverges
          ? "mix conversion"
          : pipelineAtUnity
            ? "processing at unity"
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
      detail: `${sp.formatFallbackFrom} → ${sp.formatFallbackTo}`,
      reason: "DAC rejected requested format — fell back to nearest accepted",
    });
  }
  if (userVolAltered) {
    cable2Alterations.push({
      state: "altered",
      label: "VOLUME",
      detail: `${Math.round(userVol * 100)}% (${gainFactorToDb(userVol)})`,
      reason: "Software volume scales samples in the writer thread",
    });
  }
  if (normAltered) {
    cable2Alterations.push({
      state: "altered",
      label: "REPLAYGAIN",
      detail: `${gainFactorToDb(normFactor)} (×${normFactor.toFixed(3)})`,
      reason: "Loudness normalization scales samples before output",
    });
  }
  const dacDiverges =
    !!sp?.dac &&
    sp.dac.state === "Active" &&
    !!sp?.outputFormat &&
    (sp.dac.format !== sp.outputFormat ||
      (sp.dac.rate !== sp.outputRate && sp.outputRate !== null));
  if (dacDiverges) {
    cable2Alterations.push({
      state: "lossy",
      label: "OS-LAYER CONVERSION",
      detail: `pipeline ${sp!.outputFormat}/${formatRate(sp!.outputRate)} → DAC ${sp!.dac!.format}/${formatRate(sp!.dac!.rate)}`,
      reason: `${sp?.osMixer?.server ?? "OS mixer"} converted the stream before it reached ALSA`,
    });
  }
  const cable2State: CableState = cable2Alterations.some((a) => a.state === "lossy")
    ? "lossy"
    : cable2Alterations.length > 0
      ? "altered"
      : "pristine";
  const cable2Caption =
    sp?.formatFallbackFrom && sp?.formatFallbackTo
      ? `fallback ${sp.formatFallbackFrom}→${sp.formatFallbackTo}`
      : dacDiverges
        ? "OS-layer conversion"
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

  if (sp?.osMixer && sp.backend !== "DirectAlsa") {
    allAlterations.push({
      state: "altered",
      label: "OS MIXER",
      detail: `${sp.osMixer.server} · ${sp.osMixer.defaultSinkName}`,
      reason: `Routed through ${sp.osMixer.server}'s default sink before reaching the DAC`,
    });
  }

  const lossyCount = allAlterations.filter((a) => a.state === "lossy").length;
  const alteredCount = allAlterations.filter((a) => a.state === "altered").length;
  // Reuse the minimalist's `isPristine` so both views agree. Promotion-only
  // paths (lossless zero-pad) still register as pristine even though the
  // alterations list contains a row for them.
  const isPristineVerdict = isPristine;

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
            {sp?.outputDevice && (
              <>
                <span className="text-th-text-faint/50">·</span>
                <span className="truncate max-w-[200px]">{sp.outputDevice}</span>
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
                        <div className={`w-full h-[2px] ${cableColor(cables[i].state)}`} />
                        <div className="h-[3px]" />
                        <div className={`w-full h-[2px] ${cableColor(cables[i].state)}`} />
                      </>
                    ) : (
                      <>
                        <div className={`w-full h-[4px] ${cableColor(cables[i].state)}`} />
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
        className={`px-6 py-3 border-t border-th-border-subtle text-center text-[11px] font-bold tracking-[0.15em] ${
          isPristineVerdict
            ? "text-green-400"
            : lossyCount > 0
              ? "text-red-400"
              : "text-amber-300"
        }`}
      >
        {isPristineVerdict
          ? "PRISTINE — NO ALTERATIONS DETECTED"
          : lossyCount > 0
            ? `NOT PRISTINE — ${lossyCount} LOSSY STAGE${lossyCount === 1 ? "" : "S"}${
                alteredCount > 0 ? ` · ${alteredCount} MODIFIED` : ""
              }`
            : alteredCount > 0
              ? `MODIFIED — ${alteredCount} STAGE${alteredCount === 1 ? "" : "S"}`
              : "MODIFIED"}
      </div>
    </>
  );
}
