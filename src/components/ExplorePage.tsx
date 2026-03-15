import { useState, useEffect, useRef } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  Trophy,
  PlaySquare,
  BarChart2,
  ShieldCheck,
  Star,
  Users,
  Music,
} from "lucide-react";
import { useNavigation } from "../hooks/useNavigation";
import { getPageSection } from "../api/tidal";
import { getItemTitle, getItemId } from "../utils/itemHelpers";
import type { HomeSection } from "../types";
import { MediaGridError, MediaGridEmpty } from "./MediaGrid";
import PageContainer from "./PageContainer";

/** Check if items in a section have icons (bottom shortcut items like New, Top, Videos). */
function hasIcons(section: HomeSection): boolean {
  return (
    Array.isArray(section.items) &&
    section.items.length > 0 &&
    section.items.some((item: any) => item.icon)
  );
}

/** Check if a section has displayable items. */
function hasItems(section: HomeSection): boolean {
  return Array.isArray(section.items) && section.items.length > 0;
}

const ICON_MAP: Record<string, any> = {
  New: Calendar,
  Top: Trophy,
  Videos: PlaySquare,
  HiRes: BarChart2,
  "Clean Content": ShieldCheck,
  "Staff Picks": Star,
  "Creator Hub": Users,
};

export default function ExplorePage() {
  const { navigateToExplorePage } = useNavigation();

  const [sections, setSections] = useState<HomeSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    const loadExplore = async () => {
      try {
        const result = await getPageSection("pages/explore");
        if (!active) return;
        setSections(result.sections || []);
      } catch (err: any) {
        console.error("[ExplorePage] Failed:", err);
        if (!active) return;
        setError(err.toString());
      }
      if (active) setLoading(false);
    };

    loadExplore();
    return () => {
      active = false;
    };
  }, []);

  const handleItemClick = (item: any) => {
    const apiPath = item.apiPath;
    const title = getItemTitle(item);
    if (apiPath) {
      navigateToExplorePage(apiPath, title);
    }
  };

  const handleViewAll = (section: HomeSection) => {
    if (section.apiPath) {
      navigateToExplorePage(section.apiPath, section.title);
    }
  };

  // Split sections: titled pill sections vs icon shortcut section at the bottom
  const pillSections = sections.filter(
    (s) => hasItems(s) && s.title && s.sectionType === "PAGE_LINKS_CLOUD",
  );

  // console.log("pillSections", pillSections);
  const iconSection = sections.find(
    (s) => hasItems(s) && s.sectionType === "PAGE_LINKS",
  );
  console.log("iconSection", iconSection);

  return (
    <div className="flex-1 bg-gradient-to-b from-th-surface to-th-base min-h-full">
      <PageContainer className="px-8 py-10">
        {/* Header */}
        <h1 className="text-[32px] font-bold text-th-text-primary tracking-tight mb-10">
          Explore
        </h1>

        {loading && <ExploreSkeleton />}

        {error && <MediaGridError error={error} />}

        {!loading && !error && sections.length === 0 && (
          <MediaGridEmpty message="No categories found" />
        )}

        {!loading && !error && sections.length > 0 && (
          <div className="space-y-10">
            {/* Pill sections (Genres, Moods, Decades) */}
            {pillSections.map((section) => (
              <PillSection
                key={section.title}
                section={section}
                onItemClick={handleItemClick}
                onViewAll={() => handleViewAll(section)}
              />
            ))}

            {/* Icon shortcuts (New, Top, Videos, HiRes, etc.) */}
            {iconSection && (
              <IconGrid
                items={iconSection.items}
                onItemClick={handleItemClick}
              />
            )}

            {/* Sections without titles but with items (rendered as pills too) */}
            {sections
              .filter((s) => hasItems(s) && !s.title && !hasIcons(s))
              .map((section, idx) => (
                <PillSection
                  key={"untitled-" + idx}
                  section={section}
                  onItemClick={handleItemClick}
                  onViewAll={() => handleViewAll(section)}
                />
              ))}
          </div>
        )}
      </PageContainer>
    </div>
  );
}

// ---- Sub-components ----

function PillSection({
  section,
  onItemClick,
  onViewAll,
}: {
  section: HomeSection;
  onItemClick: (item: any) => void;
  onViewAll: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  const items = Array.isArray(section.items) ? section.items : [];
  if (items.length === 0) return null;

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 10);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 10);
  };

  const scroll = (direction: "left" | "right") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({
      left: direction === "left" ? -el.clientWidth * 0.8 : el.clientWidth * 0.8,
      behavior: "smooth",
    });
  };

  return (
    <section>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[20px] font-bold text-th-text-primary tracking-tight">
          {section.title}
        </h2>
        <div className="flex items-center gap-2">
          {section.apiPath && (
            <button
              onClick={onViewAll}
              className="text-[14px] font-semibold text-th-text-muted hover:text-th-text-primary transition-colors mr-2"
            >
              View all
            </button>
          )}
          <button
            onClick={() => scroll("left")}
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
              canScrollLeft
                ? "bg-th-inset hover:bg-th-inset-hover text-th-text-primary"
                : "text-th-text-disabled cursor-default opacity-0"
            }`}
            disabled={!canScrollLeft}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            onClick={() => scroll("right")}
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
              canScrollRight
                ? "bg-th-inset hover:bg-th-inset-hover text-th-text-primary"
                : "text-th-text-disabled cursor-default opacity-0"
            }`}
            disabled={!canScrollRight}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      {/* Horizontal pill row */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex gap-3 overflow-x-auto no-scrollbar scroll-smooth pb-1"
      >
        {items.map((item: any) => (
          <button
            key={getItemId(item)}
            onClick={() => onItemClick(item)}
            className="shrink-0 px-6 py-3 bg-th-inset hover:bg-th-inset-hover rounded-lg text-[15px] font-medium text-th-text-primary whitespace-nowrap transition-colors duration-150"
          >
            {getItemTitle(item)}
          </button>
        ))}
      </div>
    </section>
  );
}

function IconGrid({
  items,
  onItemClick,
}: {
  items: any[];
  onItemClick: (item: any) => void;
}) {
  if (!items || items.length === 0) return null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-x-12 gap-y-6 pt-6">
      {items.map((item: any) => {
        const title = getItemTitle(item);
        const Icon = ICON_MAP[title] || (item.icon ? null : Music);

        return (
          <button
            key={getItemId(item)}
            onClick={() => onItemClick(item)}
            className="flex items-center gap-4 text-left group"
          >
            {Icon ? (
              <Icon className="w-6 h-6 text-th-text-muted group-hover:text-th-text-primary transition-colors" />
            ) : (
              item.icon && (
                <img
                  src={item.icon}
                  alt=""
                  className="w-6 h-6 opacity-70 group-hover:opacity-100 transition-opacity"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              )
            )}
            <span className="text-[16px] font-medium text-th-text-muted group-hover:text-th-text-primary transition-colors">
              {title}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ExploreSkeleton() {
  return (
    <div className="space-y-10">
      {[1, 2, 3].map((i) => (
        <div key={i}>
          <div className="h-7 w-32 bg-th-surface-hover rounded animate-pulse mb-4" />
          <div className="flex gap-3">
            {Array.from({ length: 8 }).map((_, j) => (
              <div
                key={j}
                className="h-11 w-32 bg-th-surface-hover rounded-lg animate-pulse shrink-0"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
