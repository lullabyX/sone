import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { Track, StreamInfo, PlaybackSource } from "../types";

export interface DacHwParams {
  cardIndex: number;
  cardName: string;
  pcmDevice: string;
  format: string;
  rate: number;
  channels: number;
  periodSize: number;
  bufferSize: number;
  state: "Active" | "Closed";
}

export interface VirtualHop {
  name: string;
  /** Rate this hop runs at; null when unknown. */
  rate: number | null;
}

export interface OsMixerInfo {
  server: string; // "PipeWire" | "PulseAudio" | "Unknown"
  defaultSinkName: string;
  /** Sink SONE's stream feeds. */
  sinkName: string;
  /** Empty when unknown. */
  sinkFormat: string;
  /** Rate the mixer runs at; null when it can't be determined. */
  sinkRate: number | null;
  sinkChannels: number;
  /** Linear amplitude multiplier the OS applies along the route. 1.0 = unity, 0.0 = mute. */
  sinkVolume: number;
  /** `sinkVolume` on the cubic slider scale the OS volume widget uses. */
  sinkVolumePercent: number;
  sinkMuted: boolean;
  /** Virtual sinks (effects, loopbacks) between `sinkName` and the device. */
  virtualRoute: VirtualHop[];
  /** Rate at the device; null when unknown. */
  deviceRate: number | null;
}

export interface SignalPath {
  backend: string | null;
  decodedFormat: string | null;
  decodedRate: number | null;
  decodedChannels: number | null;
  outputFormat: string | null;
  outputRate: number | null;
  outputChannels: number | null;
  outputDevice: string | null;
  exclusiveMode: boolean;
  bitPerfect: boolean;
  volumeNormalization: boolean;
  userVolume: number; // amplitude (was slider position)
  normGainFactor: number;
  resampledFrom: number | null;
  resampledTo: number | null;
  promotedFrom: string | null;
  promotedTo: string | null;
  formatFallbackFrom: string | null;
  formatFallbackTo: string | null;
  dac: DacHwParams | null;
  osMixer: OsMixerInfo | null;
}

export const signalPathAtom = atom<SignalPath | null>(null);

export const isPlayingAtom = atom(false);
export const currentTrackAtom = atom<Track | null>(null);
export const volumeAtom = atomWithStorage("sone.volume.v1", 1.0, undefined, {
  getOnInit: true,
});
export const queueAtom = atom<Track[]>([]);
export const historyAtom = atom<Track[]>([]);
export const streamInfoAtom = atom<StreamInfo | null>(null);
export const preMuteVolumeAtom = atom<number>(0);
export const autoplayAtom = atomWithStorage("sone.autoplay.v1", false);

/** true = use track replay gain (shuffle/mixed queue), false = use album replay gain (album in order) */
export const useTrackGainAtom = atom(true);

export const repeatAtom = atomWithStorage("sone.repeat.v1", 0); // 0 = off, 1 = repeat-all, 2 = repeat-one
export const shuffleAtom = atomWithStorage("sone.shuffle.v1", false);
export const manualQueueAtom = atom<Track[]>([]);
export const originalQueueAtom = atom<Track[] | null>(null);
export const playbackSourceAtom = atom<PlaybackSource | null>(null);
export const contextSourceAtom = atom<PlaybackSource | null>(null);
/** Incremented whenever the context queue is replaced wholesale. */
export const queueEpochAtom = atom(0);

export const allowExplicitAtom = atomWithStorage(
  "sone.allowExplicit.v1",
  true,
  undefined,
  { getOnInit: true },
);
export const allowAiAtom = atomWithStorage("sone.allowAi.v1", true, undefined, {
  getOnInit: true,
});

export const exclusiveModeAtom = atom(false);
export const bitPerfectAtom = atom(false);

/** Gapless playback kill-switch (Normal mode only). Default ON. */
export const gaplessAtom = atom(true);
/** Max streaming-quality ceiling: "HI_RES_LOSSLESS" | "LOSSLESS" | "HIGH". Backend-authoritative. */
export const maxQualityAtom = atom("HI_RES_LOSSLESS");
export const exclusiveDeviceAtom = atom<string | null>(null);
export const volumeNormalizationAtom = atom(false);

interface BitPerfectPreviousState {
  volume: number;
  volumeNormalization: boolean;
}

export const bitPerfectPreviousStateAtom =
  atomWithStorage<BitPerfectPreviousState | null>(
    "sone.bitPerfect.previousState.v1",
    null,
    undefined,
    { getOnInit: true },
  );

/** Consecutive auto-advance failures for unplayable tracks.
 *  Only mutated by playNext's skip-loop; reset on successful play. */
export const consecutiveFailCountAtom = atom(0);

/** Global explicit user-pause intent. Written by every pauseTrack/resumeTrack/
 *  playTrack/playNext path (instance-independent, unlike a per-hook ref) so that
 *  gapless advanceToTrack can never resume audio the user paused. */
export const userPausedAtom = atom(false);
