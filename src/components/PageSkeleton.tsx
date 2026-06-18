/**
 * Skeleton loaders for various page types.
 * Used while data is being fetched to prevent layout shift and provide visual feedback.
 */

import PageContainer from "./PageContainer";

function Pulse({ className }: { className: string }) {
  return <div className={`animate-pulse bg-th-hl-med rounded ${className}`} />;
}

/** Skeleton for artist pages — tall hero banner, title/fans/bio + controls, tracks, discography */
export function ArtistPageSkeleton() {
  return (
    <div className="flex-1 bg-linear-to-b from-th-surface to-th-base overflow-hidden">
      {/* Hero banner — full-bleed, content anchored bottom-left */}
      <div className="relative w-full h-[480px] overflow-hidden flex items-end mb-8">
        <div className="absolute inset-0 animate-pulse bg-th-hl-faint" />
        <PageContainer className="relative z-10 w-full">
          <div className="px-8 pb-6">
            {/* Title + fans + bio */}
            <div className="max-w-[820px]">
              <Pulse className="w-[45%] h-14 rounded-lg" />
              <Pulse className="w-24 h-4 rounded-full mt-4" />
              <Pulse className="w-[60%] h-4 rounded-full mt-4" />
              <Pulse className="w-28 h-3.5 rounded-full mt-3" />
            </div>
            {/* Controls: Play + Shuffle, then 4 icon actions */}
            <div className="mt-6 flex items-end justify-between gap-6">
              <div className="flex items-center gap-3">
                <Pulse className="w-32 h-12 rounded-full!" />
                <Pulse className="w-36 h-12 rounded-full!" />
              </div>
              <div className="flex items-end gap-7">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex flex-col items-center gap-2">
                    <Pulse className="w-6 h-6" />
                    <Pulse className="w-12 h-2.5 rounded-full" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </PageContainer>
      </div>

      <PageContainer>
        {/* Top Tracks */}
        <div className="px-8 pb-6">
          <div className="flex items-center justify-between mb-4">
            <Pulse className="w-40 h-6 rounded-lg" />
            <Pulse className="w-16 h-3.5 rounded-full" />
          </div>
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="grid grid-cols-[36px_1fr_minmax(140px,1fr)_72px] gap-4 px-4 py-2.5"
            >
              <div className="flex items-center justify-end">
                <Pulse className="w-5 h-4 rounded" />
              </div>
              <div className="flex items-center gap-3">
                <Pulse className="w-10 h-10 shrink-0 rounded" />
                <Pulse className="w-[55%] h-3.5 rounded" />
              </div>
              <div className="flex items-center">
                <Pulse className="w-[45%] h-3 rounded" />
              </div>
              <div className="flex items-center justify-end">
                <Pulse className="w-10 h-3 rounded" />
              </div>
            </div>
          ))}
        </div>

        {/* Discography */}
        <div className="px-8 pb-8">
          <Pulse className="w-36 h-6 rounded-lg mb-4" />
          <div className="card-scroll">
            <div className="card-scroll-track">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="card-scroll-item p-3">
                  <Pulse className="w-full aspect-square rounded-md mb-3" />
                  <Pulse className="w-[75%] h-3.5 rounded mb-2" />
                  <Pulse className="w-[50%] h-3 rounded" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </PageContainer>
    </div>
  );
}

/** Skeleton for the search results page — tab bar + tracks section + grid cards */
export function SearchPageSkeleton() {
  return (
    <div className="flex-1 bg-linear-to-b from-th-surface to-th-base min-h-full">
      <PageContainer className="px-6 py-6">
        {/* Tab pills */}
        <div className="pb-6 flex items-center gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Pulse
              key={i}
              className={`h-8 rounded-full ${i === 0 ? "w-24" : "w-20"}`}
            />
          ))}
        </div>

        {/* Tracks section */}
        <div className="mb-8">
          <Pulse className="w-20 h-5 rounded-lg mb-3" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-3 py-2.5">
              <Pulse className="w-5 h-4 rounded" />
              <Pulse className="w-10 h-10 rounded" />
              <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                <Pulse className="w-[40%] h-3.5 rounded" />
                <Pulse className="w-[22%] h-3 rounded" />
              </div>
              <Pulse className="w-[15%] h-3 rounded hidden md:block" />
              <Pulse className="w-10 h-3 rounded" />
            </div>
          ))}
        </div>

        {/* Albums / Playlists grid section */}
        <div className="mb-8">
          <Pulse className="w-24 h-5 rounded-lg mb-3" />
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="p-3">
                <Pulse className="w-full aspect-square rounded-md mb-3" />
                <Pulse className="w-[70%] h-3.5 rounded mb-2" />
                <Pulse className="w-[50%] h-3 rounded" />
              </div>
            ))}
          </div>
        </div>

        {/* Artists grid section */}
        <div>
          <Pulse className="w-20 h-5 rounded-lg mb-3" />
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="p-3 flex flex-col items-center">
                <Pulse className="w-full aspect-square rounded-full! mb-3" />
                <Pulse className="w-[60%] h-3.5 rounded mb-2" />
                <Pulse className="w-[30%] h-3 rounded" />
              </div>
            ))}
          </div>
        </div>
      </PageContainer>
    </div>
  );
}

