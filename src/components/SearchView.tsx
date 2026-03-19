import { Play, Music, Search, User, MoreHorizontal } from "lucide-react";
import { useState, useEffect, useCallback, useRef } from "react";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useMediaPlay } from "../hooks/useMediaPlay";
import { useNavigation } from "../hooks/useNavigation";
import { useFavorites } from "../hooks/useFavorites";
import { searchTidal } from "../api/tidal";
import {
  getTidalImageUrl,
  type SearchResults,
  type Track,
  type AlbumDetail,
  type Playlist,
  type DirectHitItem,
  type MediaItemType,
} from "../types";
import TidalImage from "./TidalImage";
import MediaContextMenu from "./MediaContextMenu";
import TrackContextMenu from "./TrackContextMenu";
import MediaCard from "./MediaCard";
import ReusableTrackList from "./TrackList";
import PageContainer from "./PageContainer";
import { SearchPageSkeleton } from "./PageSkeleton";

type SearchTab =
  | "all"
  | "tophits"
  | "tracks"
  | "playlists"
  | "albums"
  | "artists";

const TABS: { id: SearchTab; label: string }[] = [
  { id: "all", label: "All Results" },
  { id: "tophits", label: "Top Hits" },
  { id: "tracks", label: "Tracks" },
  { id: "playlists", label: "Playlists" },
  { id: "albums", label: "Albums" },
  { id: "artists", label: "Artists" },
];

interface SearchViewProps {
  query: string;
  onBack: () => void;
}

