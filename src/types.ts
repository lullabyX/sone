// Helper to convert Tidal cover UUID to image URL
export function getTidalImageUrl(
  coverUuid: string | undefined,
  size: number = 320,
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

export interface MediaMetadata {
  tags: string[]; // "LOSSLESS" | "HIRES_LOSSLESS" | "DOLBY_ATMOS"
}

export interface Track {
  id: number;
  title: string;
  version?: string;
  artist?: {
    id: number;
    name: string;
    picture?: string;
    artistType?: string;
    handle?: string;
  };
  artists?: {
    id: number;
    name: string;
    picture?: string;
    artistType?: string;
    handle?: string;
  }[];
  album?: {
    id: number;
    title: string;
    cover?: string;
    vibrantColor?: string;
    videoCover?: string;
    releaseDate?: string;
  };
  duration: number;
  audioQuality?: string;
  trackNumber?: number;
  volumeNumber?: number;
  dateAdded?: string;
  isrc?: string;
  explicit?: boolean;
  popularity?: number;
  replayGain?: number;
  peak?: number;
  copyright?: string;
  url?: string;
  streamReady?: boolean;
  allowStreaming?: boolean;
  premiumStreamingOnly?: boolean;
  streamStartDate?: string;
  audioModes?: string[]; // "STEREO" | "DOLBY_ATMOS"
  mediaMetadata?: MediaMetadata;
  mixes?: { TRACK_MIX?: string; MASTER_TRACK_MIX?: string };
  _qid?: string;
}

export function getTrackDisplayTitle(track: { title: string; version?: string }): string {
  if (track.version) return `${track.title} (${track.version})`;
  return track.title;
}

export interface ManualTrackSource {
  type: string;
  id: string | number;
  name: string;
  image?: string;
  subtitle?: string;
  mixType?: string;
}

export interface QueuedTrack extends Track {
  _qid: string;
  _source?: ManualTrackSource;
}

export interface AlbumDetail {
  id: number;
  title: string;
  version?: string;
  cover?: string;
  vibrantColor?: string;
  videoCover?: string;
  artist?: {
    id: number;
    name: string;
    picture?: string;
    artistType?: string;
    handle?: string;
  };
  artists?: {
    id: number;
    name: string;
    picture?: string;
    artistType?: string;
    handle?: string;
  }[];
  numberOfTracks?: number;
  numberOfVideos?: number;
  numberOfVolumes?: number;
  duration?: number;
  releaseDate?: string;
  upc?: string;
  /** "ALBUM" | "EP" | "SINGLE" */
  albumType?: string;
  copyright?: string;
  explicit?: boolean;
  popularity?: number;
  url?: string;
  audioQuality?: string;
  streamReady?: boolean;
  allowStreaming?: boolean;
  streamStartDate?: string;
  audioModes?: string[];
  mediaMetadata?: MediaMetadata;
}

export interface PaginatedTracks {
  items: Track[];
  totalNumberOfItems: number;
  offset: number;
  limit: number;
}

export interface Paginated<T> {
  items: T[];
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
      artistId?: number;
    }
  | {
      type: "artist";
      artistId: number;
      artistInfo?: { name: string; picture?: string };
    }
  | {
      type: "mix";
      mixId: string;
      mixInfo?: { title: string; image?: string; subtitle?: string; mixType?: string };
    }
  | { type: "explore" }
  | { type: "explorePage"; apiPath: string; title: string }
  | {
      type: "artistTracks";
      artistId: number;
      artistName: string;
    }
  | {
      type: "libraryViewAll";
      libraryType: "playlists" | "albums" | "artists" | "mixes";
      folderId?: string;
      folderName?: string;
    };

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
  /** "USER" | "EDITORIAL" | "ARTIST" */
  playlistType?: string;
  duration?: number;
  lastUpdated?: string;
  squareImage?: string;
  sharingLevel?: string;
  addedAt?: string;
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
  contributors: { name: string; id?: number }[];
}

export interface StreamInfo {
  url: string;
  codec?: string;
  bitDepth?: number;
  sampleRate?: number;
  audioQuality?: string;
  /** "STEREO" | "DOLBY_ATMOS" */
  audioMode?: string;
  /** "FULL" | "PREVIEW" */
  assetPresentation?: string;
  /** "application/dash+xml" | "application/vnd.tidal.bts" */
  manifestMimeType?: string;
  manifestHash?: string;
  trackId?: number;
  albumReplayGain?: number;
  albumPeakAmplitude?: number;
  trackReplayGain?: number;
  trackPeakAmplitude?: number;
}

// ==================== v2 Home Feed MIX types ====================

/** @public */
export interface MixTextInfo {
  color?: string | null;
  text: string;
}

/** @public */
export interface MixImage {
  size?: string;
  width?: number;
  height?: number;
  url: string;
}

/** @public */
export interface MixImageRef {
  imageUuid?: string;
  vibrantColor?: string;
}

/** @public */
export interface MixArtistRef {
  artistId?: number;
  artistName?: string;
  artistImage?: MixImageRef;
}

/** @public */
export interface MixTrackRef {
  trackId?: number;
  trackTitle?: string;
  trackGroup?: string;
  trackImage?: MixImageRef;
}

/** v2 home feed MIX entity — completely unique shape from other Tidal entities. */
export interface HomeFeedMix {
  id: string;
  /** "TRACK_MIX" | "ARTIST_MIX" | "HISTORY_ALLTIME_MIX" | "HISTORY_MONTHLY_MIX" | "HISTORY_YEARLY_MIX" */
  type?: string;
  titleTextInfo?: MixTextInfo;
  subtitleTextInfo?: MixTextInfo;
  shortSubtitleTextInfo?: MixTextInfo;
  description?: MixTextInfo;
  mixImages?: MixImage[];
  detailMixImages?: MixImage[];
  artist?: MixArtistRef;
  track?: MixTrackRef;
  contentBehavior?: string;
  countryCode?: string;
  isStableId?: boolean;
  sortType?: string;
  updated?: number;
  artifactIdType?: string;
}

