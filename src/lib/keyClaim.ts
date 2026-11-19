// Keys the TV interface consumes, so desktop shortcuts leave them alone.
const claimed = new WeakSet<Event>();

export function claimKey(e: Event): void {
  claimed.add(e);
}

export function isKeyClaimed(e: Event): boolean {
  return claimed.has(e);
}
