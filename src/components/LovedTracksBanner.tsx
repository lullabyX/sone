// Animated "Living Heart" backdrop for the Loved Tracks header. Three soft
// gradient blobs in the signature heart colors drift slowly behind the header,
// mirroring CoverBanner's overlay structure so it sits consistently with other pages.

import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { drawerOpenAtom } from "../atoms/ui";
import { currentTrackAtom } from "../atoms/playback";

/** False once the banner is scrolled fully out of view. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setOnScreen(entry.isIntersecting);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return onScreen;
}

export default function LovedTracksBanner() {
  const rootRef = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(rootRef);
  // The Now Playing drawer covers the whole content area when open, but it
  // renders nothing without a current track, while the player bar's Lyrics
  // and Queue buttons can still set the flag.
  const drawerOpen = useAtomValue(drawerOpenAtom);
  const hasTrack = useAtomValue(currentTrackAtom) !== null;
  const covered = drawerOpen && hasTrack;
  // Window focus and software rendering pause the blobs from <html> (App.css).
  const paused = covered || !onScreen;

  return (
    <div
      ref={rootRef}
      className={`pointer-events-none absolute inset-0 overflow-hidden select-none${
        paused ? " loved-banner-paused" : ""
      }`}
    >
      <div className="loved-blob loved-blob-1">
        <div className="loved-blob-inner" />
      </div>
      <div className="loved-blob loved-blob-2">
        <div className="loved-blob-inner" />
      </div>
      <div className="loved-blob loved-blob-3">
        <div className="loved-blob-inner" />
      </div>
      {/* Base-tone overlay, darkening toward the right edge like CoverBanner:
          keeps the title readable on light or dark themes. One layer instead
          of a flat 60% fill under a transparent-to-60% ramp: both are the base
          color, so 60% + 40% x (0%, 20%, 60%) composites to exactly
          (60%, 68%, 84%). The /srgb interpolation renders the same pixels for a
          single-color alpha ramp, and the default (oklab) one costs WebKitGTK
          several times more to rasterize each time this area repaints. */}
      <div className="absolute inset-0 bg-linear-to-r/srgb from-th-base/60 via-th-base/68 to-th-base/84" />
      <div className="absolute inset-0 bg-linear-to-b/srgb from-transparent from-70% to-th-surface" />
    </div>
  );
}
