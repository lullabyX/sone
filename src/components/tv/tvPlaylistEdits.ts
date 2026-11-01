import { useSyncExternalStore } from "react";
import { invalidateCache } from "../../api/tidal";

/**
 * Writes to one playlist (removals, adds, edits) go out one at a time, in
 * the order they were made, from whichever page or menu made them, and keep
 * going after that page has closed. Removals send a row's position, so a
 * position is only right for the list it was read from: each write bumps
 * the playlist's revision when it is queued, and a page whose rows were
 * loaded at an older revision must reload before it removes anything.
 */
interface PlaylistEdits {
  chain: Promise<void>;
  revision: number;
  pending: number;
  /** Bumped by a failure: positional writes queued before it are dropped,
   *  as their positions assumed it worked. */
  epoch: number;
}

const edits = new Map<string, PlaylistEdits>();
const listeners = new Set<() => void>();

function editsOf(uuid: string): PlaylistEdits {
  let e = edits.get(uuid);
  if (!e) {
    e = { chain: Promise.resolve(), revision: 0, pending: 0, epoch: 0 };
    edits.set(uuid, e);
  }
  return e;
}

function changed() {
  for (const l of listeners) l();
}

export function playlistRevision(uuid: string): number {
  return edits.get(uuid)?.revision ?? 0;
}

/** Whether a write to `uuid` is queued or in flight. */
export function playlistBusy(uuid: string): boolean {
  return (edits.get(uuid)?.pending ?? 0) > 0;
}

/** Resolves once no write to `uuid` is queued or in flight. */
export async function playlistSettled(uuid: string): Promise<void> {
  const e = edits.get(uuid);
  while (e && e.pending > 0) await e.chain;
}

/** Queue `send` behind the playlist's other writes. A `positional` write (a
 *  removal by index) is dropped, resolving false, when a write queued
 *  before it failed. A failure rejects and leaves the playlist at a new
 *  revision with its cached pages gone, since it may still have landed. */
export function queuePlaylistEdit(
  uuid: string,
  send: () => Promise<void>,
  opts: { positional?: boolean } = {},
): Promise<boolean> {
  const e = editsOf(uuid);
  const epoch = e.epoch;
  e.revision++;
  e.pending++;
  changed();
  const run = e.chain
    .then(async () => {
      if (opts.positional && epoch !== e.epoch) return false;
      try {
        await send();
        return true;
      } catch (err) {
        e.epoch++;
        e.revision++;
        invalidateCache(`playlist:${uuid}`);
        throw err;
      }
    })
    .finally(() => {
      e.pending--;
      changed();
    });
  e.chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `playlistBusy`, re-rendering when it changes. */
export function usePlaylistBusy(uuid: string): boolean {
  return useSyncExternalStore(subscribe, () => playlistBusy(uuid));
}

export function __resetPlaylistEditsForTests(): void {
  edits.clear();
}
