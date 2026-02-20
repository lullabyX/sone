import { invoke } from "@tauri-apps/api/core";
import type {
  AlbumDetail,
  ArtistDetail,
  ArtistPageData,
  Credit,
  FavoriteMix,
  HomePageCached,
  HomePageResponse,
  Lyrics,
  MediaItemType,
  Paginated,
  PaginatedTracks,
  Playlist,
  SearchResults,
  SuggestionsResponse,
  Track,
} from "../types";

// ==================== In-memory cache (size-based LRU + TTL + hashed keys) ====================

interface CacheEntry {
  data: unknown;
  ts: number;
  ttl: number;
  tags: string[];
  accessOrder: number;
  estimatedSize: number;
}

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB
let currentBytes = 0;
let accessCounter = 0;

const store = new Map<string, CacheEntry>();         // hashedKey → entry
const tagIndex = new Map<string, Set<string>>();      // tag → Set<hashedKey>
const keyMap = new Map<string, string>();              // hashedKey → plaintextKey

const TTL = {
  SHORT: 2 * 60_000,           // 2 min  — search, suggestions
  MEDIUM: 2 * 60 * 60_000,     // 2 hrs  — lyrics, playlists, favorites, mixes, page sections
  STATIC: 24 * 60 * 60_000,    // 24 hrs — albums, artists, credits
};

