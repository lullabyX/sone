/**
 * useSonosActions — discovery and cast-session lifecycle (zero-subscription,
 * like usePlaybackActions). Handoffs preserve position in both directions
 * and never auto-start audio the user didn't ask for.
 */

import { useCallback } from "react";
import { useStore } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import {
  currentTrackAtom,
  isPlayingAtom,
  playbackTargetAtom,
  streamInfoAtom,
  userPausedAtom,
} from "../atoms/playback";
import {
  sonosConnectingAtom,
  sonosDiscoveringAtom,
  sonosEnabledAtom,
  sonosGroupsAtom,
  sonosMutedAtom,
  sonosPendingResumeSeekAtom,
  sonosVolumeAtom,
  type SonosGroupInfo,
  type SonosNowPlaying,
} from "../atoms/sonos";
import {
  getInterpolatedPosition,
  markPlaybackLoading,
  notifySeek,
  setPositionSource,
} from "../lib/playbackPosition";
import { usePlaybackActions } from "./usePlaybackActions";
import { useToast } from "../contexts/ToastContext";
import { buildSonosMeta } from "../lib/sonosMeta";

interface SessionInfo {
  coordinatorUuid: string;
  roomName: string;
}

// Module-level so every hook instance shares the same guard: overlapping
// cast transfers would race the session slot and the atoms.
let transferInFlight = false;

interface ReattachInfo extends SessionInfo {
  trackId: number;
  positionSecs: number;
  volume: number;
  muted: boolean;
}

