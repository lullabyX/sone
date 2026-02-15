/**
 * Skeleton loaders for various page types.
 * Used while data is being fetched to prevent layout shift and provide visual feedback.
 */

function Pulse({ className }: { className: string }) {
  return <div className={`animate-pulse bg-white/6 rounded ${className}`} />;
}

/** Skeleton for album / playlist / mix / radio pages with header + track list */
export function DetailPageSkeleton({ type = "album" }: { type?: "album" | "playlist" | "mix" | "radio" | "favorites" }) {
  return (
    <div className="flex-1 bg-linear-to-b from-th-surface to-th-base overflow-hidden">
      {/* Header area */}
      <div className="px-8 pb-8 pt-8 flex items-end gap-7">
        {/* Cover art skeleton */}
        <Pulse className="w-[232px] h-[232px] shrink-0 rounded-lg" />
        {/* Text skeleton */}
        <div className="flex flex-col gap-3 pb-2 flex-1 min-w-0">
          <Pulse className="w-16 h-3 rounded-full" />
          <Pulse className="w-[60%] h-10 rounded-lg" />
          {type !== "favorites" && <Pulse className="w-[40%] h-4 rounded-full" />}
          <Pulse className="w-24 h-3 rounded-full mt-1" />
        </div>
      </div>

      {/* Controls skeleton */}
      <div className="px-8 py-5 flex items-center gap-3">
        <Pulse className="w-24 h-10 rounded-full" />
        <Pulse className="w-28 h-10 rounded-full" />
      </div>

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
    </div>
  );
}
