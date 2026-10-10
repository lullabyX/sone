import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import FlowDiagramBody from "./FlowDiagramBody";
import type {
  SignalPath,
  OsMixerInfo,
  DacHwParams,
} from "../../atoms/playback";

const naos: DacHwParams = {
  cardIndex: 3,
  cardName: "USB-Audio - NAOS MICRO at usb-0000:00:14.0-2, high speed",
  pcmDevice: "hw:CARD=MICRO,DEV=0",
  format: "S32_LE",
  rate: 44100,
  channels: 2,
  periodSize: 1024,
  bufferSize: 4096,
  state: "Active",
};

const bs2bMixer: OsMixerInfo = {
  server: "PipeWire",
  defaultSinkName: "effect_input.bs2b",
  sinkName: "effect_input.bs2b",
  sinkFormat: "float32le",
  sinkRate: 44100,
  sinkChannels: 2,
  sinkVolume: 1,
  sinkVolumePercent: 100,
  sinkMuted: false,
  virtualRoute: [
    { name: "bs2b", rate: 44100 },
    { name: "True Stereo BRIR", rate: 44100 },
  ],
  deviceRate: 44100,
};

function normalSp(over: Partial<SignalPath> = {}): SignalPath {
  return {
    backend: "Normal",
    decodedFormat: "S16LE",
    decodedRate: 44100,
    decodedChannels: 2,
    outputFormat: "S16LE",
    outputRate: 44100,
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
    dac: naos,
    osMixer: bs2bMixer,
    ...over,
  };
}

function renderFlow(sp: SignalPath) {
  return render(
    <FlowDiagramBody
      sp={sp}
      streamInfo={null}
      currentTrack={null}
      hideTrackHeader
    />,
  ).container;
}

const textOf = (sp: SignalPath) => renderFlow(sp).textContent ?? "";

/** Text of one node box (its first child is the title). */
function nodeText(sp: SignalPath, title: string) {
  const box = Array.from(renderFlow(sp).querySelectorAll("div")).find(
    (d) => d.firstElementChild?.textContent === title,
  );
  return box?.textContent ?? "";
}