/** Union of all item types that can appear in a v2 home feed section. */
/** @public */
export type HomeFeedItem =
  | (Track & { _itemType?: "TRACK" })
  | (AlbumDetail & { _itemType?: "ALBUM" })
  | (Playlist & { _itemType?: "PLAYLIST" })
  | (ArtistDetail & { _itemType?: "ARTIST" })
  | (HomeFeedMix & { _itemType?: "MIX" });

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
  cursor?: string;
}

export interface HomePageCached {
  home: HomePageResponse;
  isStale: boolean;
}

export interface ArtistRole {
  category: string;
  categoryId: number;
}

export interface ArtistDetail {
  id: number;
  name: string;
  picture?: string;
  handle?: string;
  userId?: number;
  popularity?: number;
  url?: string;
  spotlighted?: boolean;
  artistTypes?: string[];
  artistRoles?: ArtistRole[];
  mixes?: Record<string, string>;
}

/** Parsed from the raw v1 pages/artist response on the frontend */
export interface ArtistPageData {
  artistName: string;
  picture?: string;
  bio?: string;
  bioSource?: string;
  topTracks: Track[];
  sections: ArtistPageSection[];
}

export interface ArtistPageSection {
  title: string;
  type: string;
  items: (Track | AlbumDetail | ArtistDetail | Playlist | HomeFeedMix)[];
  apiPath?: string;
}

/** Union type describing a right-clickable media item (album / playlist / mix / artist) */
export type MediaItemType =
  | {
      type: "album";
      id: number;
      title: string;
      cover?: string;
      artistName?: string;
    }
  | {
      type: "playlist";
      uuid: string;
      title: string;
      image?: string;
      creatorName?: string;
    }
  | {
      type: "mix";
      mixId: string;
      title: string;
      image?: string;
      subtitle?: string;
    }
  | { type: "artist"; id: number; name: string; picture?: string };

export interface FavoriteMix {
  id: string;
  title: string;
  subTitle: string;
  mixType?: string;
  images?: {
    SMALL?: { url: string };
    MEDIUM?: { url: string };
    LARGE?: { url: string };
  };
}

export interface PlaybackSource {
  type: string;
  id: string | number;
  name: string;
  image?: string;
  subtitle?: string;
  mixType?: string;
  tracks: QueuedTrack[];
}

export interface PlaybackSnapshot {
  currentTrack: Track | null;
  queue: Track[];
  history: Track[];
  originalQueue?: Track[] | null;
  manualQueue?: Track[];
  playbackSource?: {
    type: string;
    id: string | number;
    name: string;
    image?: string;
    subtitle?: string;
    mixType?: string;
    tracks: Track[];
  } | null;
  contextSource?: {
    type: string;
    id: string | number;
    name: string;
    image?: string;
    subtitle?: string;
    mixType?: string;
    tracks: Track[];
  } | null;
}

/** @public */
export interface AllFavoriteIds {
  tracks: number[];
  albums: number[];
  artists: number[];
  playlists: string[];
}

// ==================== Album Page Types ====================

export interface AlbumPageCredit {
  creditType: string;
  contributors: { id?: number; name: string }[];
}

export interface AlbumPageReview {
  source?: string;
  text?: string;
}

export interface AlbumPageSection {
  title: string;
  sectionType: string;
  items: any[];
  apiPath?: string;
}

export interface AlbumPageResponse {
  album: AlbumDetail;
  tracks: Track[];
  totalTracks: number;
  vibrantColor?: string;
  copyright?: string;
  credits: AlbumPageCredit[];
  review?: AlbumPageReview;
  sections: AlbumPageSection[];
}

export interface AlbumPageCached {
  page: AlbumPageResponse;
  isStale: boolean;
}

// ==================== Playlist Folders (v2/my-collection/playlists/folders) ====================

export interface PlaylistFoldersResponse {
  lastModifiedAt: string;
  items: PlaylistFolderItem[];
  totalNumberOfItems: number;
  cursor: string | null;
}

export type CollectionItemType = "PLAYLIST" | "FOLDER";

export interface PlaylistFolderItem {
  trn: string;
  itemType: CollectionItemType;
  addedAt: string;
  lastModifiedAt: string;
  name: string;
  parent: string | null;
  data: PlaylistFolderData;
}

export interface PlaylistFolderCreator {
  id: number;
  name: string | null;
  picture: string | null;
  type: "TIDAL" | "USER";
}

export interface PlaylistFolderPromotedArtist {
  id: number;
  name: string;
  type: string;
}

export interface PlaylistFolderData {
  uuid: string;
  type: "EDITORIAL" | "USER";
  creator: PlaylistFolderCreator;
  curators: unknown[];
  contentBehavior: string;
  sharingLevel: string;
  status: string;
  source: string;
  title: string;
  description: string;
  image: string;
  squareImage: string;
  customImageUrl: string | null;
  url: string;
  created: string;
  lastUpdated: string;
  lastItemAddedAt: string;
  duration: number;
  numberOfTracks: number;
  numberOfVideos: number;
  promotedArtists: PlaylistFolderPromotedArtist[];
  trn: string;
  itemType: CollectionItemType;
}

export interface Folder {
  id: string;
  name: string;
  parent: string | null;
  addedAt: string;
  lastModifiedAt: string;
  /** Count of items in the folder, from API */
  totalNumberOfItems?: number;
}

export type PlaylistOrFolder =
  | { kind: "playlist"; data: Playlist }
  | { kind: "folder"; data: Folder };
