import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { Track, StreamInfo, PlaybackSource } from "../types";

export const isPlayingAtom = atom(false);
export const currentTrackAtom = atom<Track | null>(null);
export const volumeAtom = atomWithStorage("sone.volume.v1", 1.0);
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

export const exclusiveModeAtom = atom(false);
export const bitPerfectAtom = atom(false);
export const exclusiveDeviceAtom = atom<string | null>(null);