describe("FlowDiagramBody mixer stage (issue #244)", () => {
  it("does not flag a resample when stream and device rates match through a filter chain", () => {
    const text = textOf(normalSp());
    expect(text).not.toContain("LOSSY STAGE");
    expect(text).not.toContain("resampled");
    expect(text).toContain(
      "widened/repacked the stream into its internal mix format",
    );
    expect(text).toContain("VIRTUAL ROUTING");
    expect(text).toContain("bs2b (44.1k) → True Stereo BRIR (44.1k)");
  });

  it("makes no rate claim when the mixer rate is unknown", () => {
    const text = textOf(
      normalSp({
        dac: null,
        osMixer: {
          ...bs2bMixer,
          sinkRate: null,
          deviceRate: null,
          virtualRoute: [
            { name: "bs2b", rate: null },
            { name: "True Stereo BRIR", rate: null },
          ],
        },
      }),
    );
    expect(text).not.toContain("LOSSY STAGE");
    expect(text).not.toContain("resampled");
    expect(text).not.toContain("null");
  });

  it("makes no claims when the stream isn't found", () => {
    const sp = normalSp({
      dac: null,
      osMixer: {
        ...bs2bMixer,
        sinkFormat: "",
        sinkChannels: 0,
        sinkRate: null,
        deviceRate: null,
        virtualRoute: [],
      },
    });
    const text = textOf(sp);
    expect(text).not.toContain("MIX CONVERSION");
    expect(text).not.toContain("LOSSY STAGE");
    expect(nodeText(sp, "MIX")).toBe("MIX—PipeWire");
  });

  it("still flags a real resample into the mixer", () => {
    const text = textOf(
      normalSp({
        dac: { ...naos, rate: 48000 },
        osMixer: { ...bs2bMixer, sinkRate: 48000, virtualRoute: [] },
      }),
    );
    expect(text).toContain("NOT PRISTINE — 1 LOSSY STAGE");
    expect(text).toContain("resampled the stream to its internal mix rate");
  });

  it("flags a resample inside the virtual route", () => {
    const text = textOf(
      normalSp({
        osMixer: {
          ...bs2bMixer,
          virtualRoute: [
            { name: "bs2b", rate: 44100 },
            { name: "Convolver", rate: 48000 },
          ],
        },
      }),
    );
    // 44.1k hop → 48k hop (ROUTE RESAMPLE), 48k hop → 44.1k DAC (cable2).
    expect(text).toContain("NOT PRISTINE — 2 LOSSY STAGES");
    expect(text).toContain("bs2b (44.1k) → Convolver (48k)");
    expect(text).toContain("ROUTE RESAMPLE");
  });

  it("counts every rate change inside the route", () => {
    const text = textOf(
      normalSp({
        osMixer: {
          ...bs2bMixer,
          sinkRate: 48000,
          virtualRoute: [
            { name: "A", rate: 48000 },
            { name: "B", rate: 44100 },
            { name: "C", rate: 48000 },
          ],
        },
      }),
    );
    expect(text).toContain("NOT PRISTINE — 4 LOSSY STAGES");
  });

  it("still flags a rate change across an unknown hop", () => {
    const text = textOf(
      normalSp({
        dac: null,
        osMixer: {
          ...bs2bMixer,
          sinkRate: 48000,
          deviceRate: null,
          virtualRoute: [
            { name: "A", rate: 48000 },
            { name: "B", rate: null },
            { name: "C", rate: 44100 },
          ],
        },
      }),
    );
    // cable1 44.1→48 + one ROUTE RESAMPLE (48 → 44.1 across B).
    expect(text).toContain("NOT PRISTINE — 2 LOSSY STAGES");
  });

  it("compares the route to the device rate when hw_params are missing", () => {
    const text = textOf(
      normalSp({
        dac: null,
        osMixer: {
          ...bs2bMixer,
          sinkRate: 48000,
          deviceRate: 44100,
          virtualRoute: [{ name: "Echo Cancel", rate: 48000 }],
        },
      }),
    );
    expect(text).toContain("NOT PRISTINE — 2 LOSSY STAGES");
    expect(text).toContain("resampled the stream before it reached the device");
  });

  it("counts a fixed-rate hop's in and out resamples once each", () => {
    const text = textOf(
      normalSp({
        osMixer: {
          ...bs2bMixer,
          sinkRate: 48000,
          virtualRoute: [{ name: "Echo Cancel", rate: 48000 }],
        },
      }),
    );
    expect(text).toContain("NOT PRISTINE — 2 LOSSY STAGES");
  });

  it("16-bit source to S16 device via virtual sink is not lossy", () => {
    const text = textOf(normalSp({ dac: { ...naos, format: "S16_LE" } }));
    expect(text).not.toContain("LOSSY STAGE");
  });

  it("24-bit source to S16 device is lossy", () => {
    const text = textOf(
      normalSp({
        decodedFormat: "S24_32LE",
        outputFormat: "S24_32LE",
        dac: { ...naos, format: "S16_LE" },
      }),
    );
    expect(text).toContain("reduced bit depth before it reached ALSA");
  });

  it("does not present pipeline caps as the DAC in Normal mode", () => {
    expect(
      nodeText(
        normalSp({
          dac: null,
          osMixer: { ...bs2bMixer, sinkRate: null, deviceRate: null },
        }),
        "DAC",
      ),
    ).toBe("DAC—not detected");
  });

  it("shows the detected device in the DAC node", () => {
    expect(nodeText(normalSp(), "DAC")).toBe(
      "DACS32LE44.1 kHzUSB-Audio - NAOS MICRO at usb-0000:00:14.0-2, high speed",
    );
  });

  it("keeps DirectAlsa DAC fallback to pipeline caps", () => {
    const sp = normalSp({
      backend: "DirectAlsa",
      exclusiveMode: true,
      outputFormat: "S24_32LE",
      outputRate: 96000,
      dac: null,
      // osMixer is still probed in DirectAlsa; the panel must ignore it.
      osMixer: bs2bMixer,
    });
    expect(nodeText(sp, "DAC")).toBe("DACS24_32LE96 kHz2ch");
    expect(textOf(sp)).not.toContain("VIRTUAL ROUTING");
  });

  it("omits the virtual routing row for a direct device route", () => {
    const text = textOf(
      normalSp({
        osMixer: {
          ...bs2bMixer,
          sinkName: "alsa_output.naos",
          sinkFormat: "s32le",
          virtualRoute: [],
        },
      }),
    );
    expect(text).not.toContain("VIRTUAL ROUTING");
    expect(text).not.toContain("LOSSY STAGE");
  });
});
