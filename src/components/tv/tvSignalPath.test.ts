import { describe, expect, it } from "vitest";
import type { DacHwParams, SignalPath } from "../../atoms/playback";
import type { Track } from "../../types";
import { signalPathMenu, signalTone } from "./tvSignalPath";

const dac: DacHwParams = {
  cardIndex: 1,
  cardName: "USB-Audio - Topping D10s at usb-0000:00:14.0-2, high speed",
  pcmDevice: "hw:CARD=D10s,DEV=0",
  format: "S24_3LE",
  rate: 96000,
  channels: 2,
  periodSize: 1024,
  bufferSize: 4096,
  state: "Active",
};

/** FLAC 24/96 played exclusively and bit-perfect straight to the DAC. */
function pristine(over: Partial<SignalPath> = {}): SignalPath {
  return {
    backend: "DirectAlsa",
    decodedFormat: "S24_32LE",
    decodedRate: 96000,
    decodedChannels: 2,
    outputFormat: "S24_32LE",
    outputRate: 96000,
    outputChannels: 2,
    outputDevice: null,
    exclusiveMode: true,
    bitPerfect: true,
    volumeNormalization: false,
    userVolume: 1,
    normGainFactor: 1,
    resampledFrom: null,
    resampledTo: null,
    promotedFrom: null,
    promotedTo: null,
    formatFallbackFrom: null,
    formatFallbackTo: null,
    dac: { ...dac, format: "S24_LE" },
    osMixer: null,
    ...over,
  };
}

describe("signalTone", () => {
  it("is green when every bit reaches the DAC untouched", () => {
    expect(signalTone(pristine())).toBe("ok");
  });

  it("is amber when the audio is changed without losing bits", () => {
    expect(
      signalTone(pristine({ volumeNormalization: true, normGainFactor: 0.49 })),
    ).toBe("warn");
  });

  it("is red when audio bits are lost", () => {
    expect(
      signalTone(pristine({ resampledFrom: 44100, resampledTo: 48000 })),
    ).toBe("lossy");
  });

  it("is grey while nothing plays, the output starts or the DAC is inactive", () => {
    expect(signalTone(null)).toBe("neutral");
    expect(signalTone(pristine({ backend: null }))).toBe("neutral");
    expect(signalTone(pristine({ dac: null, outputFormat: null }))).toBe(
      "neutral",
    );
    expect(signalTone(pristine({ dac: { ...dac, state: "Closed" } }))).toBe(
      "neutral",
    );
  });
});

describe("signalPathMenu", () => {
  it("lists the stages, read-only, with the quality and DAC on top", () => {
    const menu = signalPathMenu(pristine(), null, null);
    expect(menu.title).toBe("Signal path");
    expect(menu.verdict).toMatchObject({
      tone: "ok",
      word: "PRISTINE",
      facts: "Topping D10s · Exclusive · Bit-perfect · ALSA direct",
    });
    expect(menu.verdict!.count).toBeUndefined();
    expect(menu.items.map((i) => i.label)).toEqual([
      "TIDAL",
      "DECODE",
      "MIX",
      "DAC",
    ]);
    expect(menu.items.every((i) => i.info && !i.onSelect)).toBe(true);
    expect(menu.items.some((i) => i.tone)).toBe(false);
  });

  it("puts each change after the stage it follows, red when bits are lost", () => {
    const menu = signalPathMenu(
      pristine({
        resampledFrom: 96000,
        resampledTo: 48000,
        volumeNormalization: true,
        normGainFactor: 0.49,
      }),
      null,
      null,
    );
    expect(menu.items.map((i) => i.label)).toEqual([
      "TIDAL",
      "DECODE",
      "RESAMPLED",
      "MIX",
      "REPLAYGAIN",
      "DAC",
    ]);
    const resampled = menu.items.find((i) => i.label === "RESAMPLED")!;
    expect(resampled.tone).toBe("lossy");
    expect(resampled.detail).toBe("96 kHz → 48 kHz");
    const gain = menu.items.find((i) => i.label === "REPLAYGAIN")!;
    expect(gain.tone).toBe("warn");
    // The pill shows just the numbers that changed.
    expect(gain.detail).toBe("-6.2 dB");
    expect(gain.note).toBeUndefined();
  });

  it("says so when nothing is playing", () => {
    const menu = signalPathMenu(null, null, null);
    expect(menu.items).toEqual([]);
    expect(menu.verdict).toMatchObject({
      tone: "neutral",
      word: "IDLE",
      headline: "Nothing is playing",
    });
  });

  it("calls a mixer resample LOSSY, names it, counts the changes and titles the track", () => {
    const sp = pristine({
      backend: "Normal",
      exclusiveMode: false,
      bitPerfect: false,
      decodedFormat: "S16LE",
      decodedRate: 44100,
      outputFormat: "S16LE",
      outputRate: 44100,
      volumeNormalization: true,
      normGainFactor: 0.49,
      dac: { ...dac, format: "S32_LE", rate: 48000 },
      osMixer: {
        server: "PipeWire",
        defaultSinkName: "sink",
        sinkName: "sink",
        sinkFormat: "s32le",
        sinkRate: 48000,
        sinkChannels: 2,
        sinkVolume: 1,
        sinkVolumePercent: 100,
        sinkMuted: false,
        virtualRoute: [],
        deviceRate: 48000,
      },
    });
    const track = {
      id: 1,
      title: "Teardrop",
      artist: { id: 2, name: "Massive Attack" },
    } as Track;
    const menu = signalPathMenu(sp, null, track);
    expect(menu.subtitle).toBe("Teardrop · Massive Attack");
    expect(menu.verdict).toMatchObject({
      tone: "lossy",
      word: "LOSSY",
      count: "1 lossy · 1 modified",
      headline: "Resampled 44.1 kHz → 48 kHz by PipeWire",
      facts: "Topping D10s · Shared · PipeWire",
    });
  });

  it("names the starting and inactive states", () => {
    expect(
      signalPathMenu(pristine({ dac: null, outputFormat: null }), null, null)
        .verdict,
    ).toMatchObject({ tone: "neutral", word: "STARTING" });
    expect(
      signalPathMenu(pristine({ dac: { ...dac, state: "Closed" } }), null, null)
        .verdict,
    ).toMatchObject({ tone: "neutral", word: "DAC INACTIVE" });
  });
});
