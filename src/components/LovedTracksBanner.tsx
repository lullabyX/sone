// Animated "Living Heart" backdrop for the Loved Tracks header. Three soft
// gradient blobs in the signature heart colors drift slowly behind the header,
// mirroring CoverBanner's overlay structure so it sits consistently with other pages.

export default function LovedTracksBanner() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
      <div className="loved-blob loved-blob-1">
        <div className="loved-blob-inner" />
      </div>
      <div className="loved-blob loved-blob-2">
        <div className="loved-blob-inner" />
      </div>
      <div className="loved-blob loved-blob-3">
        <div className="loved-blob-inner" />
      </div>
      {/* Base-tone overlay: keeps the title readable on light or dark themes. */}
      <div className="absolute inset-0 bg-th-base/60" />
      {/* Settle the right edge into the page tone, like CoverBanner. */}
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-th-base/20 to-th-base/60" />
      <div className="absolute inset-0 bg-gradient-to-b from-transparent from-70% to-th-surface" />
    </div>
  );
}
