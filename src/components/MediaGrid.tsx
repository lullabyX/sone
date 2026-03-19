import { ReactNode } from "react";

interface MediaGridProps {
  children: ReactNode;
}

/** Responsive grid container for media cards. */
export default function MediaGrid({ children }: MediaGridProps) {
  return (
    <div className="@container">
      <div className="grid grid-cols-1 @sm:grid-cols-2 @lg:grid-cols-3 @3xl:grid-cols-4 @5xl:grid-cols-5 @7xl:grid-cols-6 gap-5">
        {children}
      </div>
    </div>
  );
}

/** Loading skeleton for the media grid. */
export function MediaGridSkeleton({ count = 18 }: { count?: number }) {
  return (
    <MediaGrid>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="p-3">
          <div className="aspect-square bg-th-surface-hover rounded-md animate-pulse mb-2" />
          <div className="h-4 w-3/4 bg-th-surface-hover rounded animate-pulse mb-1" />
          <div className="h-3 w-1/2 bg-th-surface-hover rounded animate-pulse" />
        </div>
      ))}
    </MediaGrid>
  );
}

/** Empty state for the media grid. */
export function MediaGridEmpty({
  message = "No items found",
}: {
  message?: string;
}) {
  return (
    <div className="text-center py-12">
      <p className="text-th-text-muted text-sm">{message}</p>
    </div>
  );
}

/** Error state for the media grid. */
export function MediaGridError({ error }: { error: string }) {
  return (
    <div className="text-center py-12">
      <p className="text-th-text-muted text-sm">Failed to load content</p>
      <p className="text-th-text-faint text-xs mt-1">{error}</p>
    </div>
  );
}
