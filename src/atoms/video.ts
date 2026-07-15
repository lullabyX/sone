import { atom } from "jotai";
import type { TidalVideo, VideoStreamInfo } from "../types";

/** The video currently open in the takeover player (null = closed). */
export const currentVideoAtom = atom<TidalVideo | null>(null);
export const videoPlayingAtom = atom(false);
export const videoStreamAtom = atom<VideoStreamInfo | null>(null);
export const videoFullscreenAtom = atom(false);
/** Overlay visible when true; minimized to the player bar when false. */
export const videoExpandedAtom = atom(false);