export default function SearchView({ query, onBack }: SearchViewProps) {
  const { playTrack, setQueueTracks, playFromSource } = usePlaybackActions();
  const playMedia = useMediaPlay();
  const { navigateToAlbum, navigateToPlaylist, navigateToArtist } =
    useNavigation();

  const {
    favoriteAlbumIds,
    addFavoriteAlbum,
    removeFavoriteAlbum,
    favoritePlaylistUuids,
    addFavoritePlaylist,
    removeFavoritePlaylist,
  } = useFavorites();

  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SearchTab>("all");

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    item: MediaItemType;
    position: { x: number; y: number };
  } | null>(null);

  const handleAlbumContextMenu = useCallback(
    (e: React.MouseEvent, album: AlbumDetail) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        item: {
          type: "album",
          id: album.id,
          title: album.title,
          cover: album.cover,
          artistName: album.artist?.name,
        },
        position: { x: e.clientX, y: e.clientY },
      });
    },
    [],
  );

  const handlePlaylistContextMenu = useCallback(
    (e: React.MouseEvent, pl: Playlist) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        item: {
          type: "playlist",
          uuid: pl.uuid,
          title: pl.title,
          image: pl.image,
          creatorName:
            pl.creator?.name || (pl.creator?.id === 0 ? "TIDAL" : undefined),
        },
        position: { x: e.clientX, y: e.clientY },
      });
    },
    [],
  );

  const handleArtistContextMenu = useCallback(
    (
      e: React.MouseEvent,
      artist: { id: number; name: string; picture?: string },
    ) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        item: {
          type: "artist",
          id: artist.id,
          name: artist.name,
          picture: artist.picture,
        },
        position: { x: e.clientX, y: e.clientY },
      });
    },
    [],
  );

  useEffect(() => {
    if (!query.trim()) return;

    let active = true;
    setLoading(true);
    setError(null);

    searchTidal(query.trim(), 50)
      .then((r) => {
        if (active) setResults(r);
      })
      .catch((err) => {
        if (active) setError(String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [query]);

  const handlePlayTrack = (track: Track, _index: number) => {
    const allTracks = results?.tracks || [];
    playFromSource(track, allTracks, {
      source: {
        type: "search",
        id: query,
        name: `Search: ${query}`,
        allTracks,
      },
    });
  };

  if (loading) {
    return <SearchPageSkeleton />;
  }

  if (error) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center px-8">
          <Search size={48} className="text-th-text-disabled" />
          <p className="text-th-text-primary font-semibold text-lg">Search failed</p>
          <p className="text-th-text-muted text-sm max-w-md">{error}</p>
          <button
            onClick={onBack}
            className="mt-2 px-6 py-2 bg-th-text-primary text-th-base rounded-full text-sm font-bold hover:scale-105 transition-transform"
          >
            Go back
          </button>
        </div>
      </div>
    );
  }

  const noResults =
    results &&
    results.tracks.length === 0 &&
    results.albums.length === 0 &&
    results.artists.length === 0 &&
    results.playlists.length === 0;

  return (
    <div className="flex-1 bg-linear-to-b from-th-surface to-th-base min-h-full">
      <PageContainer className="px-6 py-6">
        {/* Tab bar */}
        <div className="pb-6 flex items-center gap-2">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-1.5 rounded-full text-[13px] font-medium transition-colors duration-150 ${
                activeTab === tab.id
                  ? "bg-th-text-primary text-th-base"
                  : "bg-th-hl-med text-th-text-secondary hover:bg-th-inset"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {noResults && (
          <div className="flex flex-col items-center justify-center py-20 text-th-text-disabled">
            <Search size={48} className="mb-4" />
            <p className="text-th-text-primary font-semibold text-lg mb-1">
              No results found
            </p>
            <p className="text-sm">Try a different search term</p>
          </div>
        )}

        {results && !noResults && (
          <div className="pb-8">
            {/* All Results tab — grouped sections: Tracks, Playlists, Albums, Artists */}
            {activeTab === "all" && (
              <div className="flex flex-col gap-8">
                {results.tracks.length > 0 && (
                  <section>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-[16px] font-bold text-th-text-primary">
                        Tracks
                      </h2>
                      <button
                        onClick={() => setActiveTab("tracks")}
                        className="text-[13px] font-bold text-th-text-muted hover:text-th-text-primary uppercase tracking-wider transition-colors"
                      >
                        View all
                      </button>
                    </div>
                    <ReusableTrackList
                      tracks={results.tracks.slice(0, 8)}
                      onPlay={handlePlayTrack}
                      showCover={true}
                      showArtist={true}
                      showAlbum={true}
                      context="search"
                    />
                  </section>
                )}
                {results.playlists.length > 0 && (
                  <section>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-[16px] font-bold text-th-text-primary">
                        Playlists
                      </h2>
                      <button
                        onClick={() => setActiveTab("playlists")}
                        className="text-[13px] font-bold text-th-text-muted hover:text-th-text-primary uppercase tracking-wider transition-colors"
                      >
                        View all
                      </button>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
                      {results.playlists.slice(0, 6).map((pl) => (
                        <MediaCard
                          key={pl.uuid}
                          item={pl}
                          onClick={() =>
                            navigateToPlaylist(pl.uuid, {
                              title: pl.title,
                              image: pl.image,
                              description: pl.description,
                              creatorName:
                                pl.creator?.name ||
                                (pl.creator?.id === 0 ? "TIDAL" : undefined),
                              numberOfTracks: pl.numberOfTracks,
                            })
                          }
                          onContextMenu={(e) =>
                            handlePlaylistContextMenu(e, pl)
                          }
                          onPlay={(e) => {
                            e.stopPropagation();
                            playMedia({
                              type: "playlist",
                              uuid: pl.uuid,
                              title: pl.title,
                              image: pl.image,
                            });
                          }}
                          isFavorited={favoritePlaylistUuids.has(pl.uuid)}
                          onFavoriteToggle={(e) => {
                            e.stopPropagation();
                            if (favoritePlaylistUuids.has(pl.uuid))
                              removeFavoritePlaylist(pl.uuid);
                            else addFavoritePlaylist(pl.uuid, pl);
                          }}
                        />
                      ))}
                    </div>
                  </section>
                )}
                {results.albums.length > 0 && (
                  <section>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-[16px] font-bold text-th-text-primary">
                        Albums
                      </h2>
                      <button
                        onClick={() => setActiveTab("albums")}
                        className="text-[13px] font-bold text-th-text-muted hover:text-th-text-primary uppercase tracking-wider transition-colors"
                      >
                        View all
                      </button>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
                      {results.albums.slice(0, 6).map((album) => (
                        <MediaCard
                          key={album.id}
                          item={album}
                          onClick={() =>
                            navigateToAlbum(album.id, {
                              title: album.title,
                              cover: album.cover,
                              artistName: album.artist?.name,
                            })
                          }
                          onContextMenu={(e) =>
                            handleAlbumContextMenu(e, album)
                          }
                          onPlay={(e) => {
                            e.stopPropagation();
                            playMedia({
                              type: "album",
                              id: album.id,
                              title: album.title,
                              cover: album.cover,
                            });
                          }}
                          isFavorited={favoriteAlbumIds.has(album.id)}
                          onFavoriteToggle={(e) => {
                            e.stopPropagation();
                            if (favoriteAlbumIds.has(album.id))
                              removeFavoriteAlbum(album.id);
                            else addFavoriteAlbum(album.id, album);
                          }}
                        />
                      ))}
                    </div>
                  </section>
                )}
                {results.artists.length > 0 && (
                  <section>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-[16px] font-bold text-th-text-primary">
                        Artists
                      </h2>
                      <button
                        onClick={() => setActiveTab("artists")}
                        className="text-[13px] font-bold text-th-text-muted hover:text-th-text-primary uppercase tracking-wider transition-colors"
                      >
                        View all
                      </button>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
                      {results.artists.slice(0, 6).map((artist) => (
                        <MediaCard
                          key={artist.id}
                          item={artist}
                          onClick={() =>
                            navigateToArtist(artist.id, {
                              name: artist.name,
                              picture: artist.picture,
                            })
                          }
                          onContextMenu={(e) =>
                            handleArtistContextMenu(e, artist)
                          }
                          onPlay={(e) => {
                            e.stopPropagation();
                            playMedia({
                              type: "artist",
                              id: artist.id,
                              name: artist.name,
                              picture: artist.picture,
                            });
                          }}
                          isArtist
                        />
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}

            {/* Top Hits tab — mixed entity types in API relevance order */}
            {activeTab === "tophits" && (
              <TopHitsList
                topHits={results.topHits || []}
                onPlayTrack={(hit) => {
                  const trackObj: Track = {
                    id: hit.id || 0,
                    title: hit.title || "",
                    duration: hit.duration || 0,
                    artist: hit.artistName
                      ? { id: 0, name: hit.artistName }
                      : undefined,
                    album: hit.albumId
                      ? {
                          id: hit.albumId,
                          title: hit.albumTitle || "",
                          cover: hit.albumCover,
                        }
                      : undefined,
                  };
                  setQueueTracks([]);
                  playTrack(trackObj);
                }}
                onAlbumClick={(hit) => {
                  if (hit.id)
                    navigateToAlbum(hit.id, {
                      title: hit.title || "",
                      cover: hit.cover,
                      artistName: hit.artistName,
                    });
                }}
                onArtistClick={(hit) => {
                  if (hit.id)
                    navigateToArtist(hit.id, {
                      name: hit.name || "",
                      picture: hit.picture,
                    });
                }}
                onPlaylistClick={(hit) => {
                  if (hit.uuid)
                    navigateToPlaylist(hit.uuid, {
                      title: hit.title || "",
                      image: hit.image,
                    });
                }}
                onMediaContextMenu={(item, position) => {
                  setContextMenu({ item, position });
                }}
              />
            )}

            {/* Tracks tab */}
            {activeTab === "tracks" && results.tracks.length > 0 && (
              <ReusableTrackList
                tracks={results.tracks}
                onPlay={handlePlayTrack}
                showCover={true}
                showArtist={true}
                showAlbum={true}
                context="search"
              />
            )}

            {/* Playlists tab */}
            {activeTab === "playlists" && results.playlists.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
                {results.playlists.map((pl) => (
                  <MediaCard
                    key={pl.uuid}
                    item={pl}
                    onClick={() =>
                      navigateToPlaylist(pl.uuid, {
                        title: pl.title,
                        image: pl.image,
                        description: pl.description,
                        creatorName:
                          pl.creator?.name ||
                          (pl.creator?.id === 0 ? "TIDAL" : undefined),
                        numberOfTracks: pl.numberOfTracks,
                      })
                    }
                    onContextMenu={(e) => handlePlaylistContextMenu(e, pl)}
                    onPlay={(e) => {
                      e.stopPropagation();
                      playMedia({
                        type: "playlist",
                        uuid: pl.uuid,
                        title: pl.title,
                        image: pl.image,
                      });
                    }}
                    isFavorited={favoritePlaylistUuids.has(pl.uuid)}
                    onFavoriteToggle={(e) => {
                      e.stopPropagation();
                      if (favoritePlaylistUuids.has(pl.uuid))
                        removeFavoritePlaylist(pl.uuid);
                      else addFavoritePlaylist(pl.uuid, pl);
                    }}
                  />
                ))}
              </div>
            )}

            {/* Albums tab */}
            {activeTab === "albums" && results.albums.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
                {results.albums.map((album) => (
                  <MediaCard
                    key={album.id}
                    item={album}
                    onClick={() =>
                      navigateToAlbum(album.id, {
                        title: album.title,
                        cover: album.cover,
                        artistName: album.artist?.name,
                      })
                    }
                    onContextMenu={(e) => handleAlbumContextMenu(e, album)}
                    onPlay={(e) => {
                      e.stopPropagation();
                      playMedia({
                        type: "album",
                        id: album.id,
                        title: album.title,
                        cover: album.cover,
                      });
                    }}
                    isFavorited={favoriteAlbumIds.has(album.id)}
                    onFavoriteToggle={(e) => {
                      e.stopPropagation();
                      if (favoriteAlbumIds.has(album.id))
                        removeFavoriteAlbum(album.id);
                      else addFavoriteAlbum(album.id, album);
                    }}
                  />
                ))}
              </div>
            )}

            {/* Artists tab */}
            {activeTab === "artists" && results.artists.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
                {results.artists.map((artist) => (
                  <MediaCard
                    key={artist.id}
                    item={artist}
                    onClick={() =>
                      navigateToArtist(artist.id, {
                        name: artist.name,
                        picture: artist.picture,
                      })
                    }
                    onContextMenu={(e) => handleArtistContextMenu(e, artist)}
                    onPlay={(e) => {
                      e.stopPropagation();
                      playMedia({
                        type: "artist",
                        id: artist.id,
                        name: artist.name,
                        picture: artist.picture,
                      });
                    }}
                    isArtist
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Media context menu */}
        {contextMenu && (
          <MediaContextMenu
            item={contextMenu.item}
            cursorPosition={contextMenu.position}
            onClose={() => setContextMenu(null)}
          />
        )}
      </PageContainer>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function TopHitsList({
  topHits,
  onPlayTrack,
  onAlbumClick,
  onArtistClick,
  onPlaylistClick,
  onMediaContextMenu,
}: {
  topHits: DirectHitItem[];
  onPlayTrack: (hit: DirectHitItem) => void;
  onAlbumClick: (hit: DirectHitItem) => void;
  onArtistClick: (hit: DirectHitItem) => void;
  onPlaylistClick: (hit: DirectHitItem) => void;
  onMediaContextMenu: (
    item: MediaItemType,
    position: { x: number; y: number },
  ) => void;
}) {
  // Track context menu state (managed locally)
  const [ctxTrack, setCtxTrack] = useState<{
    track: Track;
    index: number;
  } | null>(null);
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | undefined>(
    undefined,
  );
  const dotsRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  if (topHits.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-th-text-disabled">
        <Search size={48} className="mb-4" />
        <p className="text-th-text-primary font-semibold text-lg mb-1">No top hits</p>
        <p className="text-sm">Try the other tabs for more results</p>
      </div>
    );
  }

  const buildTrackObj = (hit: DirectHitItem): Track => ({
    id: hit.id || 0,
    title: hit.title || "",
    duration: hit.duration || 0,
    artist: hit.artistName ? { id: 0, name: hit.artistName } : undefined,
    album: hit.albumId
      ? { id: hit.albumId, title: hit.albumTitle || "", cover: hit.albumCover }
      : undefined,
  });

  return (
    <div className="flex flex-col">
      {topHits.map((hit, idx) => {
        if (hit.hitType === "TRACKS") {
          const trackObj = buildTrackObj(hit);
          return (
            <div
              key={`th-${idx}`}
              className="flex items-center gap-4 px-3 py-3 hover:bg-th-border-subtle rounded-md transition-colors text-left group/track cursor-pointer"
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setCtxPos({ x: e.clientX, y: e.clientY });
                setCtxTrack({ track: trackObj, index: idx });
              }}
            >
              <button
                className="flex-1 flex items-center gap-4 min-w-0"
                onClick={() => onPlayTrack(hit)}
              >
                <div className="w-12 h-12 rounded bg-th-surface-hover overflow-hidden shrink-0 relative">
                  <TidalImage
                    src={getTidalImageUrl(hit.albumCover, 80)}
                    alt={hit.title || ""}
                    className="w-full h-full"
                  />
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover/track:opacity-100 transition-opacity">
                    <Play
                      size={16}
                      fill="white"
                      className="text-white ml-0.5"
                    />
                  </div>
                </div>
                <div className="flex-1 min-w-0 text-left">
                  <p className="text-[14px] text-th-text-primary truncate">{hit.title}</p>
                  <p className="text-[12px] text-th-text-faint truncate">
                    Track &middot; {hit.artistName || "Unknown Artist"}
                  </p>
                </div>
              </button>
              <button
                ref={(el) => {
                  if (el) dotsRefs.current.set(trackObj.id, el);
                  else dotsRefs.current.delete(trackObj.id);
                }}
                className="p-1 rounded-full text-th-text-faint hover:text-th-text-primary opacity-0 group-hover/track:opacity-100 transition-opacity shrink-0"
                title="More options"
                onClick={(e) => {
                  e.stopPropagation();
                  setCtxPos(undefined);
                  setCtxTrack((prev) =>
                    prev?.track.id === trackObj.id
                      ? null
                      : { track: trackObj, index: idx },
                  );
                }}
              >
                <MoreHorizontal size={16} />
              </button>
              {ctxTrack?.track.id === trackObj.id && (
                <TrackContextMenu
                  track={trackObj}
                  index={ctxTrack.index}
                  anchorRef={{
                    current: dotsRefs.current.get(trackObj.id) ?? null,
                  }}
                  cursorPosition={ctxPos}
                  onClose={() => setCtxTrack(null)}
                />
              )}
            </div>
          );
        }
        if (hit.hitType === "ALBUMS") {
          return (
            <div
              key={`th-${idx}`}
              className="flex items-center gap-4 px-3 py-3 hover:bg-th-border-subtle rounded-md transition-colors text-left group/item cursor-pointer"
              onClick={() => onAlbumClick(hit)}
              onContextMenu={(e) => {
                if (!hit.id) return;
                e.preventDefault();
                e.stopPropagation();
                onMediaContextMenu(
                  {
                    type: "album",
                    id: hit.id,
                    title: hit.title || "",
                    cover: hit.cover,
                    artistName: hit.artistName,
                  },
                  { x: e.clientX, y: e.clientY },
                );
              }}
            >
              <div className="w-12 h-12 rounded bg-th-surface-hover overflow-hidden shrink-0">
                <TidalImage
                  src={getTidalImageUrl(hit.cover, 80)}
                  alt={hit.title || ""}
                  className="w-full h-full"
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[14px] text-th-text-primary truncate">{hit.title}</p>
                <p className="text-[12px] text-th-text-faint truncate">
                  Album &middot; {hit.artistName || "Unknown"}
                  {hit.numberOfTracks ? ` · ${hit.numberOfTracks} tracks` : ""}
                </p>
              </div>
              <button
                className="p-1 rounded-full text-th-text-faint hover:text-th-text-primary opacity-0 group-hover/item:opacity-100 transition-opacity shrink-0"
                title="More options"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!hit.id) return;
                  onMediaContextMenu(
                    {
                      type: "album",
                      id: hit.id,
                      title: hit.title || "",
                      cover: hit.cover,
                      artistName: hit.artistName,
                    },
                    { x: e.clientX, y: e.clientY },
                  );
                }}
              >
                <MoreHorizontal size={16} />
              </button>
            </div>
          );
        }
        if (hit.hitType === "ARTISTS") {
          return (
            <div
              key={`th-${idx}`}
              className="flex items-center gap-4 px-3 py-3 hover:bg-th-border-subtle rounded-md transition-colors text-left group/item cursor-pointer"
              onClick={() => onArtistClick(hit)}
              onContextMenu={(e) => {
                if (!hit.id) return;
                e.preventDefault();
                e.stopPropagation();
                onMediaContextMenu(
                  {
                    type: "artist",
                    id: hit.id,
                    name: hit.name || "",
                    picture: hit.picture,
                  },
                  { x: e.clientX, y: e.clientY },
                );
              }}
            >
              <div className="w-12 h-12 rounded-full bg-th-surface-hover overflow-hidden shrink-0">
                {hit.picture ? (
                  <TidalImage
                    src={getTidalImageUrl(hit.picture, 80)}
                    alt={hit.name || ""}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <User size={20} className="text-th-text-disabled" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[14px] text-th-text-primary truncate font-medium">
                  {hit.name}
                </p>
                <p className="text-[12px] text-th-text-faint">Artist</p>
              </div>
              <button
                className="p-1 rounded-full text-th-text-faint hover:text-th-text-primary opacity-0 group-hover/item:opacity-100 transition-opacity shrink-0"
                title="More options"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!hit.id) return;
                  onMediaContextMenu(
                    {
                      type: "artist",
                      id: hit.id,
                      name: hit.name || "",
                      picture: hit.picture,
                    },
                    { x: e.clientX, y: e.clientY },
                  );
                }}
              >
                <MoreHorizontal size={16} />
              </button>
            </div>
          );
        }
        if (hit.hitType === "PLAYLISTS") {
          return (
            <div
              key={`th-${idx}`}
              className="flex items-center gap-4 px-3 py-3 hover:bg-th-border-subtle rounded-md transition-colors text-left group/item cursor-pointer"
              onClick={() => onPlaylistClick(hit)}
              onContextMenu={(e) => {
                if (!hit.uuid) return;
                e.preventDefault();
                e.stopPropagation();
                onMediaContextMenu(
                  {
                    type: "playlist",
                    uuid: hit.uuid,
                    title: hit.title || "",
                    image: hit.image,
                  },
                  { x: e.clientX, y: e.clientY },
                );
              }}
            >
              <div className="w-12 h-12 rounded bg-th-surface-hover overflow-hidden shrink-0">
                {hit.image ? (
                  <TidalImage
                    src={getTidalImageUrl(hit.image, 80)}
                    alt={hit.title || ""}
                    type="playlist"
                    className="w-full h-full"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Music size={20} className="text-th-text-disabled" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[14px] text-th-text-primary truncate">{hit.title}</p>
                <p className="text-[12px] text-th-text-faint truncate">
                  Playlist
                  {hit.numberOfTracks ? ` · ${hit.numberOfTracks} tracks` : ""}
                </p>
              </div>
              <button
                className="p-1 rounded-full text-th-text-faint hover:text-th-text-primary opacity-0 group-hover/item:opacity-100 transition-opacity shrink-0"
                title="More options"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!hit.uuid) return;
                  onMediaContextMenu(
                    {
                      type: "playlist",
                      uuid: hit.uuid,
                      title: hit.title || "",
                      image: hit.image,
                    },
                    { x: e.clientX, y: e.clientY },
                  );
                }}
              >
                <MoreHorizontal size={16} />
              </button>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
