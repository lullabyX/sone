import { invoke } from "@tauri-apps/api/core";
import type {
  AlbumDetail,
  ArtistDetail,
  Credit,
  HomePageCached,
  HomePageResponse,
  Lyrics,
  MediaItemType,
  PaginatedTracks,
  SearchResults,
  SuggestionsResponse,
  Track,
} from "../types";

// ==================== Search ====================

export async function searchTidal(
  query: string,
  limit: number = 20
): Promise<SearchResults> {
  try {
    return await invoke<SearchResults>("search_tidal", { query, limit });
  } catch (error: any) {
    console.error("Failed to search:", error);
    throw error;
  }
}

export async function getSuggestions(
  query: string,
  limit: number = 10
): Promise<SuggestionsResponse> {
  try {
    return await invoke<SuggestionsResponse>("get_suggestions", {
      query,
      limit,
    });
  } catch {
    return { textSuggestions: [], directHits: [] };
  }
}

// ==================== Home Page ====================

export async function getHomePage(): Promise<HomePageCached> {
  return await invoke<HomePageCached>("get_home_page");
}

export async function refreshHomePage(): Promise<HomePageResponse> {
  return await invoke<HomePageResponse>("refresh_home_page");
}

export async function getPageSection(
  apiPath: string
): Promise<HomePageResponse> {
  return await invoke<HomePageResponse>("get_page_section", { apiPath });
}

// ==================== Album ====================

export async function getAlbumDetail(albumId: number): Promise<AlbumDetail> {
  try {
    return await invoke<AlbumDetail>("get_album_detail", { albumId });
  } catch (error: any) {
    console.error("Failed to get album detail:", error);
    throw error;
  }
}

export async function getAlbumTracks(
  albumId: number,
  offset: number = 0,
  limit: number = 50
): Promise<PaginatedTracks> {
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
}

// ==================== Artist ====================

export async function getArtistDetail(
  artistId: number
): Promise<ArtistDetail> {
  return await invoke<ArtistDetail>("get_artist_detail", { artistId });
}

export async function getArtistTopTracks(
  artistId: number,
  limit: number = 20
): Promise<Track[]> {
  return await invoke<Track[]>("get_artist_top_tracks", { artistId, limit });
}

export async function getArtistAlbums(
  artistId: number,
  limit: number = 20
): Promise<AlbumDetail[]> {
  return await invoke<AlbumDetail[]>("get_artist_albums", { artistId, limit });
}

export async function getArtistBio(artistId: number): Promise<string> {
  return await invoke<string>("get_artist_bio", { artistId });
}

// ==================== Playlist / Mix ====================

export async function getPlaylistTracks(
  playlistId: string
): Promise<Track[]> {
  try {
    console.log("Getting playlist tracks for:", playlistId);
    const tracks = await invoke<Track[]>("get_playlist_tracks", {
      playlistId: playlistId,
    });
    console.log("Got tracks:", tracks?.length);
    return tracks || [];
  } catch (error: any) {
    console.error("Failed to get playlist tracks:", error);
    alert(`Failed to get tracks: ${error?.message || error}`);
    return [];
  }
}

export async function getMixItems(mixId: string): Promise<Track[]> {
  return await invoke<Track[]>("get_mix_items", { mixId });
}

/** Fetch all tracks from a media item (album / playlist / mix) */
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
  }
}

// ==================== Track metadata ====================

export async function getTrackLyrics(trackId: number): Promise<Lyrics> {
  try {
    return await invoke<Lyrics>("get_track_lyrics", { trackId });
  } catch (error: any) {
    console.error("Failed to get lyrics:", error);
    throw error;
  }
}

export async function getTrackCredits(trackId: number): Promise<Credit[]> {
  try {
    return await invoke<Credit[]>("get_track_credits", { trackId });
  } catch (error: any) {
    console.error("Failed to get credits:", error);
    throw error;
  }
}

export async function getTrackRadio(
  trackId: number,
  limit: number = 20
): Promise<Track[]> {
  try {
    return await invoke<Track[]>("get_track_radio", { trackId, limit });
  } catch (error: any) {
    console.error("Failed to get track radio:", error);
    throw error;
  }
}

// ==================== Favorites (parameterised by userId) ====================

export async function getFavoriteTracks(
  userId: number,
  offset: number = 0,
  limit: number = 50
): Promise<PaginatedTracks> {
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
}

export async function getFavoriteArtists(
  userId: number,
  limit: number = 20
): Promise<ArtistDetail[]> {
  return await invoke<ArtistDetail[]>("get_favorite_artists", {
    userId,
    limit,
  });
}

export async function getFavoriteAlbums(
  userId: number,
  limit: number = 50
): Promise<AlbumDetail[]> {
  return await invoke<AlbumDetail[]>("get_favorite_albums", {
    userId,
    limit,
  });
}

// ==================== Auth helpers ====================

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
