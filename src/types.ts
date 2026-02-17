// Helper to convert Tidal cover UUID to image URL
export function getTidalImageUrl(
  coverUuid: string | undefined,
  size: number = 320
): string {
  if (!coverUuid) return "";
  
  // If it's already a full URL, return it as is (or resize if supported, but usually these are static)
  if (coverUuid.startsWith("http")) {
    return coverUuid;
  }

  // Tidal cover UUIDs need to be converted: uuid with dashes -> path with slashes
  const path = coverUuid.replace(/-/g, "/");
  // Use standard Tidal sizes: 160, 320, 640, 1280
  // If an invalid size is requested, snap to the nearest supported size
  let validSize = 320;
  if (size <= 160) validSize = 160;
  else if (size <= 320) validSize = 320;
  else if (size <= 640) validSize = 640;
  else validSize = 1280;

  return `https://resources.tidal.com/images/${path}/${validSize}x${validSize}.jpg`;
}

export interface Track {
  id: number;
  title: string;
  artist?: { id: number; name: string; picture?: string };
  album?: { id: number; title: string; cover?: string };
  duration: number;
  audioQuality?: string;
  trackNumber?: number;
  dateAdded?: string;
}

export interface AlbumDetail {
  id: number;
  title: string;
  cover?: string;
  artist?: { id: number; name: string; picture?: string };
  numberOfTracks?: number;
  duration?: number;
  releaseDate?: string;
}

export interface PaginatedTracks {
  items: Track[];
  totalNumberOfItems: number;
  offset: number;
  limit: number;
}

export type AppView =
  | { type: "home" }
  | {
      type: "album";
      albumId: number;
      albumInfo?: { title: string; cover?: string; artistName?: string };
    }
  | {
      type: "playlist";
      playlistId: string;
      playlistInfo?: {
        title: string;
        image?: string;
        description?: string;
        creatorName?: string;
        numberOfTracks?: number;
        isUserPlaylist?: boolean;
      };
    }
  | { type: "favorites" }
  | { type: "search"; query: string }
  | {
      type: "viewAll";
      title: string;
      apiPath: string;
    }
  | {
      type: "artist";
      artistId: number;
      artistInfo?: { name: string; picture?: string };
    }
  | {
      type: "mix";
      mixId: string;
      mixInfo?: { title: string; image?: string; subtitle?: string };
    }
  | {
      type: "trackRadio";
      trackId: number;
      trackInfo?: { title: string; artistName?: string; cover?: string };
    }
  | { type: "explore" }
  | { type: "explorePage"; apiPath: string; title: string };

export interface SearchResults {
  artists: { id: number; name: string; picture?: string }[];
  albums: AlbumDetail[];
  tracks: Track[];
  playlists: Playlist[];
  topHitType?: string;
  topHits?: DirectHitItem[];
}

export interface DirectHitItem {
  hitType: string; // "ARTISTS", "ALBUMS", "TRACKS", "PLAYLISTS"
  id?: number;
  uuid?: string;
  name?: string;
  title?: string;
  picture?: string;
  cover?: string;
  image?: string;
  artistName?: string;
  albumId?: number;
  albumTitle?: string;
  albumCover?: string;
  duration?: number;
  numberOfTracks?: number;
}

export interface SuggestionTextItem {
  query: string;
  source: string; // "history" or "suggestion"
}

export interface SuggestionsResponse {
  textSuggestions: SuggestionTextItem[];
  directHits: DirectHitItem[];
}

export interface Playlist {
  uuid: string;
  title: string;
  description?: string;
  image?: string;
  numberOfTracks?: number;
  creator?: { id: number; name?: string };
}

export interface PkceAuthParams {
  authorizeUrl: string;
  codeVerifier: string;
  clientUniqueKey: string;
}

export interface DeviceAuthResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  user_id?: number;
}

export interface Lyrics {
  trackId?: number;
  lyricsProvider?: string;
  providerCommontrackId?: string;
  providerLyricsId?: string;
  lyrics?: string;
  subtitles?: string;
  isRightToLeft: boolean;
}

export interface Credit {
  creditType: string;
  contributors: { name: string }[];
}

export interface StreamInfo {
  url: string;
  codec?: string;
  bitDepth?: number;
  sampleRate?: number;
  audioQuality?: string;
  albumReplayGain?: number;
}

// ==================== Home Page Types ====================

export interface HomeSection {
  title: string;
  sectionType: string;
  items: any[];
  hasMore: boolean;
  apiPath?: string;
}

export interface HomePageResponse {
  sections: HomeSection[];
}

export interface HomePageCached {
  home: HomePageResponse;
  isStale: boolean;
}

export interface ArtistDetail {
  id: number;
  name: string;
  picture?: string;
}

/** Union type describing a right-clickable media item (album / playlist / mix) */
export type MediaItemType =
  | { type: "album"; id: number; title: string; cover?: string; artistName?: string }
  | { type: "playlist"; uuid: string; title: string; image?: string; creatorName?: string }
  | { type: "mix"; mixId: string; title: string; image?: string; subtitle?: string };

export interface PlaybackSnapshot {
  currentTrack: Track | null;
  queue: Track[];
  history: Track[];
}