/** FNV-1a hash → base-36 string */
function hashKey(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function estimateSize(data: unknown): number {
  try {
    return JSON.stringify(data).length * 2;
  } catch {
    return 1024; // fallback 1KB
  }
}

function removeEntry(hk: string): void {
  const entry = store.get(hk);
  if (!entry) return;
  currentBytes -= entry.estimatedSize;
  for (const tag of entry.tags) {
    const set = tagIndex.get(tag);
    if (set) {
      set.delete(hk);
      if (set.size === 0) tagIndex.delete(tag);
    }
  }
  store.delete(hk);
  keyMap.delete(hk);
}

function evictIfNeeded(requiredBytes: number): void {
  if (currentBytes + requiredBytes <= MAX_BYTES) return;
  const entries = [...store.entries()].sort(
    (a, b) => a[1].accessOrder - b[1].accessOrder,
  );
  const target = MAX_BYTES * 0.9; // evict down to 90%
  for (const [hk] of entries) {
    if (currentBytes + requiredBytes <= target) break;
    removeEntry(hk);
  }
}

function cached<T>(key: string, tags: string[], fetcher: () => Promise<T>, ttl: number): Promise<T> {
  const hk = hashKey(key);
  const entry = store.get(hk);
  if (entry && Date.now() - entry.ts < entry.ttl) {
    entry.accessOrder = ++accessCounter;
    return Promise.resolve(entry.data as T);
  }
  return fetcher().then((data) => {
    // Remove stale entry if present
    if (store.has(hk)) removeEntry(hk);
    const size = estimateSize(data);
    evictIfNeeded(size);
    const newEntry: CacheEntry = {
      data,
      ts: Date.now(),
      ttl,
      tags,
      accessOrder: ++accessCounter,
      estimatedSize: size,
    };
    store.set(hk, newEntry);
    keyMap.set(hk, key);
    currentBytes += size;
    for (const tag of tags) {
      let set = tagIndex.get(tag);
      if (!set) { set = new Set(); tagIndex.set(tag, set); }
      set.add(hk);
    }
    return data;
  });
}

/** Remove all cache entries matching a tag (fast path) or key prefix (fallback). */
export function invalidateCache(prefix: string): void {
  // Fast path: try tag index
  const tagSet = tagIndex.get(prefix);
  if (tagSet) {
    for (const hk of [...tagSet]) removeEntry(hk);
    return;
  }
  // Fallback: scan plaintext keys for prefix match
  for (const [hk, plainKey] of keyMap.entries()) {
    if (plainKey.startsWith(prefix)) removeEntry(hk);
  }
}

/** Mutate a cached entry in-place. Scans plaintext keys for prefix match. */
function mutateCache<T>(keyPrefix: string, updater: (data: T) => T): void {
  for (const [hk, plainKey] of keyMap.entries()) {
    if (plainKey.startsWith(keyPrefix)) {
      const entry = store.get(hk);
      if (entry) {
        const oldSize = entry.estimatedSize;
        entry.data = updater(entry.data as T);
        entry.estimatedSize = estimateSize(entry.data);
        currentBytes += entry.estimatedSize - oldSize;
      }
    }
  }
}

/** Optimistically prepend a track to all cached favorite-track pages. */
export function addTrackToFavoritesCache(userId: number, track: Track): void {
  mutateCache<PaginatedTracks>(`fav-tracks:${userId}:`, (page) => ({
    ...page,
    items: [track, ...page.items],
    totalNumberOfItems: page.totalNumberOfItems + 1,
  }));
}

/** Optimistically remove a track from all cached favorite-track pages. */
export function removeTrackFromFavoritesCache(userId: number, trackId: number): void {
  mutateCache<PaginatedTracks>(`fav-tracks:${userId}:`, (page) => ({
    ...page,
    items: page.items.filter((t) => t.id !== trackId),
    totalNumberOfItems: Math.max(0, page.totalNumberOfItems - 1),
  }));
}

/** Optimistically prepend an album to all cached favorite-album pages. */
export function addAlbumToFavoritesCache(userId: number, album: AlbumDetail): void {
  mutateCache<Paginated<AlbumDetail>>(`fav-albums:${userId}:`, (page) => ({
    ...page,
    items: [album, ...page.items],
    totalNumberOfItems: page.totalNumberOfItems + 1,
  }));
}

/** Optimistically remove an album from all cached favorite-album pages. */
export function removeAlbumFromFavoritesCache(userId: number, albumId: number): void {
  mutateCache<Paginated<AlbumDetail>>(`fav-albums:${userId}:`, (page) => ({
    ...page,
    items: page.items.filter((a) => a.id !== albumId),
    totalNumberOfItems: Math.max(0, page.totalNumberOfItems - 1),
  }));
}

/** Optimistically prepend a playlist to all cached favorite-playlist pages. */
export function addPlaylistToFavoritesCache(userId: number, playlist: Playlist): void {
  mutateCache<Paginated<Playlist>>(`fav-playlists:${userId}:`, (page) => ({
    ...page,
    items: [playlist, ...page.items],
    totalNumberOfItems: page.totalNumberOfItems + 1,
  }));
}

/** Optimistically remove a playlist from all cached favorite-playlist pages. */
export function removePlaylistFromFavoritesCache(userId: number, playlistUuid: string): void {
  mutateCache<Paginated<Playlist>>(`fav-playlists:${userId}:`, (page) => ({
    ...page,
    items: page.items.filter((p) => p.uuid !== playlistUuid),
    totalNumberOfItems: Math.max(0, page.totalNumberOfItems - 1),
  }));
}

/** Optimistically prepend an artist to all cached followed-artist pages. */
export function addArtistToFollowedCache(userId: number, artist: ArtistDetail): void {
  mutateCache<ArtistDetail[]>(`fav-artists:${userId}:`, (artists) => [artist, ...artists]);
}

/** Optimistically remove an artist from all cached followed-artist pages. */
export function removeArtistFromFollowedCache(userId: number, artistId: number): void {
  mutateCache<ArtistDetail[]>(`fav-artists:${userId}:`, (artists) =>
    artists.filter((a) => a.id !== artistId)
  );
}

/** Drop the entire cache (e.g. on logout). */
export function clearCache(): void {
  store.clear();
  tagIndex.clear();
  keyMap.clear();
  currentBytes = 0;
  accessCounter = 0;
}

/** Clear both frontend in-memory cache AND backend disk cache. */
export async function clearAllCache(): Promise<void> {
  clearCache(); // Frontend cache
  await invoke("clear_disk_cache"); // Backend disk cache
}

// ==================== Search ====================

export async function searchTidal(
  query: string,
  limit: number = 20
): Promise<SearchResults> {
  return cached(`search:${query}:${limit}`, ["search"], async () => {
    try {
      return await invoke<SearchResults>("search_tidal", { query, limit });
    } catch (error: any) {
      console.error("Failed to search:", error);
      throw error;
    }
  }, TTL.SHORT);
}

export async function getSuggestions(
  query: string,
  limit: number = 10
): Promise<SuggestionsResponse> {
  return cached(`suggest:${query}:${limit}`, ["search"], async () => {
    try {
      return await invoke<SuggestionsResponse>("get_suggestions", {
        query,
        limit,
      });
    } catch {
      return { textSuggestions: [], directHits: [] };
    }
  }, TTL.SHORT);
}

// ==================== Home Page ====================

export async function getHomePage(): Promise<HomePageCached> {
  return cached("home-page", ["home"], () =>
    invoke<HomePageCached>("get_home_page"),
  TTL.MEDIUM);
}

export async function refreshHomePage(): Promise<HomePageResponse> {
  return await invoke<HomePageResponse>("refresh_home_page");
}

export async function getHomePageMore(cursor: string): Promise<HomePageResponse> {
  return await invoke<HomePageResponse>("get_home_page_more", { cursor });
}

export async function getPageSection(
  apiPath: string
): Promise<HomePageResponse> {
  return cached(`section:${apiPath}`, ["home"], () =>
    invoke<HomePageResponse>("get_page_section", { apiPath }),
  TTL.MEDIUM);
}

// ==================== Album ====================

export async function getAlbumDetail(albumId: number): Promise<AlbumDetail> {
  return cached(`album:${albumId}`, ["album"], async () => {
    try {
      return await invoke<AlbumDetail>("get_album_detail", { albumId });
    } catch (error: any) {
      console.error("Failed to get album detail:", error);
      throw error;
    }
  }, TTL.STATIC);
}

export async function getAlbumTracks(
  albumId: number,
  offset: number = 0,
  limit: number = 50
): Promise<PaginatedTracks> {
  return cached(`album-tracks:${albumId}:${offset}:${limit}`, ["album"], async () => {
    try {
      return await invoke<PaginatedTracks>("get_album_tracks", {
        albumId,
        offset,
        limit,
      });
    } catch (error: any) {
      console.error("Failed to get album tracks:", error);
      throw error;
    }
  }, TTL.STATIC);
}

// ==================== Artist ====================

export async function getArtistDetail(
  artistId: number
): Promise<ArtistDetail> {
  return cached(`artist:${artistId}`, ["artist"], () =>
    invoke<ArtistDetail>("get_artist_detail", { artistId }),
  TTL.STATIC);
}

export async function getArtistTopTracks(
  artistId: number,
  limit: number = 20
): Promise<Track[]> {
  return cached(`artist-tracks:${artistId}:${limit}`, ["artist"], () =>
    invoke<Track[]>("get_artist_top_tracks", { artistId, limit }),
  TTL.STATIC);
}

export async function getArtistAlbums(
  artistId: number,
  limit: number = 20
): Promise<AlbumDetail[]> {
  return cached(`artist-albums:${artistId}:${limit}`, ["artist"], () =>
    invoke<AlbumDetail[]>("get_artist_albums", { artistId, limit }),
  TTL.STATIC);
}

export async function getArtistBio(artistId: number): Promise<string> {
  return cached(`artist-bio:${artistId}`, ["artist"], () =>
    invoke<string>("get_artist_bio", { artistId }),
  TTL.STATIC);
}

export async function getArtistPage(artistId: number): Promise<ArtistPageData> {
  return cached(`artist-page:${artistId}`, ["artist"], async () => {
    const raw = await invoke<any>("get_artist_page", { artistId });
    return parseArtistPageResponse(raw);
  }, TTL.MEDIUM);
}

/** Parse raw artist page response — detects v2 (json.item) vs v1 (json.rows) */
function parseArtistPageResponse(json: any): ArtistPageData {
  if (json?.item) return parseArtistPageV2(json);
  return parseArtistPageV1(json);
}

const V2_TYPE_TO_SECTION: Record<string, string> = {
  TRACK: "TRACK_LIST",
  ALBUM: "ALBUM_LIST",
  ARTIST: "ARTIST_LIST",
  PLAYLIST: "PLAYLIST_LIST",
  MIX: "MIX_LIST",
};

function parseArtistPageV2(json: any): ArtistPageData {
  const result: ArtistPageData = {
    artistName: json.item?.data?.name || "",
    picture: json.item?.data?.picture,
    bio: json.header?.biography?.text,
    bioSource: json.header?.biography?.source,
    topTracks: [],
    sections: [],
  };

  const modules = json.items;
  if (!Array.isArray(modules)) return result;

  for (const mod of modules) {
    const rawItems: any[] = mod.items || [];
    if (rawItems.length === 0) continue;

    const firstType = rawItems[0]?.type as string;
    if (firstType === "VIDEO" || firstType === "TRACK_CREDITS") continue;

    const sectionType = V2_TYPE_TO_SECTION[firstType] || firstType;
    const items = rawItems.map((i: any) => i.data || i);

    if (sectionType === "TRACK_LIST" && result.topTracks.length === 0) {
      result.topTracks = items;
    }

    result.sections.push({
      title: mod.title || "",
      type: sectionType,
      items,
      apiPath: mod.viewAll,
    });
  }

  return result;
}

function parseArtistPageV1(json: any): ArtistPageData {
  const result: ArtistPageData = {
    artistName: "",
    topTracks: [],
    sections: [],
  };

  const rows = json?.rows;
  if (!Array.isArray(rows)) return result;

  for (const row of rows) {
    const modules = row?.modules;
    if (!Array.isArray(modules)) continue;

    for (const mod of modules) {
      const type = mod?.type as string;
      const title = (mod?.title || "") as string;

      if (type === "ARTIST_HEADER") {
        const artist = mod?.artist;
        if (artist) {
          result.artistName = artist.name || "";
          result.picture = artist.picture;
        }
        const bio = mod?.bio;
        if (bio) {
          result.bio = bio.text;
          result.bioSource = bio.source;
        }
        continue;
      }

      const items = mod?.pagedList?.items;
      if (!Array.isArray(items) || items.length === 0) continue;

      if (type === "TRACK_LIST") {
        if (result.topTracks.length === 0) {
          result.topTracks = items;
        }
        result.sections.push({ title: title || "Popular tracks", type: "TRACK_LIST", items, apiPath: mod?.showMore?.apiPath });
        continue;
      }

      if (title || items.length > 0) {
        result.sections.push({ title, type, items, apiPath: mod?.showMore?.apiPath });
      }
    }
  }

  return result;
}

export async function getArtistViewAll(artistId: number, viewAllPath: string): Promise<any[]> {
  return cached(`artist-view-all:${artistId}:${viewAllPath}`, ["artist"], async () => {
    const raw = await invoke<any>("get_artist_view_all", { artistId, viewAllPath });
    const items = raw?.items || [];
    return items.map((item: any) => item.data || item);
  }, TTL.MEDIUM);
}

export async function getArtistTopTracksAll(
  artistId: number,
  offset: number = 0,
  limit: number = 50
): Promise<{ items: Track[]; hasMore: boolean }> {
  const fetcher = async () => {
    const raw = await invoke<any>("get_artist_top_tracks_all", { artistId, offset, limit });
    const rawItems = raw?.items || [];
    const items: Track[] = rawItems.map((item: any) => {
      const t = item.data || item;
      if (!t.artist && t.artists?.[0]) {
        t.artist = t.artists[0];
      }
      return t;
    });
    // v2 API doesn't return totalNumberOfItems — full page means there's probably more
    return { items, hasMore: items.length >= limit };
  };
  if (offset === 0) {
    return cached(`artist-top-tracks-all:${artistId}`, ["artist"], fetcher, TTL.MEDIUM);
  }
  return fetcher();
}

// ==================== Playlist / Mix ====================

export async function getPlaylistTracks(
  playlistId: string
): Promise<Track[]> {
  return cached(`playlist:${playlistId}`, [`playlist:${playlistId}`], async () => {
    try {
      const tracks = await invoke<Track[]>("get_playlist_tracks", {
        playlistId: playlistId,
      });
      return tracks || [];
    } catch (error: any) {
      console.error("Failed to get playlist tracks:", error);
      throw error;
    }
  }, TTL.MEDIUM);
}

export async function getPlaylistTracksPage(
  playlistId: string,
  offset: number = 0,
  limit: number = 50
): Promise<PaginatedTracks> {
  return cached(`playlist-page:${playlistId}:${offset}:${limit}`, [`playlist:${playlistId}`], async () => {
    try {
      return await invoke<PaginatedTracks>("get_playlist_tracks_page", {
        playlistId,
        offset,
        limit,
      });
    } catch (error: any) {
      console.error("Failed to get playlist tracks page:", error);
      throw error;
    }
  }, TTL.MEDIUM);
}

export async function getMixItems(mixId: string): Promise<Track[]> {
  return cached(`mix:${mixId}`, ["mix"], () =>
    invoke<Track[]>("get_mix_items", { mixId }),
  TTL.MEDIUM);
}

/** Fetch all tracks from a media item (album / playlist / mix / artist) */
export async function fetchMediaTracks(
  item: MediaItemType
): Promise<Track[]> {
  switch (item.type) {
    case "album": {
      const result = await getAlbumTracks(item.id, 0, 200);
      return result.items;
    }
    case "playlist": {
      return await getPlaylistTracks(item.uuid);
    }
    case "mix": {
      return await getMixItems(item.mixId);
    }
    case "artist": {
      return await getArtistTopTracks(item.id);
    }
  }
}

// ==================== Track metadata ====================

export async function getTrackLyrics(trackId: number): Promise<Lyrics> {
  return cached(`lyrics:${trackId}`, ["lyrics"], async () => {
    try {
      return await invoke<Lyrics>("get_track_lyrics", { trackId });
    } catch (error: any) {
      console.error("Failed to get lyrics:", error);
      throw error;
    }
  }, TTL.MEDIUM);
}

export async function getTrackCredits(trackId: number): Promise<Credit[]> {
  return cached(`credits:${trackId}`, ["credits"], async () => {
    try {
      return await invoke<Credit[]>("get_track_credits", { trackId });
    } catch (error: any) {
      console.error("Failed to get credits:", error);
      throw error;
    }
  }, TTL.STATIC);
}

export async function getTrackRadio(
  trackId: number,
  limit: number = 20
): Promise<Track[]> {
  return cached(`track-radio:${trackId}:${limit}`, ["track-radio"], async () => {
    try {
      return await invoke<Track[]>("get_track_radio", { trackId, limit });
    } catch (error: any) {
      console.error("Failed to get track radio:", error);
      throw error;
    }
  }, TTL.MEDIUM);
}

// ==================== Favorites (parameterised by userId) ====================

export async function getFavoriteTracks(
  userId: number,
  offset: number = 0,
  limit: number = 50
): Promise<PaginatedTracks> {
  return cached(`fav-tracks:${userId}:${offset}:${limit}`, ["fav-tracks"], async () => {
    try {
      return await invoke<PaginatedTracks>("get_favorite_tracks", {
        userId,
        offset,
        limit,
      });
    } catch (error: any) {
      console.error("Failed to get favorite tracks:", error);
      throw error;
    }
  }, TTL.MEDIUM);
}

export async function getFavoriteArtists(
  userId: number,
  limit: number = 20
): Promise<ArtistDetail[]> {
  return cached(`fav-artists:${userId}:${limit}`, ["fav-artists"], () =>
    invoke<ArtistDetail[]>("get_favorite_artists", { userId, limit }),
  TTL.MEDIUM);
}

export async function getFavoriteAlbums(
  userId: number,
  offset: number = 0,
  limit: number = 50
): Promise<Paginated<AlbumDetail>> {
  return cached(`fav-albums:${userId}:${offset}:${limit}`, ["fav-albums"], () =>
    invoke<Paginated<AlbumDetail>>("get_favorite_albums", { userId, offset, limit }),
  TTL.MEDIUM);
}

export async function getFavoriteMixes(
  offset: number = 0,
  limit: number = 20
): Promise<Paginated<FavoriteMix>> {
  return cached(`fav-mixes:${offset}:${limit}`, ["fav-mixes"], () =>
    invoke<Paginated<FavoriteMix>>("get_favorite_mixes", { offset, limit }),
  TTL.MEDIUM);
}

// ==================== Playlists (paginated) ====================

export async function getUserPlaylists(
  userId: number,
  offset: number = 0,
  limit: number = 20
): Promise<Paginated<Playlist>> {
  return cached(`user-playlists:${userId}:${offset}:${limit}`, ["user-playlists"], () =>
    invoke<Paginated<Playlist>>("get_user_playlists", { userId, offset, limit }),
  TTL.MEDIUM);
}

export async function getFavoritePlaylists(
  userId: number,
  offset: number = 0,
  limit: number = 20
): Promise<Paginated<Playlist>> {
  return cached(`fav-playlists:${userId}:${offset}:${limit}`, ["fav-playlists"], () =>
    invoke<Paginated<Playlist>>("get_favorite_playlists", { userId, offset, limit }),
  TTL.MEDIUM);
}

// ==================== Auth helpers (never cached) ====================

export async function getSavedCredentials(): Promise<{
  clientId: string;
  clientSecret: string;
}> {
  try {
    const [clientId, clientSecret] = await invoke<[string, string]>(
      "get_saved_credentials"
    );
    return { clientId, clientSecret };
  } catch (error) {
    console.error("Failed to get saved credentials:", error);
    return { clientId: "", clientSecret: "" };
  }
}

export async function parseTokenData(
  rawText: string
): Promise<{
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
}> {
  return await invoke("parse_token_data", { rawText });
}

// ==================== Playback queue persistence ====================

export async function savePlaybackQueue(snapshotJson: string): Promise<void> {
  return invoke("save_playback_queue", { snapshotJson });
}

export async function loadPlaybackQueue(): Promise<string | null> {
  return invoke("load_playback_queue");
}
