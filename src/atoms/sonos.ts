import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

/** One Sonos zone group as returned by the `sonos_discover` command. */
export interface SonosZoneMember {
  name: string;
}

export interface SonosGroupInfo {
  coordinatorUuid: string;
  coordinatorIp: string;
  /** Coordinator's room name (display name for the group). */
  name: string;
  members: SonosZoneMember[];
  /** null = unknown (modern firmware hides the account list). */
  tidalLinked: boolean | null;
}

/** Snapshot returned by the `sonos_get_now_playing` command. */
export interface SonosNowPlaying {
  trackId: number | null;
  state: string;
  volume: number;
  muted: boolean;
}

/** Show the Sonos output picker at all (Settings → Sonos). */
export const sonosEnabledAtom = atomWithStorage("sone.sonosEnabled.v1", true);

export const sonosGroupsAtom = atom<SonosGroupInfo[]>([]);
export const sonosDiscoveringAtom = atom(false);
/** True while a cast handshake is in flight (picker shows a spinner).
 *  "Casting" itself is derived from playbackTargetAtom. */
export const sonosConnectingAtom = atom(false);

/** Sonos group volume, 0–100. Deliberately separate from the local
 *  `volumeAtom` (persisted 0–1 pipeline gain) so casting never clobbers the
 *  local volume and handoff restores it exactly. */
export const sonosVolumeAtom = atom(0);
export const sonosMutedAtom = atom(false);

/** Deferred seek applied on the first remote resume — set when casting
 *  while paused, because Sonos can't reliably seek a STOPPED transport. */
export const sonosPendingResumeSeekAtom = atom<number | null>(null);
