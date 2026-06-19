// Animated "Living Heart" backdrop for the Loved Tracks header. Three blurred
// blobs in the signature heart colors drift slowly behind the header, mirroring
// CoverBanner's overlay structure so it sits consistently with the other pages.

const FADE = "linear-gradient(to bottom, #000 0%, #000 70%, transparent 100%)";

export default function LovedTracksBanner() {
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden select-none"
      style={{ maskImage: FADE, WebkitMaskImage: FADE }}
    >
      <div className="loved-blob loved-blob-1" />
      <div className="loved-blob loved-blob-2" />
      <div className="loved-blob loved-blob-3" />
      {/* Base-tone overlay: keeps the title readable on light or dark themes. */}
      <div className="absolute inset-0 bg-th-base/60" />
      {/* Settle the right edge into the page tone, like CoverBanner. */}
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-th-base/20 to-th-base/60" />
    </div>
  );
}
