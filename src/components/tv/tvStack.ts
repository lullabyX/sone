import type { TvView } from "./tvItems";

/** A screen on the TV stack. `returnTo: "nowPlaying"` marks one opened from
 *  the Now Playing layer: Back from it reopens Now Playing. */
export interface TvStackEntry {
  id: number;
  view: TvView;
  returnTo?: "nowPlaying";
}

/** What makes two views the same page: the rail's screens, and the pages
 *  that show one item. */
function pageIdentity(view: TvView): string | null {
  switch (view.type) {
    case "home":
    case "search":
    case "explore":
    case "feed":
    case "collection":
    case "settings":
      return `root:${view.type}`;
    case "album":
      return `album:${view.id}`;
    case "playlist":
      return `playlist:${view.uuid}`;
    case "mix":
      return `mix:${view.mixId}`;
    case "artist":
      return `artist:${view.id}`;
    case "artistTracks":
      return `artistTracks:${view.artistId}`;
    case "favorites":
      return "favorites";
    default:
      return null;
  }
}

/** Where the stack already holds the page `view` opens, or -1. */
export function tvStackIndexOf(stack: TvStackEntry[], view: TvView): number {
  const id = pageIdentity(view);
  return id === null ? -1 : stack.findIndex((e) => pageIdentity(e.view) === id);
}

/** Now Playing is a layer above the stack, never an entry on it. A page
 *  already on the stack is never opened twice: the stack goes back to it
 *  (as if by Back), keeping its own view; opened from Now Playing it is
 *  marked so Back reopens the layer. The page right under Now Playing is
 *  left as it is: closing the layer shows it. */
export function tvPush(
  stack: TvStackEntry[],
  entry: TvStackEntry,
  nowPlayingOpen: boolean,
): TvStackEntry[] {
  if (entry.view.type === "nowPlaying") return stack;
  const at = tvStackIndexOf(stack, entry.view);
  if (at >= 0) {
    if (at === stack.length - 1) return stack;
    const kept = stack[at];
    return [
      ...stack.slice(0, at),
      nowPlayingOpen ? { ...kept, returnTo: "nowPlaying" } : kept,
    ];
  }
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
