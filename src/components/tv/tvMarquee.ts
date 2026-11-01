/** How far a cut-off title scrolls to show its end (negative px), or null
 *  when it fits (a couple of px of rounding is not worth a scroll). */
export function marqueeShift(
  scrollWidth: number,
  clientWidth: number,
): number | null {
  return scrollWidth - clientWidth > 2 ? clientWidth - scrollWidth : null;
}

/** Measures each `.tv-marquee` title under `root` and arms the cut-off ones
 *  to scroll while focused (tv.css). The outer block box is measured: its
 *  inline text span has no layout box of its own. */
export function armMarquee(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(".tv-marquee").forEach((el) => {
    const shift = marqueeShift(el.scrollWidth, el.clientWidth);
    if (shift === null) {
      el.style.removeProperty("--tv-marquee-shift");
      el.style.removeProperty("--tv-marquee-duration");
      delete el.dataset.overflow;
      return;
    }
    el.style.setProperty("--tv-marquee-shift", `${shift}px`);
    el.style.setProperty(
      "--tv-marquee-duration",
      `${Math.max(4, Math.abs(shift) / 40)}s`,
    );
    el.dataset.overflow = "";
  });
}
