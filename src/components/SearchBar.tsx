import { Search, X, Loader2, MoreHorizontal, Clock, Play } from "lucide-react";
import { useState, useRef, useCallback, useEffect } from "react";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useNavigation } from "../hooks/useNavigation";
import { getSuggestions } from "../api/tidal";
import {
  getTidalImageUrl,
  type DirectHitItem,
  type SuggestionTextItem,
  type Track,
  type MediaItemType,
} from "../types";
import TidalImage from "./TidalImage";
import TrackContextMenu from "./TrackContextMenu";
import MediaContextMenu from "./MediaContextMenu";

const HISTORY_KEY = "sone.search-history";
const MAX_HISTORY = 10;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed))
        return parsed
          .filter((s) => typeof s === "string")
          .slice(0, MAX_HISTORY);
    }
  } catch {}
  return [];
}

function saveHistory(history: string[]) {
  try {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(history.slice(0, MAX_HISTORY)),
    );
  } catch {}
}

export default function SearchBar() {
  const { playTrack, setQueueTracks } = usePlaybackActions();
  const {
    currentView,
    navigateToAlbum,
    navigateToArtist,
    navigateToSearch,
    navigateToPlaylist,
  } = useNavigation();

  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [textSuggestions, setTextSuggestions] = useState<SuggestionTextItem[]>(
    [],
  );
  const [directHits, setDirectHits] = useState<DirectHitItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchHistory, setSearchHistory] = useState<string[]>(loadHistory);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // Track context menu state
  const [ctxTrack, setCtxTrack] = useState<Track | null>(null);
  const [ctxTrackIndex, setCtxTrackIndex] = useState(0);
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | undefined>(
    undefined,
  );
  const dotsRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  // Media context menu state (albums, playlists, artists)
  const [mediaCtx, setMediaCtx] = useState<{
    item: MediaItemType;
    position: { x: number; y: number };
  } | null>(null);

  // Sync search query with current view if it's a search view
  useEffect(() => {
    if (currentView.type === "search") {
      setSearchQuery(currentView.query);
    }
  }, [currentView]);

  // Debounced suggestions fetch — single call powers the entire mini-search dropdown
  const doQuickSearch = useCallback(
    (query: string) => {
      clearTimeout(debounceRef.current);
      if (!query.trim()) {
        setTextSuggestions([]);
        setDirectHits([]);
        setSearching(false);
        return;
      }
      setSearching(true);
      debounceRef.current = setTimeout(() => {
        getSuggestions(query.trim(), 10)
          .then((resp) => {
            setTextSuggestions(resp.textSuggestions);
            setDirectHits(resp.directHits);
          })
          .catch(() => {
            setTextSuggestions([]);
            setDirectHits([]);
          })
          .finally(() => {
            setSearching(false);
          });
      }, 300); // Increased debounce to 300ms
    },
    [getSuggestions],
  );

  const addToHistory = useCallback((query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setSearchHistory((prev) => {
      const filtered = prev.filter(
        (h) => h.toLowerCase() !== trimmed.toLowerCase(),
      );
      const next = [trimmed, ...filtered].slice(0, MAX_HISTORY);
      saveHistory(next);
      return next;
    });
  }, []);

  const removeFromHistory = useCallback((query: string) => {
    setSearchHistory((prev) => {
      const next = prev.filter((h) => h !== query);
      saveHistory(next);
      return next;
    });
  }, []);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearchQuery(val);
    setSearchOpen(true);
    doQuickSearch(val);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && searchQuery.trim()) {
      setSearchOpen(false);
      addToHistory(searchQuery.trim());
      navigateToSearch(searchQuery.trim());
    } else if (e.key === "Escape") {
      setSearchOpen(false);
      searchInputRef.current?.blur();
    }
  };

  const clearSearch = () => {
    setSearchQuery("");
    setSearchOpen(false);
    setTextSuggestions([]);
    setDirectHits([]);
    searchInputRef.current?.focus();
  };

  // Listen for global Ctrl+S focus event
  useEffect(() => {
    const handler = () => {
      searchInputRef.current?.focus();
      setSearchOpen(true);
    };
    window.addEventListener("focus-search", handler);
    return () => window.removeEventListener("focus-search", handler);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        searchInputRef.current &&
        !searchInputRef.current.contains(e.target as Node)
      ) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const hasDirectHits = directHits.length > 0;
  const hasTextSuggestions = textSuggestions.length > 0;

  // Local search history: filter by typed prefix (only shown when no query or no server results)
  const matchingHistory = searchQuery.trim()
    ? searchHistory.filter(
        (h) =>
          h.toLowerCase().includes(searchQuery.trim().toLowerCase()) &&
          h.toLowerCase() !== searchQuery.trim().toLowerCase(),
      )
    : searchHistory;

  // When we have server-side suggestions, don't show local history (server returns its own history)
  const showLocalHistory =
    searchOpen && !searchQuery.trim() && matchingHistory.length > 0;
  const showTextSuggestions =
    searchOpen && searchQuery.trim() && hasTextSuggestions;
  const showDirectHits =
    searchOpen && searchQuery.trim() && (searching || hasDirectHits);
  const showDropdown =
    showLocalHistory || showTextSuggestions || showDirectHits;

  return (
    <div className="relative max-w-[360px] w-64 lg:w-80">
      <div className="flex items-center gap-2 px-3 py-2 bg-th-inset hover:bg-th-inset focus-within:bg-th-inset rounded-full transition-colors group border border-transparent focus-within:border-th-border-subtle">
        <Search
          size={18}
          className="text-th-text-secondary group-focus-within:text-th-text-primary shrink-0"
        />
        <input
          ref={searchInputRef}
          type="text"
          value={searchQuery}
          onChange={handleSearchChange}
          onKeyDown={handleSearchKeyDown}
          onFocus={() => setSearchOpen(true)}
          placeholder="Search"
          className="bg-transparent text-sm text-th-text-primary placeholder-th-text-faint outline-none flex-1 min-w-0"
        />
        {searchQuery && (
          <button
            onClick={clearSearch}
            className="text-th-text-faint hover:text-th-text-primary shrink-0"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Search Dropdown — powered by v2/suggestions/ endpoint */}
      {showDropdown && (
        <div
          ref={dropdownRef}
          className="absolute right-0 top-full mt-2 w-[420px] bg-th-surface rounded-lg shadow-2xl shadow-black/60 border border-th-border-subtle z-50 max-h-[70vh] overflow-y-auto scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent"
        >
          {/* Local history (when input is empty) */}
          {showLocalHistory && (
            <div className="py-1">
              <div className="px-3 pt-2 pb-1 text-[11px] text-th-text-faint uppercase tracking-wider font-medium">
                Recent searches
              </div>
              {matchingHistory.slice(0, 5).map((item) => (
                <div
                  key={item}
                  className="flex items-center gap-3 px-3 py-3 hover:bg-th-border-subtle transition-colors cursor-pointer"
                >
                  <Clock size={15} className="text-th-text-faint shrink-0" />
                  <button
                    className="flex-1 text-left text-[13px] text-th-text-primary truncate"
                    onClick={() => {
                      setSearchQuery(item);
                      setSearchOpen(false);
                      addToHistory(item);
                      navigateToSearch(item);
                    }}
                  >
                    {item}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFromHistory(item);
                    }}
                    className="text-th-text-faint hover:text-th-text-primary shrink-0 p-0.5"
                    title="Remove"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Text suggestions (history + autocomplete from server) */}
          {showTextSuggestions && (
            <div className="py-1">
              {textSuggestions.map((s, i) => (
                <button
                  key={`sug-${i}`}
                  className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-th-border-subtle transition-colors text-left"
                  onClick={() => {
                    setSearchQuery(s.query);
                    setTextSuggestions([]);
                    setDirectHits([]);
                    setSearchOpen(false);
                    addToHistory(s.query);
                    navigateToSearch(s.query);
                  }}
                >
                  {s.source === "history" ? (
                    <Clock size={15} className="text-th-text-faint shrink-0" />
                  ) : (
                    <Search size={15} className="text-th-text-faint shrink-0" />
                  )}
                  <span className="text-[13px] text-th-text-primary truncate">
                    {s.query}
                  </span>
                  {s.source === "history" && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeFromHistory(s.query);
                      }}
                      className="ml-auto text-th-text-faint hover:text-th-text-primary shrink-0 p-0.5"
                      title="Remove"
                    >
                      <X size={14} />
                    </button>
                  )}
                </button>
              ))}
              {showDirectHits && (
                <div className="border-b border-th-border-subtle mx-3" />
              )}
            </div>
          )}

          {/* Direct hits — rendered in exact API order (mixed types) */}
          {showDirectHits && (
            <>
              {searching && !hasDirectHits && (
                <div className="flex items-center justify-center py-6">
                  <Loader2 size={18} className="animate-spin text-th-accent" />
                </div>
              )}

              {!searching && !hasDirectHits && searchQuery.trim() && (
                <div className="py-6 text-center text-[13px] text-th-text-faint">
                  No results found
                </div>
              )}

              {hasDirectHits && (
                <div className="py-1">
                  {directHits.map((hit, idx) => {
                    if (hit.hitType === "ARTISTS") {
                      return (
                        <div
                          key={`dh-${idx}`}
                          className="flex items-center gap-3 px-3 py-3 hover:bg-th-border-subtle transition-colors text-left group/item cursor-pointer"
                          onClick={() => {
                            setSearchOpen(false);
                            if (hit.id)
                              navigateToArtist(hit.id, {
                                name: hit.name || "",
                                picture: hit.picture,
                              });
                          }}
                          onContextMenu={(e) => {
                            if (!hit.id) return;
                            e.preventDefault();
                            e.stopPropagation();
                            setMediaCtx({
                              item: {
                                type: "artist",
                                id: hit.id,
                                name: hit.name || "",
                                picture: hit.picture,
                              },
                              position: { x: e.clientX, y: e.clientY },
                            });
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
                                <span className="text-[12px] font-bold text-th-text-faint">
                                  {(hit.name || "?").charAt(0)}
                                </span>
                              </div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[14px] text-th-text-primary truncate font-medium">
                              {hit.name}
                            </p>
                            <p className="text-[11px] text-th-text-faint">
                              Artist
                            </p>
                          </div>
                          <button
                            className="p-1 rounded-full text-th-text-faint hover:text-th-text-primary opacity-0 group-hover/item:opacity-100 transition-opacity shrink-0"
                            title="More options"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!hit.id) return;
                              setMediaCtx({
                                item: {
                                  type: "artist",
                                  id: hit.id,
                                  name: hit.name || "",
                                  picture: hit.picture,
                                },
                                position: { x: e.clientX, y: e.clientY },
                              });
                            }}
                          >
                            <MoreHorizontal size={16} />
                          </button>
                        </div>
                      );
                    }
                    if (hit.hitType === "ALBUMS") {
                      return (
                        <div
                          key={`dh-${idx}`}
                          className="flex items-center gap-3 px-3 py-3 hover:bg-th-border-subtle transition-colors text-left group/item cursor-pointer"
                          onClick={() => {
                            setSearchOpen(false);
                            if (hit.id)
                              navigateToAlbum(hit.id, {
                                title: hit.title || "",
                                cover: hit.cover,
                                artistName: hit.artistName,
                              });
                          }}
                          onContextMenu={(e) => {
                            if (!hit.id) return;
                            e.preventDefault();
                            e.stopPropagation();
                            setMediaCtx({
                              item: {
                                type: "album",
                                id: hit.id,
                                title: hit.title || "",
                                cover: hit.cover,
                                artistName: hit.artistName,
                              },
                              position: { x: e.clientX, y: e.clientY },
                            });
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
                            <p className="text-[14px] text-th-text-primary truncate">
                              {hit.title}
                            </p>
                            <p className="text-[11px] text-th-text-faint truncate">
                              Album &middot; {hit.artistName || "Unknown"}
                            </p>
                          </div>
                          <button
                            className="p-1 rounded-full text-th-text-faint hover:text-th-text-primary opacity-0 group-hover/item:opacity-100 transition-opacity shrink-0"
                            title="More options"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!hit.id) return;
                              setMediaCtx({
                                item: {
                                  type: "album",
                                  id: hit.id,
                                  title: hit.title || "",
                                  cover: hit.cover,
                                  artistName: hit.artistName,
                                },
                                position: { x: e.clientX, y: e.clientY },
                              });
                            }}
                          >
                            <MoreHorizontal size={16} />
                          </button>
                        </div>
                      );
                    }
                    if (hit.hitType === "TRACKS") {
                      // Build a minimal Track object for playback and context menu
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
                      return (
                        <div
                          key={`dh-${idx}`}
                          className="flex items-center gap-3 px-3 py-3 hover:bg-th-border-subtle transition-colors text-left group/track"
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setCtxPos({ x: e.clientX, y: e.clientY });
                            setCtxTrackIndex(idx);
                            setCtxTrack(trackObj);
                          }}
                        >
                          <button
                            className="flex-1 flex items-center gap-3 min-w-0"
                            onClick={() => {
                              setSearchOpen(false);
                              setQueueTracks([]);
                              playTrack(trackObj);
                            }}
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
                              <p className="text-[14px] text-th-text-primary truncate">
                                {hit.title}
                              </p>
                              <p className="text-[11px] text-th-text-faint truncate">
                                Track &middot;{" "}
                                {hit.artistName || "Unknown Artist"}
                              </p>
                            </div>
                          </button>
                          <button
                            ref={(el) => {
                              if (el) dotsRefs.current.set(hit.id || 0, el);
                              else dotsRefs.current.delete(hit.id || 0);
                            }}
                            className="p-1 rounded-full text-th-text-faint hover:text-th-text-primary opacity-0 group-hover/track:opacity-100 transition-opacity shrink-0"
                            title="More options"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCtxPos(undefined);
                              setCtxTrackIndex(idx);
                              setCtxTrack((prev) =>
                                prev?.id === trackObj.id ? null : trackObj,
                              );
                            }}
                          >
                            <MoreHorizontal size={16} />
                          </button>
                          {ctxTrack?.id === trackObj.id && (
                            <TrackContextMenu
                              track={trackObj}
                              index={ctxTrackIndex}
                              anchorRef={{
                                current:
                                  dotsRefs.current.get(trackObj.id) ?? null,
                              }}
                              cursorPosition={ctxPos}
                              onClose={() => setCtxTrack(null)}
                            />
                          )}
                        </div>
                      );
                    }
                    if (hit.hitType === "PLAYLISTS") {
                      return (
                        <div
                          key={`dh-${idx}`}
                          className="flex items-center gap-3 px-3 py-3 hover:bg-th-border-subtle transition-colors text-left group/item cursor-pointer"
                          onClick={() => {
                            setSearchOpen(false);
                            if (hit.uuid)
                              navigateToPlaylist(hit.uuid, {
                                title: hit.title || "",
                                image: hit.image,
                              });
                          }}
                          onContextMenu={(e) => {
                            if (!hit.uuid) return;
                            e.preventDefault();
                            e.stopPropagation();
                            setMediaCtx({
                              item: {
                                type: "playlist",
                                uuid: hit.uuid,
                                title: hit.title || "",
                                image: hit.image,
                              },
                              position: { x: e.clientX, y: e.clientY },
                            });
                          }}
                        >
                          <div className="w-12 h-12 rounded bg-th-surface-hover overflow-hidden shrink-0">
                            <TidalImage
                              src={getTidalImageUrl(hit.image, 80)}
                              alt={hit.title || ""}
                              className="w-full h-full"
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[14px] text-th-text-primary truncate">
                              {hit.title}
                            </p>
                            <p className="text-[11px] text-th-text-faint truncate">
                              Playlist
                              {hit.numberOfTracks
                                ? ` · ${hit.numberOfTracks} tracks`
                                : ""}
                            </p>
                          </div>
                          <button
                            className="p-1 rounded-full text-th-text-faint hover:text-th-text-primary opacity-0 group-hover/item:opacity-100 transition-opacity shrink-0"
                            title="More options"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!hit.uuid) return;
                              setMediaCtx({
                                item: {
                                  type: "playlist",
                                  uuid: hit.uuid,
                                  title: hit.title || "",
                                  image: hit.image,
                                },
                                position: { x: e.clientX, y: e.clientY },
                              });
                            }}
                          >
                            <MoreHorizontal size={16} />
                          </button>
                        </div>
                      );
                    }
                    return null;
                  })}

                  {/* View all */}
                  <button
                    onClick={() => {
                      setSearchOpen(false);
                      addToHistory(searchQuery.trim());
                      navigateToSearch(searchQuery.trim());
                    }}
                    className="w-full py-2.5 text-center text-[12px] font-semibold text-th-accent hover:bg-th-hl-faint border-t border-th-border-subtle transition-colors"
                  >
                    View all results
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Media context menu (albums, playlists, artists) */}
      {mediaCtx && (
        <MediaContextMenu
          item={mediaCtx.item}
          cursorPosition={mediaCtx.position}
          onClose={() => setMediaCtx(null)}
        />
      )}
    </div>
  );
}
