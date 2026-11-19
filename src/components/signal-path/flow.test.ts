import { describe, expect, it } from "vitest";
import type { DacHwParams, SignalPath } from "../../atoms/playback";
import { signalSummary } from "./flow";

const dac: DacHwParams = {
  cardIndex: 1,
  cardName: "USB-Audio - iFi (by AMR) HD USB Audio",
  pcmDevice: "hw:CARD=Audio,DEV=0",
  format: "S32_LE",
  rate: 48000,
  channels: 2,
  periodSize: 1024,
  bufferSize: 4096,
  state: "Active",
};

/** Shared mode through PipeWire, the mixer at `mixerRate`. */
function shared(mixerRate: number, over: Partial<SignalPath> = {}): SignalPath {
  return {
    backend: "Normal",
    decodedFormat: "S24_32LE",
    decodedRate: 192000,
    decodedChannels: 2,
    outputFormat: "S24_32LE",
    outputRate: 192000,
    outputChannels: 2,
    outputDevice: null,
    exclusiveMode: false,
    bitPerfect: false,
    volumeNormalization: false,
    userVolume: 1,
    normGainFactor: 1,
    resampledFrom: null,
    resampledTo: null,
    promotedFrom: null,
    promotedTo: null,
    formatFallbackFrom: null,
    formatFallbackTo: null,
    dac: { ...dac, rate: mixerRate },
    osMixer: {
      server: "PipeWire",
      defaultSinkName: "sink",
      sinkName: "sink",
      sinkFormat: "s32le",
      sinkRate: mixerRate,
      sinkChannels: 2,
      sinkVolume: 1,
      sinkVolumePercent: 100,
      sinkMuted: false,
      virtualRoute: [],
      deviceRate: mixerRate,
    },
    ...over,
  };
}

describe("signalSummary", () => {
  it("calls a PipeWire resample LOSSY and names it", () => {
    const s = signalSummary(shared(48000), null, null);
    expect(s.verdict).toBe("lossy");
    expect(s.headline).toBe("Resampled 192 kHz → 48 kHz by PipeWire");
    expect(s.lossyCount).toBe(1);
    expect(s.allAlterations[0].short).toBe("S24_32LE/192 kHz → S32LE/48 kHz");
  });

  it("keeps a lossless shared path MODIFIED", () => {
    const s = signalSummary(shared(192000), null, null);
    expect(s.verdict).toBe("modified");
    expect(s.headline).toBe("Routed through PipeWire");
  });

  it("calls a muted mixer LOSSY", () => {
    const sp = shared(192000);
    sp.osMixer!.sinkMuted = true;
    const s = signalSummary(sp, null, null);
    expect(s.verdict).toBe("lossy");
    expect(s.headline).toBe("PipeWire has the output muted");
  });

  it("keeps the writer's own resample headline", () => {
    const s = signalSummary(
      shared(192000, {
        backend: "DirectAlsa",
        exclusiveMode: true,
        osMixer: null,
        resampledFrom: 192000,
        resampledTo: 96000,
        dac: { ...dac, format: "S32_LE", rate: 96000 },
      }),
      null,
      null,
    );
    expect(s.verdict).toBe("lossy");
    expect(s.headline).toBe("Resampled 192 kHz → 96 kHz");
  });

  it("is PRISTINE when every bit reaches the DAC", () => {
    const s = signalSummary(
      shared(192000, {
        backend: "DirectAlsa",
        exclusiveMode: true,
        bitPerfect: true,
        osMixer: null,
        dac: { ...dac, format: "S24_LE", rate: 192000 },
      }),
      null,
      null,
    );
    expect(s.verdict).toBe("pristine");
  });
});
