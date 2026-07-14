import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

/** One Sonos zone group as returned by the `sonos_discover` command. */
export interface SonosZoneMember {
  uuid: string;
  ip: string;
  name: string;
}

export interface SonosGroupInfo {
  id: string;
  coordinatorUuid: string;
  coordinatorIp: string;
  /** Coordinator's room name (display name for the group). */
  name: string;
  members: SonosZoneMember[];
  /** null = unknown (modern firmware hides the account list). */
  tidalLinked: boolean | null;
  tidalSerial: string | null;
}

type SonosCastState = "idle" | "connecting" | "casting" | "error";

/** Show the Sonos output picker at all (Settings → Sonos). */
export const sonosEnabledAtom = atomWithStorage("sone.sonosEnabled.v1", true);

export const sonosGroupsAtom = atom<SonosGroupInfo[]>([]);
export const sonosDiscoveringAtom = atom(false);
export const sonosCastStateAtom = atom<SonosCastState>("idle");

/** Sonos group volume, 0–100. Deliberately separate from the local
 *  `volumeAtom` (persisted 0–1 pipeline gain) so casting never clobbers the
 *  local volume and handoff restores it exactly. */
export const sonosVolumeAtom = atom(0);
export const sonosMutedAtom = atom(false);

/** Position to apply on the first remote resume. Set when casting while
 *  paused: the track is enqueued but the transport is STOPPED, and Sonos
 *  cannot reliably seek a stopped transport — so the seek is deferred to
 *  right after Play. */
export const sonosPendingResumeSeekAtom = atom<number | null>(null);
