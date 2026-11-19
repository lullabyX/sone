import { useAtomValue } from "jotai";
import { volumeLockedAtom } from "../atoms/playback";

export function useVolumeLocked(): boolean {
  return useAtomValue(volumeLockedAtom);
}
