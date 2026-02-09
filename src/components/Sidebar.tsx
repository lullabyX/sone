import { Home, Compass, Search, Plus, Library, Heart } from "lucide-react";
import { useAudioContext } from "../contexts/AudioContext";
import { getTidalImageUrl } from "../hooks/useAudio";
import TidalImage from "./TidalImage";
import { useState } from "react";

export default function Sidebar() {
  const {
    userPlaylists,
    getPlaylistTracks,
    playTrack,
    navigateToFavorites,
    navigateHome,
    currentView,
  } = useAudioContext();
  const [isCollapsed, setIsCollapsed] = useState(false);

  const handlePlaylistClick = async (playlistId: string) => {
    try {
      const tracks = await getPlaylistTracks(playlistId);
      if (tracks.length > 0) {
        playTrack(tracks[0]);
      }
    } catch (err) {
      console.error("Failed to play playlist:", err);
    }
  };

  return (
    <div
      className={`sidebar h-full bg-[#0b0b0b] flex flex-col border-r border-white/[0.06] transition-all duration-300 ease-in-out flex-shrink-0 ${
        isCollapsed ? "w-[60px]" : "w-[240px] min-w-[200px] max-w-[300px]"
      }`}
    >
      {/* Navigation */}
      <nav className="px-2 pt-3 pb-1 space-y-0.5">
        <button
          onClick={navigateHome}
          className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-md transition-all duration-150 group ${
            currentView.type === "home"
              ? "text-white bg-white/[0.08]"
              : "text-[#b3b3b3] hover:text-white hover:bg-white/[0.06]"
          } ${isCollapsed ? "justify-center px-0" : ""}`}
          title="Home"
        >
          <Home size={20} strokeWidth={2} />
          {!isCollapsed && <span className="font-semibold text-sm">Home</span>}
        </button>
        <a
          href="#"
          className={`flex items-center gap-3 px-2.5 py-2 text-[#b3b3b3] hover:text-white hover:bg-white/[0.06] rounded-md transition-all duration-150 group ${
            isCollapsed ? "justify-center px-0" : ""
          }`}
          title="Explore"
        >
          <Compass size={20} strokeWidth={2} />
          {!isCollapsed && (
            <span className="font-semibold text-sm">Explore</span>
          )}
        </a>
        <a
          href="#"
          className={`flex items-center gap-3 px-2.5 py-2 text-[#b3b3b3] hover:text-white hover:bg-white/[0.06] rounded-md transition-all duration-150 group ${
            isCollapsed ? "justify-center px-0" : ""
          }`}
          title="Search"
        >
          <Search size={20} strokeWidth={2} />
          {!isCollapsed && (
            <span className="font-semibold text-sm">Search</span>
          )}
        </a>
      </nav>

      {/* Library Header */}
      <div className="flex-1 flex flex-col min-h-0 mt-1">
        <div
          className={`px-2 py-1.5 flex items-center ${
            isCollapsed ? "justify-center" : "justify-between"
          }`}
        >
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className={`flex items-center gap-2 text-[#b3b3b3] hover:text-white transition-colors duration-150 group ${
              isCollapsed ? "justify-center w-full" : ""
            }`}
          >
            <Library size={20} />
            {!isCollapsed && (
              <span className="font-semibold text-sm">Your Library</span>
            )}
          </button>

          {!isCollapsed && (
            <button className="text-[#b3b3b3] hover:text-white p-1 rounded-full hover:bg-white/[0.08] transition-colors duration-150">
              <Plus size={16} />
            </button>
          )}
        </div>

        {/* Filter Pills */}
        {!isCollapsed && (
          <div className="px-2 pb-2 flex gap-1.5 overflow-x-auto no-scrollbar">
            {["Playlists", "Artists", "Albums"].map((pill) => (
              <button
                key={pill}
                className="px-2.5 py-1 bg-white/[0.07] hover:bg-white/[0.12] rounded-full text-xs font-medium text-[#e0e0e0] whitespace-nowrap transition-colors duration-150"
              >
                {pill}
              </button>
            ))}
          </div>
        )}

        {/* Playlists List */}
        <div className="flex-1 overflow-y-auto px-1.5 pb-2 custom-scrollbar">
          {userPlaylists.length === 0 ? (
            <div
              className={`px-3 py-8 text-center ${isCollapsed ? "hidden" : ""}`}
            >
              <p className="text-[#a6a6a6] text-sm">
                Create your first playlist
              </p>
              <button className="mt-4 px-4 py-2 bg-white text-black rounded-full text-sm font-bold hover:scale-105 transition-transform">
                Create playlist
              </button>
            </div>
          ) : (
            <div className="space-y-px">
              {/* Loved Tracks - pinned at top */}
              <button
                onClick={navigateToFavorites}
                className={`w-full flex items-center gap-2.5 px-1.5 py-1.5 rounded-md transition-all duration-150 group ${
                  currentView.type === "favorites"
                    ? "bg-white/[0.08]"
                    : "hover:bg-white/[0.06]"
                } ${isCollapsed ? "justify-center" : ""}`}
                title="Loved Tracks"
              >
                <div
                  className={`flex-shrink-0 overflow-hidden flex items-center justify-center bg-gradient-to-br from-[#450af5] via-[#8e2de2] to-[#00d2ff] ${
                    isCollapsed ? "w-9 h-9 rounded" : "w-9 h-9 rounded"
                  }`}
                >
                  <Heart size={14} className="text-white" fill="white" />
                </div>

                {!isCollapsed && (
                  <div className="flex-1 min-w-0 text-left">
                    <div className="text-[13px] font-medium text-white truncate leading-tight">
                      Loved Tracks
                    </div>
                    <div className="text-[11px] text-[#808080] truncate leading-tight mt-0.5">
                      Collection
                    </div>
                  </div>
                )}
              </button>

              {userPlaylists.map((playlist) => (
                <button
                  key={playlist.uuid}
                  onClick={() => handlePlaylistClick(playlist.uuid)}
                  className={`w-full flex items-center gap-2.5 px-1.5 py-1.5 rounded-md transition-all duration-150 group hover:bg-white/[0.06] ${
                    isCollapsed ? "justify-center" : ""
                  }`}
                  title={playlist.title}
                >
                  <div
                    className={`bg-[#282828] flex-shrink-0 overflow-hidden rounded ${
                      isCollapsed ? "w-9 h-9" : "w-9 h-9"
                    }`}
                  >
                    <TidalImage
                      src={getTidalImageUrl(playlist.image, 80)}
                      alt={playlist.title}
                      type="playlist"
                    />
                  </div>

                  {!isCollapsed && (
                    <div className="flex-1 min-w-0 text-left">
                      <div className="text-[13px] font-medium text-white truncate leading-tight">
                        {playlist.title}
                      </div>
                      <div className="text-[11px] text-[#808080] truncate leading-tight mt-0.5">
                        <span>Playlist</span>
                        <span className="mx-0.5">·</span>
                        <span>{playlist.creator?.name || "You"}</span>
                      </div>
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
