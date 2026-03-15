import { useState, useRef, useEffect } from "react";
import { ArrowUpDown } from "lucide-react";
import { SORT_OPTIONS } from "../constants/sortOptions";
import type { SortOrder } from "../atoms/favorites";

interface SortDropdownProps {
  libraryType: "playlists" | "albums" | "artists" | "mixes";
  currentSort: SortOrder;
  onSortChange: (sort: SortOrder) => void;
  compact?: boolean;
}

export default function SortDropdown({
  libraryType,
  currentSort,
  onSortChange,
  compact = false,
}: SortDropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const options = SORT_OPTIONS[libraryType];
  const currentLabel =
    options.find((o) => o.value === currentSort.order)?.label ?? "Date added";

  const handleSelect = (order: string) => {
    if (currentSort.order === order) {
      onSortChange({
        order,
        direction: currentSort.direction === "DESC" ? "ASC" : "DESC",
      });
    } else {
      onSortChange({ order, direction: order === "NAME" ? "ASC" : "DESC" });
    }
    setOpen(false);
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen(!open)}
        className={
          compact
            ? "text-th-text-muted hover:text-th-text-primary transition-colors p-1"
            : "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-th-text-muted hover:text-th-text-primary hover:bg-th-border-subtle transition-colors"
        }
        title={`Sort by: ${currentLabel}`}
      >
        <ArrowUpDown size={compact ? 14 : 13} />
        {!compact && (
          <>
            <span>{currentLabel}</span>
            <span className="text-[10px]">
              {currentSort.direction === "ASC" ? "\u2191" : "\u2193"}
            </span>
          </>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-th-surface border border-th-border-subtle rounded-md shadow-lg py-1 min-w-[140px]">
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleSelect(opt.value)}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-th-border-subtle transition-colors ${
                currentSort.order === opt.value
                  ? "text-th-accent"
                  : "text-th-text-secondary"
              }`}
            >
              {opt.label}
              {currentSort.order === opt.value && (
                <span className="ml-1 text-[10px]">
                  {currentSort.direction === "ASC" ? "\u2191" : "\u2193"}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
