import { Play, Heart } from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { usePlaylists } from "../hooks/usePlaylists";
import { useNavigation } from "../hooks/useNavigation";
import { useAuth } from "../hooks/useAuth";
import {
  getHomePage,
  refreshHomePage,
  getFavoriteArtists,
} from "../api/tidal";
import {
  getTidalImageUrl,
  type Playlist,
  type HomeSection as HomeSectionType,
  type ArtistDetail,
  type MediaItemType,
} from "../types";
import TidalImage from "./TidalImage";
import HomeSection from "./HomeSection";
import MediaContextMenu from "./MediaContextMenu";

export default function Home() {
  const { userPlaylists } = usePlaylists();
  const { navigateToPlaylist, navigateToFavorites } = useNavigation();
  const { authTokens } = useAuth();

  const [sections, setSections] = useState<HomeSectionType[]>([]);
  const [favoriteArtists, setFavoriteArtists] = useState<ArtistDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [greeting, setGreeting] = useState("Good evening");
  const hasLoadedRef = useRef(false);

  // Context menu state for quick-access playlist cards
  const [contextMenu, setContextMenu] = useState<{
    item: MediaItemType;
    position: { x: number; y: number };
  } | null>(null);

  const handlePlaylistContextMenu = useCallback(
    (e: React.MouseEvent, playlist: Playlist) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        item: {
          type: "playlist",
          uuid: playlist.uuid,
          title: playlist.title,
          image: playlist.image,
          creatorName: playlist.creator?.name || (playlist.creator?.id === 0 ? "TIDAL" : undefined),
        },
        position: { x: e.clientX, y: e.clientY },
      });
    },
    []
  );

  useEffect(() => {
    const hour = new Date().getHours();
    if (hour < 12) setGreeting("Good morning");
    else if (hour < 18) setGreeting("Good afternoon");
    else setGreeting("Good evening");
  }, []);

  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    const loadHomeData = async () => {
      try {
        // Load home page (cached or fresh)
        const result = await getHomePage();
        console.log(
          "[Home] Loaded sections:",
          result.home.sections.map((s) => `${s.sectionType}: "${s.title}" (${Array.isArray(s.items) ? s.items.length : 0} items)`),
          "isStale:", result.isStale
        );
        setSections(result.home.sections);

        // If cache is stale, refresh in background
        if (result.isStale) {
          refreshHomePage()
            .then((fresh) => {
              setSections(fresh.sections);
            })
            .catch((err) => {
              console.error("Background refresh failed:", err);
            });
        }
      } catch (err) {
        console.error("Failed to load home page:", err);
      }

      // Load favorite artists separately (not in /pages/home)
      try {
        const userId = authTokens?.user_id;
        if (userId != null) {
          const artists = await getFavoriteArtists(userId, 20);
          setFavoriteArtists(artists);
        }
      } catch (err) {
        console.error("Failed to load favorite artists:", err);
      }

      setLoading(false);
    };

    loadHomeData();
  }, [authTokens?.user_id]);

  const handleOpenPlaylist = (playlist: Playlist) => {
    navigateToPlaylist(playlist.uuid, {
      title: playlist.title,
      image: playlist.image,
      description: playlist.description,
      creatorName: playlist.creator?.name || (playlist.creator?.id === 0 ? "TIDAL" : undefined),
      numberOfTracks: playlist.numberOfTracks,
    });
  };

  // Build the favorite artists section as a HomeSection
  const favoriteArtistsSection: HomeSectionType | null =
    favoriteArtists.length > 0
      ? {
          title: "Your favorite artists",
          sectionType: "ARTIST_LIST",
          items: favoriteArtists.map((a) => ({
            id: a.id,
            name: a.name,
            picture: a.picture,
          })),
          hasMore: false,
          apiPath: undefined,
        }
      : null;

  if (loading) {
    return (
      <div className="flex-1 bg-gradient-to-b from-th-surface to-th-base min-h-full">
        <div className="px-6 py-8">
          {/* Skeleton greeting */}
          <div className="h-10 w-64 bg-th-surface-hover rounded-lg animate-pulse mb-6" />
          {/* Skeleton quick access */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 mb-10">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-[56px] bg-th-surface-hover/40 rounded-[4px] animate-pulse" />
            ))}
          </div>
          {/* Skeleton sections */}
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="mb-8">
              <div className="h-7 w-48 bg-th-surface-hover rounded animate-pulse mb-4" />
              <div className="flex gap-4">
                {Array.from({ length: 6 }).map((_, j) => (
                  <div key={j} className="flex-shrink-0 w-[180px]">
                    <div className="aspect-square bg-th-surface-hover rounded-md animate-pulse mb-2" />
                    <div className="h-4 w-32 bg-th-surface-hover rounded animate-pulse mb-1" />
                    <div className="h-3 w-24 bg-th-surface-hover rounded animate-pulse" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Insert favorite artists section after the first few sections
  const allSections = [...sections];
  if (favoriteArtistsSection) {
    // Try to insert it around position 6-8, or at the end if not enough sections
    const insertIdx = Math.min(7, allSections.length);
    allSections.splice(insertIdx, 0, favoriteArtistsSection);
  }

  return (
    <div className="flex-1 bg-gradient-to-b from-th-surface to-th-base min-h-full">
      <div className="px-6 py-8">
        {/* Quick Access Grid (Hero) */}
        <section className="mb-10">
          <h1 className="text-[32px] font-bold text-white mb-6 tracking-tight">
            {greeting}
          </h1>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {/* Loved Tracks - always first */}
            <div
              onClick={navigateToFavorites}
              className="flex items-center bg-th-inset/40 hover:bg-th-inset rounded-[4px] overflow-hidden cursor-pointer group transition-[background-color,box-shadow] duration-300 h-[56px] shadow-sm hover:shadow-md"
            >
              <div className="w-[56px] h-[56px] flex-shrink-0 bg-gradient-to-br from-[#450af5] via-[#8e2de2] to-[#00d2ff] shadow-lg flex items-center justify-center">
                <Heart size={22} className="text-white" fill="white" />
              </div>
              <div className="flex-1 flex items-center justify-between px-3 min-w-0">
                <span className="font-bold text-[13px] text-white truncate pr-2">
                  Loved Tracks
                </span>
                <div className="w-9 h-9 bg-th-accent rounded-full flex items-center justify-center shadow-xl opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-[opacity,transform] duration-300 scale-90 group-hover:scale-100 flex-shrink-0">
                  <Play size={18} fill="black" className="text-black ml-0.5" />
                </div>
              </div>
            </div>
            {userPlaylists.slice(0, 7).map((playlist) => (
              <div
                key={playlist.uuid}
                onClick={() => handleOpenPlaylist(playlist)}
                onContextMenu={(e) => handlePlaylistContextMenu(e, playlist)}
                className="flex items-center bg-th-inset/40 hover:bg-th-inset rounded-[4px] overflow-hidden cursor-pointer group transition-[background-color,box-shadow] duration-300 h-[56px] shadow-sm hover:shadow-md"
              >
                <div className="w-[56px] h-[56px] flex-shrink-0 bg-th-surface-hover shadow-lg">
                  <TidalImage
                    src={getTidalImageUrl(playlist.image, 160)}
                    alt={playlist.title}
                    type="playlist"
                    className="w-full h-full"
                  />
                </div>
                <div className="flex-1 flex items-center justify-between px-3 min-w-0">
                  <span className="font-bold text-[13px] text-white truncate pr-2">
                    {playlist.title}
                  </span>
                  <div className="w-9 h-9 bg-th-accent rounded-full flex items-center justify-center shadow-xl opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-[opacity,transform] duration-300 scale-90 group-hover:scale-100 flex-shrink-0">
                    <Play
                      size={18}
                      fill="black"
                      className="text-black ml-0.5"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Dynamic sections from /pages/home + favorite artists */}
        {allSections.map((section, idx) => (
          <HomeSection key={`${section.title}-${idx}`} section={section} />
        ))}
      </div>

      {/* Media context menu for quick-access cards */}
      {contextMenu && (
        <MediaContextMenu
          item={contextMenu.item}
          cursorPosition={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
