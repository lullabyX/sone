import { useAtomValue } from "jotai";
import { bitPerfectAtom } from "../atoms/playback";
import { currentVideoAtom } from "../atoms/video";

/** Bit-perfect locks volume at unity, but only for audio: video audio is
 *  lossy and plays through the <video> element, so it stays adjustable. */
export function useVolumeLocked(): boolean {
  const bitPerfect = useAtomValue(bitPerfectAtom);
  const currentVideo = useAtomValue(currentVideoAtom);
  return bitPerfect && !currentVideo;
}
