/**
 * Flags the document while the OS window is in the background so purely
 * decorative animations can pause instead of compositing frames nobody sees.
 */
export function trackWindowFocus(): void {
  const apply = () => {
    const active =
      document.visibilityState === "visible" && document.hasFocus();
    document.documentElement.classList.toggle("window-unfocused", !active);
  };

  window.addEventListener("focus", apply);
  window.addEventListener("blur", apply);
  document.addEventListener("visibilitychange", apply);
  apply();
}
