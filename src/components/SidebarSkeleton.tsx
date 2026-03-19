export default function SidebarSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="space-y-px">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-2.5 px-1.5 py-2">
          <div className="w-10 h-10 rounded bg-th-hl-med animate-pulse shrink-0" />
          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="h-3.5 bg-th-hl-med rounded animate-pulse w-3/4" />
            <div className="h-3 bg-th-hl-med rounded animate-pulse w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}
