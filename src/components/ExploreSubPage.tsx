import { useState, useEffect } from "react";
import { getPageSection } from "../api/tidal";
import { useNavigation } from "../hooks/useNavigation";
import { getItemTitle, getItemId } from "../utils/itemHelpers";
import type { HomeSection as HomeSectionType } from "../types";
import HomeSection from "./HomeSection";
import { MediaGridSkeleton, MediaGridError, MediaGridEmpty } from "./MediaGrid";
import PageContainer from "./PageContainer";

interface ExploreSubPageProps {
  apiPath: string;
  title: string;
  onBack: () => void;
}

/** Detect whether a section contains navigation link items (genres/moods) vs media content. */
function isNavLinkSection(section: HomeSectionType): boolean {
  return (
    section.sectionType === "PAGE_LINKS_CLOUD" ||
    section.sectionType === "PAGE_LINKS" ||
    (Array.isArray(section.items) &&
      section.items.length > 0 &&
      section.items[0].apiPath !== undefined &&
      section.items[0].uuid === undefined &&
      section.items[0].id === undefined)
  );
}

export default function ExploreSubPage({
  apiPath,
  title,
}: ExploreSubPageProps) {
  const { navigateToExplorePage } = useNavigation();

  const [sections, setSections] = useState<HomeSectionType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    const loadPage = async () => {
      try {
        const result = await getPageSection(apiPath);
        if (!active) return;
        setSections(result.sections);
      } catch (err: any) {
        if (!active) return;
        console.error("Failed to load explore sub-page:", err);
        setError(err.toString());
      }
      if (active) setLoading(false);
    };

    loadPage();
    return () => {
      active = false;
    };
  }, [apiPath]);

  // Check if all sections are navigation links (i.e. this is a "view all" for genres/moods/decades)
  const allNav = sections.length > 0 && sections.every(isNavLinkSection);
  // Collect all nav link items for the simple text grid
  const navItems = allNav
    ? sections.flatMap((s) => (Array.isArray(s.items) ? s.items : []))
    : [];

  const handleNavItemClick = (item: any) => {
    if (item.apiPath) {
      navigateToExplorePage(item.apiPath, getItemTitle(item));
    }
  };

  return (
    <div className="flex-1 bg-gradient-to-b from-th-surface to-th-base min-h-full">
      <PageContainer className="px-6 py-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <h1 className="text-[32px] font-bold text-th-text-primary tracking-tight">
            {title}
          </h1>
        </div>

        {loading && <MediaGridSkeleton count={12} />}

        {error && <MediaGridError error={error} />}

        {!loading && !error && sections.length === 0 && (
          <MediaGridEmpty message="No content found" />
        )}

        {/* Simple text grid for nav-link pages (e.g. "All Genres") */}
        {!loading && !error && allNav && navItems.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-x-10 gap-y-6">
            {navItems.map((item: any) => (
              <button
                key={getItemId(item)}
                onClick={() => handleNavItemClick(item)}
                className="text-left text-[15px] font-medium text-th-text-secondary hover:text-th-text-primary transition-colors duration-150"
              >
                {getItemTitle(item)}
              </button>
            ))}
          </div>
        )}

        {/* Media sections for content pages (e.g. genre_pop with playlists/albums) */}
        {!loading && !error && !allNav && sections.length > 0 && (
          <div className="space-y-2">
            {sections.map((section, idx) => (
              <HomeSection key={section.title + idx} section={section} />
            ))}
          </div>
        )}
      </PageContainer>
    </div>
  );
}