export function useSonosActions() {
  const store = useStore();
  const { showToast } = useToast();
  const { playTrack, seekTo, adoptRemoteTrack } = usePlaybackActions();

  const discover = useCallback(async (): Promise<SonosGroupInfo[]> => {
    store.set(sonosDiscoveringAtom, true);
    try {
      const groups = await invoke<SonosGroupInfo[]>("sonos_discover");
      store.set(sonosGroupsAtom, groups);
      return groups;
    } catch (error) {
      console.error("Sonos discovery failed:", error);
      return [];
    } finally {
      store.set(sonosDiscoveringAtom, false);
    }
  }, [store]);

  const addManualIp = useCallback(
    async (ip: string): Promise<boolean> => {
      try {
        const groups = await invoke<SonosGroupInfo[]>("sonos_add_manual_ip", {
          ip,
        });
        store.set(sonosGroupsAtom, groups);
        return true;
      } catch (error) {
        console.error("Failed to add Sonos device:", error);
        showToast("No Sonos speaker found at that address", "error");
        return false;
      }
    },
    [store, showToast],
  );

  const removeManualIp = useCallback(
    async (ip: string) => {
      try {
        const groups = await invoke<SonosGroupInfo[]>(
          "sonos_remove_manual_ip",
          { ip },
        );
        store.set(sonosGroupsAtom, groups);
      } catch (error) {
        console.error("Failed to remove Sonos device:", error);
      }
    },
    [store],
  );

  /** Detach the UI from the (ended or abandoned) cast session. Never starts
   *  local playback — surprise audio is worse than a manual resume. */
  const detachToLocal = useCallback(
    (opts?: { pauseRemote?: boolean }) => {
      store.set(sonosPendingResumeSeekAtom, null);
      store.set(playbackTargetAtom, { type: "local" });
      setPositionSource("local");
      store.set(sonosConnectingAtom, false);
      store.set(isPlayingAtom, false);
      store.set(userPausedAtom, true);
      markPlaybackLoading(false);
      invoke("sonos_disconnect", {
        pauseRemote: opts?.pauseRemote ?? false,
      }).catch(() => {});
    },
    [store],
  );

  /** Hand playback to a Sonos group, carrying over the current track,
   *  position, and play/pause state. */
  const castToGroup = useCallback(
    async (group: SonosGroupInfo) => {
      const target = store.get(playbackTargetAtom);
      if (
        transferInFlight ||
        (target.type === "sonos" &&
          target.coordinatorUuid === group.coordinatorUuid)
      ) {
        return;
      }
      transferInFlight = true;
      store.set(sonosConnectingAtom, true);

      try {
        const info = await invoke<SessionInfo>("sonos_connect", {
          groupUuid: group.coordinatorUuid,
        });

        // Snapshot AFTER the (potentially slow) connect: the track may have
        // advanced meanwhile — carry over what is playing NOW.
        const current = store.get(currentTrackAtom);
        const wasPlaying = store.get(isPlayingAtom);
        const position = getInterpolatedPosition();

        // Freeze the position display for the whole handoff; the poll source
        // only flips to the speaker once the speaker has the track.
        markPlaybackLoading(true);

        // Connected — silence the local pipeline (no scrobble/MPRIS stop
        // side effects; the listen continues on the speaker).
        await invoke("stop_track_silent").catch(() => {});
        store.set(playbackTargetAtom, {
          type: "sonos",
          coordinatorUuid: info.coordinatorUuid,
          roomName: info.roomName,
        });
        store.set(streamInfoAtom, null);

        // Adopt the group's volume as the active volume surface.
        try {
          const now = await invoke<SonosNowPlaying>("sonos_get_now_playing");
          store.set(sonosVolumeAtom, now.volume);
          store.set(sonosMutedAtom, now.muted);
        } catch {
          /* non-fatal */
        }

        if (current) {
          await invoke("sonos_play_track", {
            trackId: current.id,
            meta: buildSonosMeta(current),
            start: wasPlaying,
          });
          // Don't seek into (or past) the final seconds of the track.
          const seekable =
            position > 1 &&
            (!current.duration || position < current.duration - 2);
          if (wasPlaying) {
            store.set(sonosPendingResumeSeekAtom, null);
            if (seekable) {
              await invoke("sonos_seek", {
                positionSecs: position,
              }).catch(() => {});
            }
            setPositionSource("remote");
            notifySeek(seekable ? position : 0);
            store.set(isPlayingAtom, true);
          } else {
            // Enqueued but not started: the transport is STOPPED and can't
            // be seeked yet — defer the position to the first resume.
            store.set(sonosPendingResumeSeekAtom, seekable ? position : null);
            setPositionSource("remote");
            notifySeek(seekable ? position : 0);
            store.set(isPlayingAtom, false);
          }
        } else {
          setPositionSource("remote");
          markPlaybackLoading(false);
        }
      } catch (error) {
        console.error("Failed to cast to Sonos:", error);
        // Local audio may already be stopped — leave the app cleanly
        // paused. detachToLocal also kills any spawned session watcher.
        detachToLocal();
        showToast(`Couldn't play on ${group.name}`, "error");
      } finally {
        store.set(sonosConnectingAtom, false);
        transferInFlight = false;
      }
    },
    [store, showToast],
  );

  /** Bring playback back to this computer, carrying over position. */
  const switchToLocal = useCallback(async () => {
    const target = store.get(playbackTargetAtom);
    if (target.type !== "sonos" || transferInFlight) return;
    transferInFlight = true;
    try {
      const wasPlaying = store.get(isPlayingAtom);
      const position = getInterpolatedPosition();

      store.set(sonosPendingResumeSeekAtom, null);
      store.set(playbackTargetAtom, { type: "local" });
      setPositionSource("local");
      await invoke("sonos_disconnect", { pauseRemote: true }).catch(() => {});

      const current = store.get(currentTrackAtom);
      if (current && wasPlaying) {
        // Same listen, new renderer — don't restart the scrobble clock.
        const result = await playTrack(current, {
          skipHistoryPush: true,
          skipScrobbleStart: true,
        });
        if (result.ok && position > 1) {
          await seekTo(position);
        }
      } else {
        store.set(isPlayingAtom, false);
        markPlaybackLoading(false);
      }
    } finally {
      transferInFlight = false;
    }
  }, [store, playTrack, seekTo]);

  /** Silent startup reattach: if the last cast group is still playing SONE's
   *  queue, re-adopt the session instead of starting local-idle. Runs once
   *  after the queue snapshot restores; every miss is a no-op. */
  const tryReattach = useCallback(async () => {
    if (!store.get(sonosEnabledAtom)) return;
    if (store.get(playbackTargetAtom).type !== "local") return;
    if (store.get(isPlayingAtom)) return; // local playback already started
    try {
      const result = await invoke<ReattachInfo | null>("sonos_try_reattach");
      if (!result) return;
      if (store.get(isPlayingAtom)) {
        // The user started local playback during the probe — abandon.
        invoke("sonos_disconnect", { pauseRemote: false }).catch(() => {});
        return;
      }
      const current = store.get(currentTrackAtom);
      if (
        (!current || current.id !== result.trackId) &&
        !adoptRemoteTrack(result.trackId)
      ) {
        // Playing something the restored queue doesn't know — leave it be.
        invoke("sonos_disconnect", { pauseRemote: false }).catch(() => {});
        return;
      }
      store.set(playbackTargetAtom, {
        type: "sonos",
        coordinatorUuid: result.coordinatorUuid,
        roomName: result.roomName,
      });
      setPositionSource("remote");
      store.set(streamInfoAtom, null);
      store.set(sonosVolumeAtom, result.volume);
      store.set(sonosMutedAtom, result.muted);
      store.set(userPausedAtom, false);
      store.set(isPlayingAtom, true);
      notifySeek(result.positionSecs);
      console.info(`Reattached to live Sonos session on ${result.roomName}`);
    } catch {
      /* reattach is best-effort */
    }
  }, [store, adoptRemoteTrack]);

  return {
    discover,
    addManualIp,
    removeManualIp,
    castToGroup,
    switchToLocal,
    detachToLocal,
    tryReattach,
  };
}
