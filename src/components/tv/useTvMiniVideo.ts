import { useEffect, useState, type RefObject } from "react";

/** The video player's dialog, while a video is loaded. */
function videoDialog(): HTMLElement | null {
  return (
    document
      .querySelector("[role='dialog'] video")
      ?.closest<HTMLElement>("[role='dialog']") ?? null
  );
}

/**
 * While `enabled`, lay the (minimized) video player over `slot`, so the video
 * keeps playing in Now Playing in place of the cover. The same <video>
 * element is only moved, never reloaded, so playback carries on seamlessly;
 * expanding it again just drops the placement.
 */
export function useTvMiniVideo(
  slot: RefObject<HTMLElement | null>,
  scroller: () => HTMLElement | null,
  enabled: boolean,
) {
  useEffect(() => {
    const dialog = videoDialog();
    const el = slot.current;
    if (!enabled || !dialog || !el) return;

    const place = () => {
      const r = el.getBoundingClientRect();
      dialog.style.setProperty("--tv-mini-x", `${r.left}px`);
      dialog.style.setProperty("--tv-mini-y", `${r.top}px`);
      dialog.style.setProperty("--tv-mini-w", `${r.width}px`);
      dialog.style.setProperty("--tv-mini-h", `${r.height}px`);
    };
    place();
    // An attribute, not a class: React rewrites the dialog's className on
    // every player re-render (e.g. when its controls fade out).
    dialog.setAttribute("data-tv-video", "");
    dialog.setAttribute("data-tv-video-mini", "");

    const resize = new ResizeObserver(place);
    resize.observe(el);
    const scrollEl = scroller();
    scrollEl?.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    return () => {
      dialog.removeAttribute("data-tv-video-mini");
      resize.disconnect();
      scrollEl?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [slot, scroller, enabled]);
}

/** The loaded video's width / height (16:9 until it is known), so the spot
 *  it plays in can match it instead of letterboxing a 4:3 or 21:9 video. */
export function useTvVideoAspect(active: boolean): number {
  const [aspect, setAspect] = useState(16 / 9);
  useEffect(() => {
    if (!active) return;
    const video = document.querySelector<HTMLVideoElement>(
      "[role='dialog'] video",
    );
    if (!video) return;
    const read = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        setAspect(video.videoWidth / video.videoHeight);
      }
    };
    read();
    // "resize" fires when the stream's frame size changes (a new video, or
    // another quality).
    video.addEventListener("loadedmetadata", read);
    video.addEventListener("resize", read);
    return () => {
      video.removeEventListener("loadedmetadata", read);
      video.removeEventListener("resize", read);
    };
  }, [active]);
  return aspect;
}
