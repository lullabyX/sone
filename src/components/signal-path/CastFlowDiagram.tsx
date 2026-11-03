/**
 * CastFlowDiagram — the expanded signal-path view while playback is routed
 * to a TIDAL Connect receiver (LinkPlay push-URL cast). Sone's LOCAL pipeline
 * is idle in this mode: the receiver pulls the stream from TIDAL's CDN with
 * Sone-supplied tokens and plays it on its own hardware DAC, so the visual
 * language mirrors FlowDiagramBody but with cast-appropriate stages.
 */

import { useMemo } from "react";
import { ArrowLeft } from "lucide-react";
import type { ConnectDevice } from "../../atoms/tidalConnect";
import type { StreamInfo, Track } from "../../types";

interface CastNode {
  title: string;
  primary: string;
  secondary: string | null;
  tertiary: string | null;
}

interface CastFlowDiagramProps {
  activeDevice: ConnectDevice;
  currentTrack: Track | null;
  streamInfo: StreamInfo | null;
  /** Receiver-reported hardware volume as amplitude (0.0-1.0). */
  volume: number;
  onBack?: () => void;
}

/** The station line: source codec + bit depth/rate, same shape as the
 *  local diagram so the two views read identically. */
function sourceLine(streamInfo: StreamInfo | null): string | null {
  const codec = streamInfo?.codec?.toUpperCase() ?? null;
  const bits = streamInfo?.bitDepth ?? null;
  const rate = streamInfo?.sampleRate ?? null;
  return [
    codec,
    bits && rate
      ? `${bits}/${(rate / 1000).toFixed(rate % 1000 === 0 ? 0 : 1)}`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export default function CastFlowDiagram({
  activeDevice,
  currentTrack,
  streamInfo,
  volume,
  onBack,
}: CastFlowDiagramProps) {
  const trackTitle = currentTrack?.title ?? null;
  const trackArtist =
    (currentTrack?.artists && currentTrack.artists.length > 0
      ? currentTrack.artists.map((a) => a.name).join(", ")
      : currentTrack?.artist?.name) ?? null;

  const srcLine = sourceLine(streamInfo);
  const quality =
    streamInfo?.audioQuality || currentTrack?.audioQuality || null;

  const volumePercent = Math.round(volume * 100);

  const nodes: CastNode[] = useMemo(
    () => [
      {
        title: "TIDAL",
        primary: "stream",
        secondary: srcLine || "—",
        tertiary: quality ?? null,
      },
      {
        title: "CAST",
        primary: "LinkPlay push",
        secondary: activeDevice.host,
        tertiary: "manifest + tokens",
      },
      {
        title: "RECEIVER",
        primary: activeDevice.modelName || activeDevice.name,
        secondary: activeDevice.name,
        tertiary: activeDevice.isLocal ? null : "Wi-Fi / LAN",
      },
      {
        title: "DAC",
        primary: "hardware",
        secondary: `${volumePercent}%`,
        tertiary: "receiver-controlled",
      },
    ],
    [activeDevice, srcLine, quality, volumePercent],
  );

  const cableCaptions = ["DASH manifest", "push-URL cast", "hardware volume"];

  return (
    <>
      {/* Track header — cast state doubles as the "no track" explanation so
          the panel never contradicts the receiver's reality. */}
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
            <span className="text-th-text-muted">
              No track playing on the receiver
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[10px] font-mono text-th-text-faint">
          {srcLine && <span>{srcLine}</span>}
          {quality && (
            <>
              <span className="text-th-text-faint/50">·</span>
              <span>{quality}</span>
            </>
          )}
          <span className="text-th-text-faint/50">·</span>
          <span className="truncate max-w-[260px]">{activeDevice.name}</span>
          <div className="flex gap-1.5 ml-auto pr-2">
            <span className="px-1.5 py-0.5 rounded bg-th-inset text-th-text-muted tracking-wider">
              TIDAL CONNECT
            </span>
          </div>
        </div>
      </div>

      {/* Flow diagram — every cast cable is sample-transparent from Sone's
          side: no local decode, mix or software gain is in the picture. */}
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
                    <div className="w-full h-[2px] bg-green-400" />
                    <div className="h-[3px]" />
                    <div className="w-full h-[2px] bg-green-400" />
                  </div>
                  <div
                    className="absolute -bottom-1 text-[9px] font-mono tracking-wide whitespace-nowrap text-green-400"
                    style={{ fontFamily: "ui-monospace, monospace" }}
                  >
                    {cableCaptions[i]}
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
        </div>
      </div>

      {/* Cast reality rows: the two facts that differ most from local
          playback. Sone never touches samples here, and the receiver's
          knob — not Sone — owns loudness. */}
      <div className="px-6 pb-4 border-t border-th-border-subtle pt-4 space-y-2">
        <div className="flex items-start gap-3 text-[11px]">
          <span className="mt-[1px] text-[12px] font-bold text-amber-300">
            ?
          </span>
          <div className="font-bold tracking-wider w-[120px] shrink-0 text-amber-300">
            NO DECODE
          </div>
          <div
            className="font-mono text-th-text-primary w-[170px] shrink-0"
            style={{ fontFamily: "ui-monospace, monospace" }}
          >
            stream not routed locally
          </div>
          <div className="text-th-text-muted flex-1">
            Sone ships the manifest URL and OAuth tokens; the receiver fetches
            the audio straight from TIDAL's CDN. No sample ever runs through
            this machine's DAC.
          </div>
        </div>
        <div className="flex items-start gap-3 text-[11px]">
          <span className="mt-[1px] text-[12px] font-bold text-amber-300">
            ?
          </span>
          <div className="font-bold tracking-wider w-[120px] shrink-0 text-amber-300">
            HARDWARE VOL
          </div>
          <div
            className="font-mono text-th-text-primary w-[170px] shrink-0"
            style={{ fontFamily: "ui-monospace, monospace" }}
          >
            {volumePercent}% (receiver DAC)
          </div>
          <div className="text-th-text-muted flex-1">
            Loudness is applied by the receiver's hardware volume — Sone sends
            commands only and mirrors what the knob reports back.
          </div>
        </div>
      </div>

      {/* Verdict line */}
      <div className="relative px-4 py-3 border-t border-th-border-subtle flex items-center justify-center text-[11px] font-bold tracking-[0.15em] text-green-400">
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
          CAST ACTIVE — RECEIVER DAC, SONE HOLDS NO SAMPLES
        </span>
      </div>
    </>
  );
}
