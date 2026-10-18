import { invoke } from "@tauri-apps/api/core";
import type { createStore } from "jotai";
import {
  contextSourceAtom,
  currentTrackAtom,
  historyAtom,
  isPlayingAtom,
  manualQueueAtom,
  originalQueueAtom,
  playbackSourceAtom,
  queueAtom,
  queueEpochAtom,
} from "../atoms/playback";

type Store = ReturnType<typeof createStore>;

export function resetPlaybackForContentChange(store: Store): void {
  invoke("stop_track").catch(() => {});
  store.set(currentTrackAtom, null);
  store.set(isPlayingAtom, false);
  store.set(queueAtom, []);
  store.set(manualQueueAtom, []);
  store.set(originalQueueAtom, null);
  store.set(historyAtom, []);
  store.set(playbackSourceAtom, null);
  store.set(contextSourceAtom, null);
  store.set(queueEpochAtom, store.get(queueEpochAtom) + 1);
}
