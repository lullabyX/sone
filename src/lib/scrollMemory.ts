import type { AppView } from "../types";

/** Identifies this app run. `history.state` survives a reload but this module's
 *  Map does not, so entries stamped by an earlier run must be ignored rather
 *  than matched against a restarted id counter. */
export const NAV_SESSION = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const MAX_ENTRIES = 50;

const offsets = new Map<string, number>();
let counter = 0;

function stamp(view: AppView): AppView {
  return { ...view, __navSession: NAV_SESSION, __navId: ++counter };
}

export function scrollKey(view: AppView | null | undefined): string | null {
  if (!view || view.__navId === undefined) return null;
  if (view.__navSession !== NAV_SESSION) return null;
  const tab = (view as { tab?: unknown }).tab;
  return `${view.__navId}:${typeof tab === "string" ? tab : ""}`;
}

export function saveOffset(key: string, top: number): void {
  offsets.delete(key);
  offsets.set(key, top);
  if (offsets.size > MAX_ENTRIES) {
    const oldest = offsets.keys().next();
    if (!oldest.done) offsets.delete(oldest.value);
  }
}

export function getOffset(key: string): number | undefined {
  return offsets.get(key);
}

export function clearOffset(key: string): void {
  offsets.delete(key);
}

export function clearAllOffsets(): void {
  offsets.clear();
}

export function pushView(view: AppView): AppView {
  const stamped = stamp(view);
  const key = scrollKey(stamped);
  if (key) clearOffset(key);
  window.history.pushState(stamped, "");
  return stamped;
}

export function replaceView(view: AppView): AppView {
  const stamped = stamp(view);
  const key = scrollKey(stamped);
  if (key) clearOffset(key);
  window.history.replaceState(stamped, "");
  return stamped;
}
