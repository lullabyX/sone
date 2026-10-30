import { useCallback } from "react";
import { useStore } from "jotai";
import {
  bitPerfectAtom,
  currentTrackAtom,
  preMuteVolumeAtom,
  volumeAtom,
} from "../../atoms/playback";
import { tvVolumeLockedPingAtom } from "../../atoms/tv";
import { currentVideoAtom } from "../../atoms/video";
import { usePlaybackActions } from "../../hooks/usePlaybackActions";
import { getInterpolatedPosition } from "../../lib/playbackPosition";
import { videoElementRef } from "../../lib/videoElement";
import type { TvMediaCommand } from "./tvKeys";

const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(n, min), Math.max(min, max));

/** Carries out a media command (remote key, mini bar, Now Playing) on
 *  whatever is current: the audio track or a video. */
export function useTvMediaCommands(): (cmd: TvMediaCommand) => void {
  const store = useStore();
  const {
    togglePlayPause,
    resumeTrack,
    pauseTrack,
    playNext,
    playPrevious,
    seekTo,
    setVolume,
  } = usePlaybackActions();

  return useCallback(
    (cmd: TvMediaCommand) => {
      if (
        (cmd.kind === "volume" || cmd.kind === "mute") &&
        store.get(bitPerfectAtom) &&
        !store.get(currentVideoAtom)
      ) {
        store.set(tvVolumeLockedPingAtom, (n) => n + 1);
        return;
      }
      switch (cmd.kind) {
        case "toggle":
          void togglePlayPause();
          return;
        case "play":
          void resumeTrack();
          return;
        case "pause":
          void pauseTrack();
          return;
        case "next":
          void playNext({ explicit: true });
          return;
        case "previous":
          void playPrevious();
          return;
        case "seek": {
          const video = videoElementRef.current;
          if (store.get(currentVideoAtom)) {
            if (!video || !Number.isFinite(video.duration)) return;
            video.currentTime = clamp(
              video.currentTime + cmd.by,
              0,
              video.duration - 0.5,
            );
            return;
          }
          const track = store.get(currentTrackAtom);
          if (!track) return;
          void seekTo(
            clamp(getInterpolatedPosition() + cmd.by, 0, track.duration - 1),
          );
          return;
        }
        case "volume": {
          const next = Math.round((store.get(volumeAtom) + cmd.by) * 100) / 100;
          void setVolume(clamp(next, 0, 1));
          return;
        }
        case "mute": {
          const volume = store.get(volumeAtom);
          if (volume > 0) {
            store.set(preMuteVolumeAtom, volume);
            void setVolume(0);
          } else {
            void setVolume(store.get(preMuteVolumeAtom) || 0.5);
          }
          return;
        }
      }
    },
    [
      store,
      togglePlayPause,
      resumeTrack,
      pauseTrack,
      playNext,
      playPrevious,
      seekTo,
      setVolume,
    ],
  );
}
