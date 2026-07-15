/**
 * useSonosBridge — maps the cast-session watcher's Tauri events into the
 * playback atoms. Every write is guarded on the target being Sonos, so stale
 * events can never disturb local playback. Mounted once from AppInitializer.
 */

import { useEffect } from "react";
import { useStore } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  currentTrackAtom,
  isPlayingAtom,
  playbackTargetAtom,
  streamInfoAtom,
  userPausedAtom,
} from "../atoms/playback";
import {
  sonosMutedAtom,
  sonosVolumeAtom,
  type SonosNowPlaying,
} from "../atoms/sonos";
import { usePlaybackActions } from "./usePlaybackActions";
import { useSonosActions } from "./useSonosActions";
import { useToast } from "../contexts/ToastContext";

export function useSonosBridge() {
  const store = useStore();
  const { showToast } = useToast();
  const { playNext, adoptRemoteTrack } = usePlaybackActions();
  const { detachToLocal } = useSonosActions();

  useEffect(() => {
    const remote = () => store.get(playbackTargetAtom).type === "sonos";
    const roomName = () => {
      const target = store.get(playbackTargetAtom);
      return target.type === "sonos" ? target.roomName : "Sonos";
    };

    const scheduleTakeoverCheck = () => {
      setTimeout(async () => {
        if (!remote()) return;
        try {
          const now = await invoke<SonosNowPlaying>("sonos_get_now_playing");
          const freshCurrent = store.get(currentTrackAtom);
          if (
            now.trackId != null &&
            freshCurrent &&
            now.trackId === freshCurrent.id
          ) {
            return; // caught up — it was SONE's own in-flight change
          }
          // Last chance: an external jump that landed after the event.
          if (now.trackId != null && adoptRemoteTrack(now.trackId)) {
            return;
          }
        } catch {
          return; // session already gone; sonos-session-ended handles it
        }
        const room = roomName();
        detachToLocal();
        showToast(`Playback taken over on ${room}`, "info");
      }, 1500);
    };

    const unlistenPromises = [
      // External play/pause/stop (Sonos app, physical buttons). Echoes of
      // SONE's own commands find the atom already updated and no-op; only
      // genuinely external transitions notify the scrobbler.
      listen<{ state: string }>("sonos-transport-changed", (event) => {
        if (!remote()) return;
        const { state } = event.payload;
        if (state === "PLAYING") {
          if (!store.get(isPlayingAtom)) {
            store.set(isPlayingAtom, true);
            store.set(userPausedAtom, false);
            invoke("notify_track_resumed").catch(() => {});
          }
        } else if (state === "PAUSED_PLAYBACK" || state === "STOPPED") {
          if (store.get(isPlayingAtom)) {
            store.set(isPlayingAtom, false);
            store.set(userPausedAtom, true);
            invoke("notify_track_paused").catch(() => {});
          }
        }
      }),

      // Natural end of the current (single-entry) speaker queue — same
      // contract as the local pipeline's "track-finished".
      listen("sonos-track-finished", () => {
        if (!remote()) return;
        store.set(streamInfoAtom, null);
        void playNext();
      }),

      // The speaker self-advanced into a mirrored queue entry (native
      // gapless): reconcile the exact instance by qid — history push, queue
      // drain, current-track adoption, scrobble start.
      listen<{ trackId: number; qid: string }>(
        "sonos-track-advanced",
        (event) => {
          if (!remote()) return;
          const { trackId, qid } = event.payload;
          if (!adoptRemoteTrack(trackId, qid) && !adoptRemoteTrack(trackId)) {
            // The mirrored entry no longer maps to the queue atoms (edit raced the
            // boundary). The speaker IS playing it though — treat like an
            // external change below.
            scheduleTakeoverCheck();
          }
        },
      ),

      // The speaker switched to a track the mirror didn't predict. First
      // try to map it onto the queue/history atoms (Sonos-app Next/Previous/jump
      // are legitimate); only an unmappable track suggests takeover — and
      // even then re-verify, since a rapid double-skip briefly shows an
      // intermediate track while a play command is in flight.
      listen<{ trackId: number | null }>("sonos-track-changed", (event) => {
        if (!remote()) return;
        const current = store.get(currentTrackAtom);
        const { trackId } = event.payload;
        if (trackId != null && current && trackId === current.id) return;
        if (trackId != null && adoptRemoteTrack(trackId)) return;
        scheduleTakeoverCheck();
      }),

      listen<{ volume: number; muted: boolean }>(
        "sonos-volume-changed",
        (event) => {
          if (!remote()) return;
          store.set(sonosVolumeAtom, event.payload.volume);
          store.set(sonosMutedAtom, event.payload.muted);
        },
      ),

      listen<{ reason: string }>("sonos-session-ended", (event) => {
        if (!remote()) return;
        const room = roomName();
        detachToLocal();
        if (event.payload.reason === "takenOver") {
          showToast(`Playback taken over on ${room}`, "info");
        } else {
          showToast(`Lost connection to ${room} — playback paused`, "error");
        }
      }),
    ];

    return () => {
      unlistenPromises.forEach((p) => {
        p.then((unlisten) => unlisten());
      });
    };
  }, [store, playNext, adoptRemoteTrack, detachToLocal, showToast]);
}
