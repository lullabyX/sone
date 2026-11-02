/**
 * Tracks whether the OS window is in the foreground so purely decorative
 * animations can pause instead of drawing frames nobody sees.
 */
const listeners = new Set<(active: boolean) => void>();
let tracking = false;
let last: boolean | null = null;

export function isWindowActive(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function apply(): void {
  const active = isWindowActive();
  document.documentElement.classList.toggle("window-unfocused", !active);
  if (active === last) return;
  last = active;
  listeners.forEach((cb) => cb(active));
}

export function trackWindowFocus(): void {
  if (!tracking) {
    tracking = true;
    window.addEventListener("focus", apply);
    window.addEventListener("blur", apply);
    document.addEventListener("visibilitychange", apply);
  }
  apply();
}

export function onWindowActiveChange(
  cb: (active: boolean) => void,
): () => void {
  trackWindowFocus();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
