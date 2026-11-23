import type { SignalPath } from "../../atoms/playback";
import type { StreamInfo, Track } from "../../types";
import { signalSummary } from "../signal-path/flow";
import { dacDisplayName } from "../signal-path/types";
import type {
  TvMenuItem,
  TvMenuSpec,
  TvMenuTone,
  TvMenuVerdict,
} from "./tvMenu";

/** The Now Playing badge's dot: green when every source bit reaches the DAC
 *  untouched, red when audio bits are lost on the way, amber when the audio
 *  is changed without losing bits, grey while nothing is playing, the output
 *  is starting or the DAC is inactive. */
export function signalTone(sp: SignalPath | null): TvMenuTone {
  if (!sp?.backend) return "neutral";
  if (!sp.dac && !sp.outputFormat) return "neutral";
  if (sp.dac?.state === "Closed") return "neutral";
  return TONE[signalSummary(sp, null, null).verdict];
}

const TONE = { pristine: "ok", lossy: "lossy", modified: "warn" } as const;
const WORD = { pristine: "PRISTINE", lossy: "LOSSY", modified: "MODIFIED" };

const join = (parts: (string | null | undefined)[]) =>
  parts.filter((v) => v && v !== "—").join(" · ");

/** The rail's verdict: the word for the dot's colour, how many changes,
 *  a one-line summary and the facts about the output. */
function verdictFor(
  sp: SignalPath | null,
  streamInfo: StreamInfo | null,
  lossy: number,
  altered: number,
): TvMenuVerdict {
  const tone = signalTone(sp);
  const facts = join([
    dacDisplayName(sp),
    sp?.exclusiveMode ? "Exclusive" : "Shared",
    sp?.bitPerfect ? "Bit-perfect" : null,
    sp?.backend === "DirectAlsa" ? "ALSA direct" : sp?.osMixer?.server,
  ]);
  if (!sp?.backend) {
    return { tone, word: "IDLE", headline: "Nothing is playing" };
  }
  if (tone === "neutral") {
    return sp.dac?.state === "Closed"
      ? {
          tone,
          word: "DAC INACTIVE",
          headline: "Output may be routed elsewhere",
          facts,
        }
      : {
          tone,
          word: "STARTING",
          headline: "Starting the audio output",
          facts,
        };
  }
  const summary = signalSummary(sp, streamInfo, null);
  return {
    tone,
    word: WORD[summary.verdict],
    count:
      summary.verdict === "pristine"
        ? undefined
        : join([
            lossy ? `${lossy} lossy` : null,
            altered ? `${altered} modified` : null,
          ]) || undefined,
    headline: summary.headline,
    facts,
  };
}

/** The Signal path rail: the stages the audio passes through, on a cable
 *  that turns amber (or red, when audio bits are lost) after each change. */
export function signalPathMenu(
  sp: SignalPath | null,
  streamInfo: StreamInfo | null,
  track: Track | null,
  image?: string,
): TvMenuSpec {
  const subtitle = join([
    track?.title,
    track?.artists?.map((a) => a.name).join(", ") || track?.artist?.name,
  ]);
  if (!sp?.backend) {
    return {
      title: "Signal path",
      subtitle,
      image,
      verdict: verdictFor(sp, streamInfo, 0, 0),
      items: [],
    };
  }
  const { nodes, cables, lossyCount, alteredCount } = signalSummary(
    sp,
    streamInfo,
    track,
  );
  const items: TvMenuItem[] = [];
  nodes.forEach((node, i) => {
    const source = i === 0;
    const dac = i === nodes.length - 1;
    items.push({
      label: node.title,
      // The source's first value is just "stream"; its quality is what counts.
      detail: source
        ? join([node.secondary])
        : join([node.primary, node.secondary]),
      note:
        (dac ? dacDisplayName(sp) : null) ?? join([node.tertiary]) ?? undefined,
      info: true,
      path: {
        kind: "stage",
        above: cables[i - 1]?.state,
        below: cables[i]?.state,
      },
    });
    const cable = cables[i];
    for (const a of cable?.alterations ?? []) {
      items.push({
        label: a.label,
        // A pill on the cable: the numbers that changed, no reason.
        detail: a.short ?? a.detail,
        tone: a.state === "lossy" ? "lossy" : "warn",
        info: true,
        path: { kind: "change", above: cable.state, below: cable.state },
      });
    }
  });
  return {
    title: "Signal path",
    subtitle,
    image,
    verdict: verdictFor(sp, streamInfo, lossyCount, alteredCount),
    items,
  };
}