/** Skeleton for album / playlist / mix / radio pages with header + track list */
export function DetailPageSkeleton({
  type = "album",
}: {
  type?: "album" | "playlist" | "mix" | "radio" | "favorites";
}) {
  const showControls = type !== "favorites";
  const showFilter = type === "playlist" || type === "favorites";

  return (
    <div className="flex-1 bg-linear-to-b from-th-surface to-th-base overflow-hidden">
      <PageContainer>
        {/* Header area */}
        <div className="px-8 pb-8 pt-8 flex items-end gap-7">
          {/* Cover art skeleton */}
          <Pulse className="w-[232px] h-[232px] shrink-0 rounded-lg" />
          {/* Text skeleton */}
          {type === "album" ||
          type === "playlist" ||
          type === "mix" ||
          type === "radio" ? (
            <div className="flex flex-col gap-2 pb-2 flex-1 min-w-0">
              <Pulse className="w-16 h-3 rounded-full" />
              <Pulse className="w-[55%] h-9 rounded-lg" />
              {type === "album" ? (
                <div className="flex items-center gap-2 mt-2">
                  <Pulse className="w-6 h-6 rounded-full!" />
                  <Pulse className="w-32 h-3.5 rounded-full" />
                </div>
              ) : (
                <Pulse className="w-28 h-3.5 rounded-full mt-2" />
              )}
              {type === "playlist" && (
                <Pulse className="w-[60%] h-3.5 rounded-full" />
              )}
              <Pulse className="w-40 h-3 rounded-full" />
              {type === "album" && (
                <div className="flex items-center gap-2">
                  <Pulse className="w-10 h-3 rounded-full" />
                  <Pulse className="w-16 h-4 rounded" />
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 pb-2 flex-1 min-w-0">
              <Pulse className="w-16 h-3 rounded-full" />
              <Pulse className="w-[60%] h-10 rounded-lg" />
              <Pulse className="w-24 h-3 rounded-full mt-1" />
            </div>
          )}
        </div>

        {/* Controls skeleton — Play + Shuffle left, action cluster right */}
        {showControls && (
          <div className="px-8 py-5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Pulse className="w-24 h-10 rounded-full!" />
              <Pulse className="w-28 h-10 rounded-full!" />
            </div>
            {(type === "album" ||
              type === "playlist" ||
              type === "mix" ||
              type === "radio") && (
              <div className="flex items-end gap-6">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex flex-col items-center gap-1.5">
                    <Pulse className="w-[22px] h-[22px] rounded" />
                    <Pulse className="w-9 h-2.5 rounded-full" />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Filter bar skeleton */}
        {showFilter && (
          <div className="px-8 pb-4">
            <Pulse className="w-full h-9 rounded-md" />
          </div>
        )}

        {/* Track list skeleton */}
        <div className="px-8 pb-8">
          {/* Column header */}
          <div className="flex items-center gap-4 px-3 py-2 mb-2">
            <Pulse className="w-6 h-3 rounded" />
            <Pulse className="w-[30%] h-3 rounded" />
            <div className="flex-1" />
            <Pulse className="w-[15%] h-3 rounded hidden md:block" />
            <Pulse className="w-10 h-3 rounded" />
          </div>
          {/* Track rows */}
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-3 py-2.5">
              <Pulse className="w-5 h-4 rounded" />
              <Pulse className="w-10 h-10 rounded" />
              <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                <Pulse className="w-[45%] h-3.5 rounded" />
                <Pulse className="w-[25%] h-3 rounded" />
              </div>
              <Pulse className="w-[18%] h-3 rounded hidden md:block" />
              <Pulse className="w-10 h-3 rounded" />
            </div>
          ))}
        </div>
      </PageContainer>
    </div>
  );
}
