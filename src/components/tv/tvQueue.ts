import type { Track } from "../../types";

/** Where `track` sits in the combined queue (manual first, then context),
 *  matched by queue id when it has one, else by reference; -1 if gone. */
export function queueIndexOf(
  manual: Track[],
  context: Track[],
  track: Track,
): number {
  const all = [...manual, ...context];
  return track._qid
    ? all.findIndex((t) => t._qid === track._qid)
    : all.indexOf(track);
}

/** The combined queue with `track` moved one place up or down, or to the
 *  top, and the new manual/context boundary (the drawer's drag rule); null
 *  when the track is gone or cannot move that way. */
export function moveInQueue(
  manual: Track[],
  context: Track[],
  track: Track,
  to: "up" | "down" | "top",
): { tracks: Track[]; manualCount: number } | null {
  const from = queueIndexOf(manual, context, track);
  if (from < 0) return null;
  const target = to === "top" ? 0 : to === "up" ? from - 1 : from + 1;
  const total = manual.length + context.length;
  if (target === from || target < 0 || target >= total) return null;
  const tracks = [...manual, ...context];
  const [moved] = tracks.splice(from, 1);
  tracks.splice(target, 0, moved);
  const mc = manual.length;
  let manualCount = mc;
  if (from < mc && target >= mc) manualCount = mc - 1;
  else if (from >= mc && target < mc) manualCount = mc + 1;
  return { tracks, manualCount };
}
