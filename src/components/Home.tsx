import { Play, ChevronLeft, ChevronRight, Bell, Heart } from "lucide-react";
import { useState, useEffect } from "react";
import { useAudioContext } from "../contexts/AudioContext";
import { getTidalImageUrl, type Track } from "../hooks/useAudio";
import TidalImage from "./TidalImage";

export default function Home() {
  const {
    getPlaylistTracks,
    playTrack,
    setQueueTracks,
    userPlaylists,
    authTokens,
    navigateToAlbum,
    navigateToFavorites,
  } = useAudioContext();
  const [featuredTracks, setFeaturedTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [greeting, setGreeting] = useState("Good evening");

  useEffect(() => {
    const hour = new Date().getHours();
    if (hour < 12) setGreeting("Good morning");
    else if (hour < 18) setGreeting("Good afternoon");
    else setGreeting("Good evening");

    const loadFeatured = async () => {
      if (userPlaylists.length > 0) {
        try {
          const tracks = await getPlaylistTracks(userPlaylists[0].uuid);
          setFeaturedTracks(tracks.slice(0, 8));
        } catch (err) {
          console.error("Failed to load tracks:", err);
        }
      }
      setLoading(false);
    };
    loadFeatured();
  }, [userPlaylists, getPlaylistTracks]);

  const handlePlayTrack = async (track: Track) => {
    try {
      await playTrack(track);
    } catch (err) {
      console.error("Failed to play:", err);
    }
  };

  const handlePlaylistPlay = async (playlistId: string) => {
    try {
      const tracks = await getPlaylistTracks(playlistId);
      if (tracks.length > 0) {
        setQueueTracks(tracks.slice(1));
        await playTrack(tracks[0]);
      }
    } catch (err) {
      console.error("Failed to play:", err);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-[#121212]">
        <div className="w-10 h-10 border-2 border-[#00FFFF] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex-1 bg-gradient-to-b from-[#1a1a1a] to-[#121212] overflow-y-auto scrollbar-thin scrollbar-thumb-[#333] scrollbar-track-transparent">
      {/* Top Bar */}
      <div className="sticky top-0 z-20 px-6 py-4 flex items-center justify-between bg-[#121212]/50 backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <button className="w-8 h-8 rounded-full bg-black/40 flex items-center justify-center text-[#a6a6a6] hover:text-white transition-colors disabled:opacity-50">
            <ChevronLeft size={20} />
          </button>
          <button className="w-8 h-8 rounded-full bg-black/40 flex items-center justify-center text-[#a6a6a6] hover:text-white transition-colors disabled:opacity-50">
            <ChevronRight size={20} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button className="px-4 py-1.5 bg-white text-black text-[14px] font-bold rounded-full hover:scale-105 transition-transform">
            Explore Premium
          </button>
          <button className="w-8 h-8 rounded-full bg-black/40 flex items-center justify-center text-[#a6a6a6] hover:text-white hover:scale-105 transition-all">
            <Bell size={18} />
          </button>
          <button className="w-8 h-8 rounded-full bg-black/40 flex items-center justify-center text-[#a6a6a6] hover:text-white hover:scale-105 transition-all p-1">
            <div className="w-full h-full bg-[#535353] rounded-full flex items-center justify-center">
              <span className="text-[10px] font-bold text-black">
                {authTokens?.user_id?.toString().charAt(0) || "U"}
              </span>
            </div>
          </button>
        </div>
      </div>

      <div className="px-6 pb-8">
        {/* Quick Access Grid (Hero) */}
        <section className="mb-10">
          <h1 className="text-[32px] font-bold text-white mb-6 tracking-tight">
            {greeting}
          </h1>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {/* Loved Tracks - always first */}
            <div
              onClick={navigateToFavorites}
              className="flex items-center bg-[#2a2a2a]/40 hover:bg-[#2a2a2a] rounded-[4px] overflow-hidden cursor-pointer group transition-all duration-300 h-[64px] shadow-sm hover:shadow-md"
            >
              <div className="w-[64px] h-[64px] flex-shrink-0 bg-gradient-to-br from-[#450af5] via-[#8e2de2] to-[#00d2ff] shadow-lg flex items-center justify-center">
                <Heart size={24} className="text-white" fill="white" />
              </div>
              <div className="flex-1 flex items-center justify-between px-4 min-w-0">
                <span className="font-bold text-[14px] text-white truncate pr-2">
                  Loved Tracks
                </span>
                <div className="w-10 h-10 bg-[#00FFFF] rounded-full flex items-center justify-center shadow-xl opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all duration-300 transform scale-90 group-hover:scale-100">
                  <Play size={20} fill="black" className="text-black ml-1" />
                </div>
              </div>
            </div>
            {userPlaylists.slice(0, 7).map((playlist) => (
              <div
                key={playlist.uuid}
                onClick={() => handlePlaylistPlay(playlist.uuid)}
                className="flex items-center bg-[#2a2a2a]/40 hover:bg-[#2a2a2a] rounded-[4px] overflow-hidden cursor-pointer group transition-all duration-300 h-[64px] shadow-sm hover:shadow-md"
              >
                <div className="w-[64px] h-[64px] flex-shrink-0 bg-[#282828] shadow-lg">
                  <TidalImage
                    src={getTidalImageUrl(playlist.image, 160)}
                    alt={playlist.title}
                    type="playlist"
                    className="w-full h-full"
                  />
                </div>
                <div className="flex-1 flex items-center justify-between px-4 min-w-0">
                  <span className="font-bold text-[14px] text-white truncate pr-2">
                    {playlist.title}
                  </span>
                  <div className="w-10 h-10 bg-[#00FFFF] rounded-full flex items-center justify-center shadow-xl opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all duration-300 transform scale-90 group-hover:scale-100">
                    <Play size={20} fill="black" className="text-black ml-1" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Recently Played / Featured */}
        {featuredTracks.length > 0 && (
          <section className="mb-10">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-[22px] font-bold text-white tracking-tight hover:underline cursor-pointer">
                Jump back in
              </h2>
              <button className="text-[13px] font-bold text-[#a6a6a6] hover:text-white uppercase tracking-wider transition-colors">
                Show all
              </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-8 gap-5">
              {featuredTracks.map((track, index) => (
                <div
                  key={track.id}
                  onClick={() => {
                    if (track.album?.id) {
                      navigateToAlbum(track.album.id, {
                        title: track.album.title,
                        cover: track.album.cover,
                        artistName: track.artist?.name,
                      });
                    }
                  }}
                  className="p-3 bg-[#181818] hover:bg-[#282828] rounded-md cursor-pointer group transition-all duration-300"
                >
                  <div className="aspect-square w-full rounded-md mb-3 relative overflow-hidden shadow-lg bg-[#282828]">
                    <TidalImage
                      src={getTidalImageUrl(track.album?.cover, 320)}
                      alt={track.album?.title || track.title}
                      className="w-full h-full transform group-hover:scale-105 transition-transform duration-500 ease-out"
                    />
                    <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setQueueTracks(featuredTracks.slice(index + 1));
                        handlePlayTrack(track);
                      }}
                      className="absolute bottom-2 right-2 w-10 h-10 bg-[#00FFFF] rounded-full flex items-center justify-center shadow-xl opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all duration-300 transform scale-90 group-hover:scale-100 hover:scale-110"
                    >
                      <Play
                        size={20}
                        fill="black"
                        className="text-black ml-1"
                      />
                    </button>
                  </div>
                  <h4 className="font-bold text-[15px] text-white truncate mb-1">
                    {track.album?.title || track.title}
                  </h4>
                  <p className="text-[13px] text-[#a6a6a6] truncate hover:text-white hover:underline transition-colors">
                    {track.artist?.name || "Unknown Artist"}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Your Playlists */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-[22px] font-bold text-white tracking-tight hover:underline cursor-pointer">
              Your Playlists
            </h2>
            <button className="text-[13px] font-bold text-[#a6a6a6] hover:text-white uppercase tracking-wider transition-colors">
              Show all
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-8 gap-5">
            {userPlaylists.slice(0, 16).map((playlist) => (
              <div
                key={playlist.uuid}
                onClick={() => handlePlaylistPlay(playlist.uuid)}
                className="p-3 bg-[#181818] hover:bg-[#282828] rounded-md cursor-pointer group transition-all duration-300"
              >
                <div className="aspect-square w-full rounded-md mb-3 relative overflow-hidden shadow-lg bg-[#282828]">
                  <TidalImage
                    src={getTidalImageUrl(playlist.image, 320)}
                    alt={playlist.title}
                    type="playlist"
                    className="w-full h-full transform group-hover:scale-105 transition-transform duration-500 ease-out"
                  />
                  <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                  <div className="absolute bottom-2 right-2 w-10 h-10 bg-[#00FFFF] rounded-full flex items-center justify-center shadow-xl opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all duration-300 transform scale-90 group-hover:scale-100">
                    <Play size={20} fill="black" className="text-black ml-1" />
                  </div>
                </div>
                <h4 className="font-bold text-[15px] text-white truncate mb-1">
                  {playlist.title}
                </h4>
                <p className="text-[13px] text-[#a6a6a6] line-clamp-2">
                  {playlist.description ||
                    `By ${playlist.creator?.name || "You"}`}
                </p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
