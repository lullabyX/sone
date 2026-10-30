import type { TvView } from "./tvItems";

/** A screen on the TV stack. `returnTo: "nowPlaying"` marks one opened from
 *  the Now Playing layer: Back from it reopens Now Playing. */
export interface TvStackEntry {
  id: number;
  view: TvView;
  returnTo?: "nowPlaying";
}

/** Now Playing is a layer above the stack, never an entry on it. */
export function tvPush(
  stack: TvStackEntry[],
  entry: TvStackEntry,
  nowPlayingOpen: boolean,
): TvStackEntry[] {
  if (entry.view.type === "nowPlaying") return stack;
  return [
    ...stack,
    nowPlayingOpen ? { ...entry, returnTo: "nowPlaying" } : entry,
  ];
}

export type TvBackStep =
  | { kind: "closeNowPlaying" }
  | {
      kind: "pop";
      stack: TvStackEntry[];
      popped: TvStackEntry;
      reopenNowPlaying: boolean;
    }
  | { kind: "root" };

export function tvBackStep(
  stack: TvStackEntry[],
  nowPlayingOpen: boolean,
): TvBackStep {
  if (nowPlayingOpen) return { kind: "closeNowPlaying" };
  if (stack.length > 1) {
    const popped = stack[stack.length - 1];
    return {
      kind: "pop",
      stack: stack.slice(0, -1),
      popped,
      reopenNowPlaying: popped.returnTo === "nowPlaying",
    };
  }
  return { kind: "root" };
}
