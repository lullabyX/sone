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

export interface OsMixerInfo {
  server: string; // "PipeWire" | "PulseAudio" | "Unknown"
  defaultSinkName: string;
  sinkFormat: string;
  sinkRate: number;
  sinkChannels: number;
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

export const allowExplicitAtom = atomWithStorage("sone.allowExplicit.v1", true);

export const exclusiveModeAtom = atom(false);
export const bitPerfectAtom = atom(false);
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
