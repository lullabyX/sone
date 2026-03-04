use crate::SoneError;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

const TIDAL_AUTH_URL: &str = "https://auth.tidal.com/v1/oauth2";
const TIDAL_API_URL: &str = "https://api.tidal.com/v1";
const TIDAL_API_V2_URL: &str = "https://api.tidal.com/v2";
const TIDAL_CLIENT_VERSION: &str = "2025.11.3";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
    pub token_type: String,
    #[serde(default)]
    pub user_id: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetadata {
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalTrack {
    pub id: u64,
    pub title: String,
    pub duration: u32,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub artist: Option<TidalArtist>,
    /// Some endpoints return `artists` (plural array) instead of / in addition to `artist`.
    #[serde(default, skip_serializing)]
    artists: Option<Vec<TidalArtist>>,
    #[serde(default)]
    pub album: Option<TidalAlbum>,
    #[serde(default)]
    pub audio_quality: Option<String>,
    #[serde(default)]
    pub track_number: Option<u32>,
    #[serde(default)]
    pub volume_number: Option<u32>,
    #[serde(default)]
    pub date_added: Option<String>,
    #[serde(default)]
    pub isrc: Option<String>,
    #[serde(default)]
    pub explicit: Option<bool>,
    #[serde(default)]
    pub popularity: Option<u32>,
    #[serde(default)]
    pub replay_gain: Option<f64>,
    #[serde(default)]
    pub peak: Option<f64>,
    #[serde(default)]
    pub copyright: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub stream_ready: Option<bool>,
    #[serde(default)]
    pub allow_streaming: Option<bool>,
    #[serde(default)]
    pub premium_streaming_only: Option<bool>,
    #[serde(default)]
    pub stream_start_date: Option<String>,
    #[serde(default)]
    pub audio_modes: Option<Vec<String>>,
    #[serde(default)]
    pub media_metadata: Option<MediaMetadata>,
    /// Present on track detail responses — contains mix IDs like `TRACK_MIX`.
    #[serde(default)]
    pub mixes: Option<Value>,
}

impl TidalTrack {
    /// If `artist` is None but `artists` has entries, fill from the first element.
    pub fn backfill_artist(&mut self) {
        if self.artist.is_none() {
            if let Some(ref artists) = self.artists {
                if let Some(first) = artists.first() {
                    self.artist = Some(first.clone());
                }
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalAlbumDetail {
    pub id: u64,
    pub title: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub vibrant_color: Option<String>,
    #[serde(default)]
    pub video_cover: Option<String>,
    #[serde(default)]
    pub artist: Option<TidalArtist>,
    /// v2 API returns "artists" (plural array) instead of "artist" (singular)
    #[serde(default)]
    pub artists: Option<Vec<TidalArtist>>,
    #[serde(default)]
    pub number_of_tracks: Option<u32>,
    #[serde(default)]
    pub number_of_videos: Option<u32>,
    #[serde(default)]
    pub number_of_volumes: Option<u32>,
    #[serde(default)]
    pub duration: Option<u32>,
    #[serde(default)]
    pub release_date: Option<String>,
    #[serde(default)]
    pub upc: Option<String>,
    /// "ALBUM" | "EP" | "SINGLE"
    #[serde(default, rename = "type")]
    pub album_type: Option<String>,
    #[serde(default)]
    pub copyright: Option<String>,
    #[serde(default)]
    pub explicit: Option<bool>,
    #[serde(default)]
    pub popularity: Option<u32>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub audio_quality: Option<String>,
    #[serde(default)]
    pub stream_ready: Option<bool>,
    #[serde(default)]
    pub allow_streaming: Option<bool>,
    #[serde(default)]
    pub stream_start_date: Option<String>,
    #[serde(default)]
    pub audio_modes: Option<Vec<String>>,
    #[serde(default)]
    pub media_metadata: Option<MediaMetadata>,
}

impl TidalAlbumDetail {
    /// Backfill `artist` from `artists[0]` if `artist` is None (v2 API uses plural `artists`)
    pub fn backfill_artist(&mut self) {
        if self.artist.is_none() {
            if let Some(ref artists) = self.artists {
                if let Some(first) = artists.first() {
                    self.artist = Some(first.clone());
                }
            }
        }
    }
}

// ==================== Album Page types ====================

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AlbumPageResponse {
    pub album: TidalAlbumDetail,
    pub tracks: Vec<TidalTrack>,
    pub total_tracks: u32,
    pub vibrant_color: Option<String>,
    pub copyright: Option<String>,
    pub credits: Vec<TidalCredit>,
    pub review: Option<TidalReview>,
    pub sections: Vec<AlbumPageSection>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalReview {
    pub source: Option<String>,
    pub text: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AlbumPageSection {
    pub title: String,
    #[serde(rename(deserialize = "type", serialize = "sectionType"))]
    pub section_type: String,
    pub items: Vec<Value>,
    pub api_path: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedTracks {
    pub items: Vec<TidalTrack>,
    pub total_number_of_items: u32,
    pub offset: u32,
    pub limit: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AllFavoriteIds {
    pub tracks: Vec<u64>,
    pub albums: Vec<u64>,
    pub artists: Vec<u64>,
    pub playlists: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedResponse<T> {
    pub items: Vec<T>,
    pub total_number_of_items: u32,
    pub offset: u32,
    pub limit: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalArtist {
    pub id: u64,
    pub name: String,
    #[serde(default)]
    pub picture: Option<String>,
    /// "MAIN" | "FEATURED" — present on embedded artist refs in tracks/albums
    #[serde(default, rename = "type")]
    pub artist_type: Option<String>,
    #[serde(default)]
    pub handle: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalAlbum {
    pub id: u64,
    pub title: String,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub vibrant_color: Option<String>,
    #[serde(default)]
    pub video_cover: Option<String>,
    #[serde(default)]
    pub release_date: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalPlaylistCreator {
    pub id: Option<u64>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalPlaylistRaw {
    pub uuid: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub square_image: Option<String>,
    #[serde(default)]
    pub number_of_tracks: Option<u32>,
    #[serde(default)]
    pub number_of_videos: Option<u32>,
    #[serde(default)]
    pub creator: Option<TidalPlaylistCreator>,
    /// "USER" | "EDITORIAL" | "ARTIST"
    #[serde(default, rename = "type")]
    pub playlist_type: Option<String>,
    #[serde(default)]
    pub duration: Option<u32>,
    #[serde(default)]
    pub popularity: Option<u32>,
    #[serde(default)]
    pub public_playlist: Option<bool>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub created: Option<String>,
    #[serde(default)]
    pub last_updated: Option<String>,
    #[serde(default)]
    pub last_item_added_at: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalPlaylist {
    pub uuid: String,
    pub title: String,
    pub description: Option<String>,
    pub image: Option<String>,
    pub number_of_tracks: Option<u32>,
    pub creator: Option<TidalPlaylistCreator>,
    /// "USER" | "EDITORIAL" | "ARTIST"
    #[serde(default)]
    pub playlist_type: Option<String>,
    #[serde(default)]
    pub duration: Option<u32>,
    #[serde(default)]
    pub last_updated: Option<String>,
}

impl From<TidalPlaylistRaw> for TidalPlaylist {
    fn from(raw: TidalPlaylistRaw) -> Self {
        TidalPlaylist {
            uuid: raw.uuid,
            title: raw.title,
            description: raw.description,
            // Prefer squareImage, fallback to image
            image: raw.square_image.or(raw.image),
            number_of_tracks: raw.number_of_tracks,
            creator: raw.creator,
            playlist_type: raw.playlist_type,
            duration: raw.duration,
            last_updated: raw.last_updated,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalLyrics {
    #[serde(default)]
    pub track_id: Option<u64>,
    #[serde(default)]
    pub lyrics_provider: Option<String>,
    #[serde(default)]
    pub provider_commontrack_id: Option<String>,
    #[serde(default)]
    pub provider_lyrics_id: Option<String>,
    #[serde(default)]
    pub lyrics: Option<String>,
    #[serde(default)]
    pub subtitles: Option<String>,
    #[serde(default)]
    pub is_right_to_left: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TidalContributor {
    pub name: String,
    #[serde(default)]
    pub id: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TidalCredit {
    #[serde(rename(deserialize = "type", serialize = "creditType"))]
    pub credit_type: String,
    #[serde(default)]
    pub contributors: Vec<TidalContributor>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub url: String,
    #[serde(default)]
    pub codec: Option<String>,
    #[serde(default)]
    pub bit_depth: Option<u32>,
    #[serde(default)]
    pub sample_rate: Option<u32>,
    #[serde(default)]
    pub audio_quality: Option<String>,
    /// "STEREO" | "DOLBY_ATMOS"
    #[serde(default)]
    pub audio_mode: Option<String>,
    /// "FULL" | "PREVIEW"
    #[serde(default)]
    pub asset_presentation: Option<String>,
    /// Raw MPD/DASH manifest XML when the stream is DASH.
    /// `None` for BTS (single-URL) streams.
    #[serde(default)]
    pub manifest: Option<String>,
    /// "application/dash+xml" | "application/vnd.tidal.bts"
    #[serde(default)]
    pub manifest_mime_type: Option<String>,
    #[serde(default)]
    pub manifest_hash: Option<String>,
    #[serde(default)]
    pub track_id: Option<u64>,
    #[serde(default)]
    pub album_replay_gain: Option<f64>,
    #[serde(default)]
    pub album_peak_amplitude: Option<f64>,
    #[serde(default)]
    pub track_replay_gain: Option<f64>,
    #[serde(default)]
    pub track_peak_amplitude: Option<f64>,
}

// ==================== v2 Home Feed MIX types ====================
// These structs document the v2 MIX shape. Not yet consumed by backend code
// (home feed items pass through as raw Value), but available for future typed parsing.

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MixTextInfo {
    #[serde(default)]
    pub color: Option<String>,
    pub text: String,
}

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MixImage {
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    pub url: String,
}

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MixImageRef {
    #[serde(default)]
    pub image_uuid: Option<String>,
    #[serde(default)]
    pub vibrant_color: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MixArtistRef {
    #[serde(default)]
    pub artist_id: Option<u64>,
    #[serde(default)]
    pub artist_name: Option<String>,
    #[serde(default)]
    pub artist_image: Option<MixImageRef>,
}

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MixTrackRef {
    #[serde(default)]
    pub track_id: Option<u64>,
    #[serde(default)]
    pub track_title: Option<String>,
    #[serde(default)]
    pub track_group: Option<String>,
    #[serde(default)]
    pub track_image: Option<MixImageRef>,
}

/// v2 home feed MIX entity — completely unique shape from other Tidal entities.
/// Returned in home/feed sections with type "MIX".
#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalMix {
    pub id: String,
    /// "TRACK_MIX" | "ARTIST_MIX" | "HISTORY_ALLTIME_MIX" | "HISTORY_MONTHLY_MIX" | "HISTORY_YEARLY_MIX"
    #[serde(default, rename = "type")]
    pub mix_type: Option<String>,
    #[serde(default)]
    pub title_text_info: Option<MixTextInfo>,
    #[serde(default)]
    pub subtitle_text_info: Option<MixTextInfo>,
    #[serde(default)]
    pub short_subtitle_text_info: Option<MixTextInfo>,
    #[serde(default)]
    pub description: Option<MixTextInfo>,
    #[serde(default)]
    pub mix_images: Option<Vec<MixImage>>,
    #[serde(default)]
    pub detail_mix_images: Option<Vec<MixImage>>,
    #[serde(default)]
    pub artist: Option<MixArtistRef>,
    #[serde(default)]
    pub track: Option<MixTrackRef>,
    #[serde(default)]
    pub content_behavior: Option<String>,
    #[serde(default)]
    pub country_code: Option<String>,
    #[serde(default)]
    pub is_stable_id: Option<bool>,
    #[serde(default)]
    pub sort_type: Option<String>,
    #[serde(default)]
    pub updated: Option<u64>,
    #[serde(default)]
    pub artifact_id_type: Option<String>,
}

// ==================== v2 Favorite Mixes types ====================

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FavoriteMixImageUrl {
    pub url: String,
}

/// Shape returned by /v2/favorites/mixes — different from the home feed MIX entity.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalFavoriteMix {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub sub_title: Option<String>,
    #[serde(default)]
    pub mix_type: Option<String>,
    #[serde(default)]
    pub images: Option<FavoriteMixImages>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "UPPERCASE")]
pub struct FavoriteMixImages {
    #[serde(default)]
    pub small: Option<FavoriteMixImageUrl>,
    #[serde(default)]
    pub medium: Option<FavoriteMixImageUrl>,
    #[serde(default)]
    pub large: Option<FavoriteMixImageUrl>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalSearchResults {
    pub artists: Vec<TidalArtist>,
    pub albums: Vec<TidalAlbumDetail>,
    pub tracks: Vec<TidalTrack>,
    pub playlists: Vec<TidalPlaylist>,
    #[serde(default)]
    pub top_hit_type: Option<String>,
    /// Ordered top hits from the v2 search API (mixed entity types, ranked by relevance)
    #[serde(default)]
    pub top_hits: Vec<DirectHitItem>,
}

// ==================== Suggestions / Mini-search ====================

/// A single direct hit from the v2 /suggestions/ endpoint.
/// Each hit is a typed entity (artist, album, track, playlist) rendered in API order.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirectHitItem {
    pub hit_type: String, // "ARTISTS", "ALBUMS", "TRACKS", "PLAYLISTS"
    // Common
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    // For tracks/albums: artist info
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist_name: Option<String>,
    // For tracks: album info
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album_cover: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number_of_tracks: Option<u32>,
}

impl DirectHitItem {
    /// Parse a JSON item with { "type": "ARTISTS"|"ALBUMS"|..., "value": {...} } into a DirectHitItem.
    /// Returns None if the type is unrecognized or value is missing.
    pub fn from_typed_value(item: &serde_json::Value) -> Option<Self> {
        let hit_type = item
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let val = item.get("value")?;

        match hit_type.as_str() {
            "ARTISTS" => Some(DirectHitItem {
                hit_type,
                id: val.get("id").and_then(|v| v.as_u64()),
                uuid: None,
                name: val.get("name").and_then(|v| v.as_str()).map(String::from),
                title: None,
                picture: val
                    .get("picture")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                cover: None,
                image: None,
                artist_name: None,
                album_id: None,
                album_title: None,
                album_cover: None,
                duration: None,
                number_of_tracks: None,
            }),
            "ALBUMS" => {
                let artist_name = val
                    .get("artists")
                    .and_then(|a| a.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|a| a.get("name").and_then(|v| v.as_str()))
                    .or_else(|| {
                        val.get("artist")
                            .and_then(|a| a.get("name").and_then(|v| v.as_str()))
                    })
                    .map(String::from);
                Some(DirectHitItem {
                    hit_type,
                    id: val.get("id").and_then(|v| v.as_u64()),
                    uuid: None,
                    name: None,
                    title: val.get("title").and_then(|v| v.as_str()).map(String::from),
                    picture: None,
                    cover: val.get("cover").and_then(|v| v.as_str()).map(String::from),
                    image: None,
                    artist_name,
                    album_id: None,
                    album_title: None,
                    album_cover: None,
                    duration: val
                        .get("duration")
                        .and_then(|v| v.as_u64())
                        .map(|d| d as u32),
                    number_of_tracks: val
                        .get("numberOfTracks")
                        .and_then(|v| v.as_u64())
                        .map(|n| n as u32),
                })
            }
            "TRACKS" => {
                let artist_name = val
                    .get("artists")
                    .and_then(|a| a.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|a| a.get("name").and_then(|v| v.as_str()))
                    .or_else(|| {
                        val.get("artist")
                            .and_then(|a| a.get("name").and_then(|v| v.as_str()))
                    })
                    .map(String::from);
                let album = val.get("album");
                Some(DirectHitItem {
                    hit_type,
                    id: val.get("id").and_then(|v| v.as_u64()),
                    uuid: None,
                    name: None,
                    title: val.get("title").and_then(|v| v.as_str()).map(String::from),
                    picture: None,
                    cover: None,
                    image: None,
                    artist_name,
                    album_id: album.and_then(|a| a.get("id").and_then(|v| v.as_u64())),
                    album_title: album
                        .and_then(|a| a.get("title").and_then(|v| v.as_str()))
                        .map(String::from),
                    album_cover: album
                        .and_then(|a| a.get("cover").and_then(|v| v.as_str()))
                        .map(String::from),
                    duration: val
                        .get("duration")
                        .and_then(|v| v.as_u64())
                        .map(|d| d as u32),
                    number_of_tracks: None,
                })
            }
            "PLAYLISTS" => Some(DirectHitItem {
                hit_type,
                id: None,
                uuid: val.get("uuid").and_then(|v| v.as_str()).map(String::from),
                name: None,
                title: val.get("title").and_then(|v| v.as_str()).map(String::from),
                picture: None,
                cover: None,
                image: val
                    .get("squareImage")
                    .and_then(|v| v.as_str())
                    .or_else(|| val.get("image").and_then(|v| v.as_str()))
                    .map(String::from),
                artist_name: None,
                album_id: None,
                album_title: None,
                album_cover: None,
                duration: None,
                number_of_tracks: val
                    .get("numberOfTracks")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as u32),
            }),
            _ => None,
        }
    }

    /// Parse an array of typed value items into Vec<DirectHitItem>, preserving order.
    pub fn parse_array(arr: &[serde_json::Value]) -> Vec<Self> {
        arr.iter().filter_map(Self::from_typed_value).collect()
    }
}

/// A text suggestion item (history or autocomplete).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionTextItem {
    pub query: String,
    pub source: String, // "history" or "suggestion"
}

/// Full response from the suggestions endpoint, powering the mini-search dropdown.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionsResponse {
    pub text_suggestions: Vec<SuggestionTextItem>,
    pub direct_hits: Vec<DirectHitItem>,
}

// ==================== Home Page / Pages API ====================

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalArtistRole {
    pub category: String,
    pub category_id: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalArtistDetail {
    pub id: u64,
    pub name: String,
    #[serde(default)]
    pub picture: Option<String>,
    #[serde(default)]
    pub handle: Option<String>,
    #[serde(default)]
    pub user_id: Option<u64>,
    #[serde(default)]
    pub popularity: Option<u32>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub spotlighted: Option<bool>,
    #[serde(default)]
    pub artist_types: Option<Vec<String>>,
    #[serde(default)]
    pub artist_roles: Option<Vec<TidalArtistRole>>,
    #[serde(default)]
    pub mixes: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HomePageSection {
    pub title: String,
    pub section_type: String,
    pub items: Value,
    #[serde(default)]
    pub has_more: bool,
    #[serde(default)]
    pub api_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct HomePageResponse {
    pub sections: Vec<HomePageSection>,
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuthResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
}

pub struct TidalClient {
    client: Client,
    pub tokens: Option<AuthTokens>,
    pub client_id: String,
    pub client_secret: String,
    /// The user's country code from their Tidal session (e.g. "US", "GB", "DE").
    /// Populated after authentication via get_session_info().
    pub country_code: String,
}

impl TidalClient {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap(),
            tokens: None,
            client_id: String::new(),
            client_secret: String::new(),
            country_code: "US".to_string(),
        }
    }

    pub fn set_credentials(&mut self, client_id: &str, client_secret: &str) {
        self.client_id = client_id.to_string();
        self.client_secret = client_secret.to_string();
    }

    pub async fn refresh_token(&mut self) -> Result<AuthTokens, SoneError> {
        if self.client_id.is_empty() {
            return Err(SoneError::NotConfigured("Client ID".into()));
        }

        let current_tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;
        let refresh_tok = current_tokens.refresh_token.clone();
        let old_user_id = current_tokens.user_id;

        // Build params — include client_secret only if available
        let mut form_params = vec![
            ("client_id", self.client_id.as_str()),
            ("refresh_token", refresh_tok.as_str()),
            ("grant_type", "refresh_token"),
            ("scope", "r_usr w_usr w_sub"),
        ];
        if !self.client_secret.is_empty() {
            form_params.push(("client_secret", self.client_secret.as_str()));
        }

        let response = self
            .client
            .post(format!("{}/token", TIDAL_AUTH_URL))
            .form(&form_params)
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        // Tidal's refresh response may not include refresh_token, so use a
        // permissive struct and fall back to the existing refresh token.
        #[derive(Deserialize)]
        struct RefreshResponse {
            access_token: String,
            #[serde(default)]
            refresh_token: Option<String>,
            expires_in: u64,
            token_type: String,
            #[serde(default)]
            user_id: Option<u64>,
        }

        let parsed = serde_json::from_str::<RefreshResponse>(&body)
            .map_err(|e| SoneError::Parse(format!("{} - Body: {}", e, body)))?;

        let new_tokens = AuthTokens {
            access_token: parsed.access_token,
            refresh_token: parsed.refresh_token.unwrap_or(refresh_tok),
            expires_in: parsed.expires_in,
            token_type: parsed.token_type,
            user_id: parsed.user_id.or(old_user_id),
        };

        self.tokens = Some(new_tokens.clone());
        Ok(new_tokens)
    }

    /// Perform an authenticated GET, check status, and deserialize the JSON body.
    /// Use for endpoints where the response maps directly to `T` with no post-processing.
    async fn api_get<T: serde::de::DeserializeOwned>(
        &mut self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T, SoneError> {
        let body = self.api_get_body(path, query).await?;
        serde_json::from_str(&body).map_err(|e| {
            SoneError::Parse(format!("{} - Body: {}", e, &body[..body.len().min(500)]))
        })
    }

    /// Perform an authenticated GET, check status, and return the raw body string.
    /// Use for endpoints that need custom post-processing after status validation.
    async fn api_get_body(
        &mut self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<String, SoneError> {
        let url = if path.starts_with("http") {
            path.to_string()
        } else {
            format!("{}{}", TIDAL_API_URL, path)
        };
        let response = self.authenticated_get(&url, query).await?;
        let resp_url = response.url().to_string();
        if url != resp_url && !resp_url.starts_with(&url) {
            log::warn!(
                "[api_get_body] possible redirect: requested={} responded={}",
                url,
                resp_url
            );
        }
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            log::error!(
                "[api_get_body] {} -> status={} body={}",
                url,
                status,
                &body[..body.len().min(500)]
            );
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }
        Ok(body)
    }

    /// Helper to perform an authenticated GET request with automatic token refresh on 401.
    async fn authenticated_get(
        &mut self,
        url: &str,
        query: &[(&str, &str)],
    ) -> Result<reqwest::Response, SoneError> {
        // 1. Get current token (clone to avoid borrow)
        let access_token = self
            .tokens
            .as_ref()
            .ok_or(SoneError::NotAuthenticated)?
            .access_token
            .clone();

        // 2. Make first request
        let mut req = self
            .client
            .get(url)
            .header("Authorization", format!("Bearer {}", access_token));
        if url.contains("/v2/") {
            req = req.header("x-tidal-client-version", TIDAL_CLIENT_VERSION);
        }
        let response = req.query(query).send().await?;

        // 3. Check 401
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            log::debug!("Got 401 from {}, attempting refresh...", url);
            // 4. Refresh token (requires &mut self)
            let new_tokens = self.refresh_token().await?;
            log::debug!("Refresh successful, retrying request...");

            // 5. Retry request
            let mut req = self.client.get(url).header(
                "Authorization",
                format!("Bearer {}", new_tokens.access_token),
            );
            if url.contains("/v2/") {
                req = req.header("x-tidal-client-version", TIDAL_CLIENT_VERSION);
            }
            return Ok(req.query(query).send().await?);
        }

        Ok(response)
    }

    pub async fn start_device_auth(&self) -> Result<DeviceAuthResponse, SoneError> {
        if self.client_id.is_empty() {
            return Err(SoneError::NotConfigured("Client ID".into()));
        }

        let mut form_params = vec![
            ("client_id", self.client_id.as_str()),
            ("scope", "r_usr w_usr w_sub"),
        ];
        if !self.client_secret.is_empty() {
            form_params.push(("client_secret", self.client_secret.as_str()));
        }

        let response = self
            .client
            .post(format!("{}/device_authorization", TIDAL_AUTH_URL))
            .form(&form_params)
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            // Detect "not a Limited Input Device client" error and give a clear message
            if body.contains("not a Limited Input Device client")
                || body.contains("sub_status\":1002")
            {
                return Err(SoneError::Api {
                    status: status.as_u16(),
                    body: "This Client ID does not support the Device Code flow. \
                           It is likely a web player Client ID. \
                           Please use \"Token Import\" instead, or use a native app (Android/desktop) Client ID."
                        .to_string(),
                });
            }
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        serde_json::from_str::<DeviceAuthResponse>(&body)
            .map_err(|e| SoneError::Parse(format!("{} - Body: {}", e, body)))
    }

    pub async fn poll_device_token(
        &mut self,
        device_code: &str,
    ) -> Result<Option<AuthTokens>, SoneError> {
        if self.client_id.is_empty() {
            return Err(SoneError::NotConfigured("Client ID".into()));
        }

        let mut form_params = vec![
            ("client_id", self.client_id.as_str()),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("scope", "r_usr w_usr w_sub"),
        ];
        if !self.client_secret.is_empty() {
            form_params.push(("client_secret", self.client_secret.as_str()));
        }

        let response = self
            .client
            .post(format!("{}/token", TIDAL_AUTH_URL))
            .form(&form_params)
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        // 400 with "authorization_pending" or "slow_down" means user hasn't authorized yet
        if status.as_u16() == 400
            && (body.contains("authorization_pending") || body.contains("slow_down"))
        {
            return Ok(None); // Still waiting -- caller should retry
        }

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        let tokens = serde_json::from_str::<AuthTokens>(&body)
            .map_err(|e| SoneError::Parse(format!("{} - Body: {}", e, body)))?;

        self.tokens = Some(tokens.clone());
        Ok(Some(tokens))
    }

    pub async fn exchange_pkce_code(
        &mut self,
        code: &str,
        code_verifier: &str,
        redirect_uri: &str,
        client_unique_key: &str,
    ) -> Result<AuthTokens, SoneError> {
        if self.client_id.is_empty() {
            return Err(SoneError::NotConfigured("Client ID".into()));
        }

        let response = self
            .client
            .post(format!("{}/token", TIDAL_AUTH_URL))
            .form(&[
                ("code", code),
                ("client_id", self.client_id.as_str()),
                ("grant_type", "authorization_code"),
                ("redirect_uri", redirect_uri),
                ("scope", "r_usr+w_usr+w_sub"),
                ("code_verifier", code_verifier),
                ("client_unique_key", client_unique_key),
            ])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        let tokens = serde_json::from_str::<AuthTokens>(&body)
            .map_err(|e| SoneError::Parse(format!("{} - Body: {}", e, body)))?;

        self.tokens = Some(tokens.clone());
        Ok(tokens)
    }

    pub async fn get_user_profile(
        &mut self,
        user_id: u64,
    ) -> Result<(String, Option<String>), SoneError> {
        let cc = self.country_code.clone();
        let body = self
            .api_get_body(&format!("/users/{}", user_id), &[("countryCode", &cc)])
            .await?;

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct UserProfile {
            #[serde(default)]
            first_name: Option<String>,
            #[serde(default)]
            last_name: Option<String>,
            #[serde(default)]
            username: Option<String>,
        }

        let data: UserProfile =
            serde_json::from_str(&body).map_err(|e| SoneError::Parse(e.to_string()))?;
        let username = data.username.clone();
        let name = match (&data.first_name, &data.last_name) {
            (Some(f), Some(l)) if !f.is_empty() => format!("{} {}", f, l),
            (Some(f), _) if !f.is_empty() => f.clone(),
            _ => username.clone().unwrap_or_else(|| "TIDAL User".to_string()),
        };
        Ok((name, username))
    }

    pub async fn get_session_info(&mut self) -> Result<u64, SoneError> {
        let body = self.api_get_body("/sessions", &[]).await?;

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct SessionResponse {
            user_id: u64,
            #[serde(default)]
            country_code: Option<String>,
        }

        let data: SessionResponse =
            serde_json::from_str(&body).map_err(|e| SoneError::Parse(e.to_string()))?;

        // Store the user's country code for all subsequent API calls
        if let Some(cc) = data.country_code {
            if !cc.is_empty() {
                self.country_code = cc;
            }
        }
        Ok(data.user_id)
    }

    pub async fn get_user_playlists(
        &mut self,
        user_id: u64,
        offset: u32,
        limit: u32,
    ) -> Result<PaginatedResponse<TidalPlaylist>, SoneError> {
        let cc = self.country_code.clone();
        let limit_str = limit.to_string();
        let offset_str = offset.to_string();
        let body = self
            .api_get_body(
                &format!("/users/{}/playlists", user_id),
                &[
                    ("countryCode", &cc),
                    ("limit", &limit_str),
                    ("offset", &offset_str),
                ],
            )
            .await?;

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PlaylistResponse {
            items: Vec<TidalPlaylistRaw>,
            total_number_of_items: u32,
        }

        let data: PlaylistResponse = serde_json::from_str(&body)
            .map_err(|e| SoneError::Parse(format!("{} - Body: {}", e, body)))?;
        let playlists: Vec<TidalPlaylist> = data.items.into_iter().map(|p| p.into()).collect();
        Ok(PaginatedResponse {
            items: playlists,
            total_number_of_items: data.total_number_of_items,
            offset,
            limit,
        })
    }

    pub async fn create_playlist(
        &self,
        user_id: u64,
        title: &str,
        description: &str,
    ) -> Result<TidalPlaylist, SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;

        let response = self
            .client
            .post(format!("{}/users/{}/playlists", TIDAL_API_URL, user_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", self.country_code.as_str())])
            .form(&[("title", title), ("description", description)])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        let raw = serde_json::from_str::<TidalPlaylistRaw>(&body)
            .map_err(|e| SoneError::Parse(format!("{} - Body: {}", e, body)))?;

        Ok(raw.into())
    }

    pub async fn add_track_to_playlist(
        &self,
        playlist_id: &str,
        track_id: u64,
    ) -> Result<(), SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;

        // First, get the playlist ETag which is required for modifications
        let head_response = self
            .client
            .get(format!("{}/playlists/{}", TIDAL_API_URL, playlist_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", self.country_code.as_str())])
            .send()
            .await?;

        let etag = head_response
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("*")
            .to_string();

        // Add the track
        let response = self
            .client
            .post(format!("{}/playlists/{}/items", TIDAL_API_URL, playlist_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .header("If-None-Match", &etag)
            .query(&[("countryCode", self.country_code.as_str())])
            .form(&[
                ("trackIds", &track_id.to_string()),
                ("onDupes", &"FAIL".to_string()),
            ])
            .send()
            .await?;

        let status = response.status();

        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }

    pub async fn remove_track_from_playlist(
        &self,
        playlist_id: &str,
        index: u32,
    ) -> Result<(), SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;

        // First, get the playlist ETag which is required for modifications
        let head_response = self
            .client
            .get(format!("{}/playlists/{}", TIDAL_API_URL, playlist_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", self.country_code.as_str())])
            .send()
            .await?;

        let etag = head_response
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("*")
            .to_string();

        // Remove the track at the given index
        let response = self
            .client
            .delete(format!(
                "{}/playlists/{}/items/{}",
                TIDAL_API_URL, playlist_id, index
            ))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .header("If-None-Match", &etag)
            .query(&[("countryCode", self.country_code.as_str())])
            .send()
            .await?;

        let status = response.status();

        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }

    pub async fn delete_playlist(&self, playlist_id: &str) -> Result<(), SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;

        // First, get the playlist ETag which is required for modifications
        let head_response = self
            .client
            .get(format!("{}/playlists/{}", TIDAL_API_URL, playlist_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", self.country_code.as_str())])
            .send()
            .await?;

        let etag = head_response
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("*")
            .to_string();

        // Delete the playlist
        let response = self
            .client
            .delete(format!("{}/playlists/{}", TIDAL_API_URL, playlist_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .header("If-None-Match", &etag)
            .query(&[("countryCode", self.country_code.as_str())])
            .send()
            .await?;

        let status = response.status();

        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }

    pub async fn get_favorite_playlist_uuids(
        &self,
        user_id: u64,
    ) -> Result<Vec<String>, SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;
        let response = self
            .client
            .get(format!(
                "{}/users/{}/favorites/playlists",
                TIDAL_API_URL, user_id
            ))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[
                ("countryCode", self.country_code.as_str()),
                ("limit", "2000"),
                ("offset", "0"),
            ])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        #[derive(Deserialize)]
        struct FavItem {
            item: TidalPlaylistRaw,
        }
        #[derive(Deserialize)]
        struct FavResponse {
            #[serde(default)]
            items: Vec<FavItem>,
        }

        let data = serde_json::from_str::<FavResponse>(&body)
            .map_err(|e| SoneError::Parse(e.to_string()))?;

        Ok(data.items.into_iter().map(|f| f.item.uuid).collect())
    }

    pub async fn get_favorite_playlists(
        &mut self,
        user_id: u64,
        offset: u32,
        limit: u32,
    ) -> Result<PaginatedResponse<TidalPlaylist>, SoneError> {
        let cc = self.country_code.clone();
        let limit_str = limit.to_string();
        let offset_str = offset.to_string();
        let body = self
            .api_get_body(
                &format!("/users/{}/favorites/playlists", user_id),
                &[
                    ("countryCode", &cc),
                    ("limit", &limit_str),
                    ("offset", &offset_str),
                ],
            )
            .await?;

        #[derive(Deserialize)]
        struct FavEntry {
            item: TidalPlaylistRaw,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FavResponse {
            items: Vec<FavEntry>,
            total_number_of_items: u32,
        }

        let data: FavResponse = serde_json::from_str(&body)
            .map_err(|e| SoneError::Parse(format!("{} - Body: {}", e, body)))?;
        let playlists: Vec<TidalPlaylist> = data.items.into_iter().map(|e| e.item.into()).collect();
        Ok(PaginatedResponse {
            items: playlists,
            total_number_of_items: data.total_number_of_items,
            offset,
            limit,
        })
    }

    pub async fn get_playlist_tracks(
        &mut self,
        playlist_id: &str,
    ) -> Result<Vec<TidalTrack>, SoneError> {
        let path = format!("/playlists/{}/tracks", playlist_id);

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct TracksResponse {
            items: Vec<TidalTrack>,
            total_number_of_items: u32,
        }

        let mut all_tracks: Vec<TidalTrack> = Vec::new();
        let mut offset: u32 = 0;
        let page_size: u32 = 100;

        loop {
            let cc = self.country_code.clone();
            let offset_str = offset.to_string();
            let limit_str = page_size.to_string();
            let body = self
                .api_get_body(
                    &path,
                    &[
                        ("countryCode", &cc),
                        ("limit", &limit_str),
                        ("offset", &offset_str),
                    ],
                )
                .await?;

            let mut data: TracksResponse = serde_json::from_str(&body)
                .map_err(|e| SoneError::Parse(format!("{} - Body: {}", e, body)))?;

            let fetched = data.items.len() as u32;
            for t in &mut data.items {
                t.backfill_artist();
            }
            all_tracks.append(&mut data.items);

            if fetched == 0 || all_tracks.len() as u32 >= data.total_number_of_items {
                break;
            }
            offset += fetched;
        }

        Ok(all_tracks)
    }

    pub async fn get_playlist_tracks_page(
        &mut self,
        playlist_id: &str,
        offset: u32,
        limit: u32,
    ) -> Result<PaginatedTracks, SoneError> {
        let cc = self.country_code.clone();
        let limit_str = limit.to_string();
        let offset_str = offset.to_string();
        let body = self
            .api_get_body(
                &format!("/playlists/{}/tracks", playlist_id),
                &[
                    ("countryCode", &cc),
                    ("limit", &limit_str),
                    ("offset", &offset_str),
                ],
            )
            .await?;

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct TracksResponse {
            items: Vec<TidalTrack>,
            total_number_of_items: u32,
            #[serde(default)]
            offset: u32,
            #[serde(default)]
            limit: u32,
        }

        let mut data: TracksResponse = serde_json::from_str(&body)
            .map_err(|e| SoneError::Parse(format!("{} - Body: {}", e, body)))?;
        for t in &mut data.items {
            t.backfill_artist();
        }
        Ok(PaginatedTracks {
            items: data.items,
            total_number_of_items: data.total_number_of_items,
            offset: data.offset,
            limit: data.limit,
        })
    }

    pub async fn get_album_detail(&mut self, album_id: u64) -> Result<TidalAlbumDetail, SoneError> {
        let cc = self.country_code.clone();
        self.api_get(&format!("/albums/{}", album_id), &[("countryCode", &cc)])
            .await
    }

    pub async fn get_album_tracks(
        &mut self,
        album_id: u64,
        offset: u32,
        limit: u32,
    ) -> Result<PaginatedTracks, SoneError> {
        let cc = self.country_code.clone();
        let limit_str = limit.to_string();
        let offset_str = offset.to_string();
        let body = self
            .api_get_body(
                &format!("/albums/{}/tracks", album_id),
                &[
                    ("countryCode", &cc),
                    ("limit", &limit_str),
                    ("offset", &offset_str),
                ],
            )
            .await?;

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct AlbumTracksResponse {
            items: Vec<TidalTrack>,
            total_number_of_items: u32,
            #[serde(default)]
            offset: u32,
            #[serde(default)]
            limit: u32,
        }

        let mut data: AlbumTracksResponse = serde_json::from_str(&body)
            .map_err(|e| SoneError::Parse(format!("{} - Body: {}", e, body)))?;
        for t in &mut data.items {
            t.backfill_artist();
        }
        Ok(PaginatedTracks {
            items: data.items,
            total_number_of_items: data.total_number_of_items,
            offset: data.offset,
            limit: data.limit,
        })
    }

    pub async fn get_favorite_tracks(
        &mut self,
        user_id: u64,
        offset: u32,
        limit: u32,
    ) -> Result<PaginatedTracks, SoneError> {
        let cc = self.country_code.clone();
        let limit_str = limit.to_string();
        let offset_str = offset.to_string();
        let body = self
            .api_get_body(
                &format!("/users/{}/favorites/tracks", user_id),
                &[
                    ("countryCode", &cc),
                    ("limit", &limit_str),
                    ("offset", &offset_str),
                    ("order", "DATE"),
                    ("orderDirection", "DESC"),
                ],
            )
            .await?;

        #[derive(Deserialize)]
        struct FavoriteTrackItem {
            item: TidalTrack,
            created: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FavoriteTracksResponse {
            items: Vec<FavoriteTrackItem>,
            total_number_of_items: u32,
            #[serde(default)]
            offset: u32,
            #[serde(default)]
            limit: u32,
        }

        let data: FavoriteTracksResponse = serde_json::from_str(&body)
            .map_err(|e| SoneError::Parse(format!("{} - Body: {}", e, body)))?;
        Ok(PaginatedTracks {
            items: data
                .items
                .into_iter()
                .map(|f| {
                    let mut t = f.item;
                    t.backfill_artist();
                    t.date_added = Some(f.created);
                    t
                })
                .collect(),
            total_number_of_items: data.total_number_of_items,
            offset: data.offset,
            limit: data.limit,
        })
    }

    pub async fn is_track_favorited(&self, user_id: u64, track_id: u64) -> Result<bool, SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;
        let response = self
            .client
            .get(format!(
                "{}/users/{}/favorites/tracks",
                TIDAL_API_URL, user_id
            ))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[
                ("countryCode", self.country_code.as_str()),
                ("limit", "2000"),
                ("offset", "0"),
                ("order", "DATE"),
                ("orderDirection", "DESC"),
            ])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        #[derive(Deserialize)]
        struct FavoriteTrackItem {
            #[serde(default)]
            id: Option<u64>,
            #[serde(default)]
            item: Option<TidalTrack>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FavoriteTracksResponse {
            #[serde(default)]
            items: Vec<FavoriteTrackItem>,
        }

        let data = serde_json::from_str::<FavoriteTracksResponse>(&body)
            .map_err(|e| SoneError::Parse(format!("{} - Body: {}", e, body)))?;

        Ok(data.items.iter().any(|entry| {
            entry.id == Some(track_id)
                || entry
                    .item
                    .as_ref()
                    .is_some_and(|track| track.id == track_id)
        }))
    }

    pub async fn get_favorite_track_ids(&self, user_id: u64) -> Result<Vec<u64>, SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;
        let response = self
            .client
            .get(format!(
                "{}/users/{}/favorites/tracks",
                TIDAL_API_URL, user_id
            ))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[
                ("countryCode", self.country_code.as_str()),
                ("limit", "2000"),
                ("offset", "0"),
                ("order", "DATE"),
                ("orderDirection", "DESC"),
            ])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        #[derive(Deserialize)]
        struct FavItem {
            item: TidalTrack,
        }

        #[derive(Deserialize)]
        struct FavResponse {
            #[serde(default)]
            items: Vec<FavItem>,
        }

        let data = serde_json::from_str::<FavResponse>(&body)
            .map_err(|e| SoneError::Parse(e.to_string()))?;

        Ok(data.items.into_iter().map(|f| f.item.id).collect())
    }

    pub async fn add_favorite_track(&self, user_id: u64, track_id: u64) -> Result<(), SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;
        let track_id_str = track_id.to_string();

        let response = self
            .client
            .post(format!(
                "{}/users/{}/favorites/tracks",
                TIDAL_API_URL, user_id
            ))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", self.country_code.as_str())])
            .form(&[("trackId", track_id_str.as_str())])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }

    pub async fn remove_favorite_track(
        &self,
        user_id: u64,
        track_id: u64,
    ) -> Result<(), SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;

        let response = self
            .client
            .delete(format!(
                "{}/users/{}/favorites/tracks/{}",
                TIDAL_API_URL, user_id, track_id
            ))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", self.country_code.as_str())])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }

    pub async fn is_album_favorited(&self, user_id: u64, album_id: u64) -> Result<bool, SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;
        let response = self
            .client
            .get(format!(
                "{}/users/{}/favorites/albums",
                TIDAL_API_URL, user_id
            ))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[
                ("countryCode", self.country_code.as_str()),
                ("limit", "2000"),
                ("offset", "0"),
                ("order", "DATE"),
                ("orderDirection", "DESC"),
            ])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        #[derive(Deserialize)]
        struct FavoriteAlbumItem {
            #[serde(default)]
            id: Option<u64>,
            #[serde(default)]
            item: Option<TidalAlbum>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FavoriteAlbumsResponse {
            #[serde(default)]
            items: Vec<FavoriteAlbumItem>,
        }

        let data = serde_json::from_str::<FavoriteAlbumsResponse>(&body)
            .map_err(|e| SoneError::Parse(format!("{} - Body: {}", e, body)))?;

        Ok(data.items.iter().any(|entry| {
            entry.id == Some(album_id)
                || entry
                    .item
                    .as_ref()
                    .is_some_and(|album| album.id == album_id)
        }))
    }

    pub async fn get_favorite_album_ids(&self, user_id: u64) -> Result<Vec<u64>, SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;
        let response = self
            .client
            .get(format!(
                "{}/users/{}/favorites/albums",
                TIDAL_API_URL, user_id
            ))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[
                ("countryCode", self.country_code.as_str()),
                ("limit", "2000"),
                ("offset", "0"),
                ("order", "DATE"),
                ("orderDirection", "DESC"),
            ])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        #[derive(Deserialize)]
        struct FavAlbumItem {
            #[serde(default)]
            item: Option<TidalAlbum>,
        }

        #[derive(Deserialize)]
        struct FavAlbumResponse {
            #[serde(default)]
            items: Vec<FavAlbumItem>,
        }

        let data = serde_json::from_str::<FavAlbumResponse>(&body)
            .map_err(|e| SoneError::Parse(e.to_string()))?;

        Ok(data
            .items
            .into_iter()
            .filter_map(|f| f.item.map(|a| a.id))
            .collect())
    }

    pub async fn add_favorite_album(&self, user_id: u64, album_id: u64) -> Result<(), SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;
        let album_id_str = album_id.to_string();

        let response = self
            .client
            .post(format!(
                "{}/users/{}/favorites/albums",
                TIDAL_API_URL, user_id
            ))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", self.country_code.as_str())])
            .form(&[("albumId", album_id_str.as_str())])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }

    pub async fn remove_favorite_album(
        &self,
        user_id: u64,
        album_id: u64,
    ) -> Result<(), SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;

        let response = self
            .client
            .delete(format!(
                "{}/users/{}/favorites/albums/{}",
                TIDAL_API_URL, user_id, album_id
            ))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", self.country_code.as_str())])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }

    pub async fn add_favorite_playlist(
        &self,
        user_id: u64,
        playlist_uuid: &str,
    ) -> Result<(), SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;

        let response = self
            .client
            .post(format!(
                "{}/users/{}/favorites/playlists",
                TIDAL_API_URL, user_id
            ))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", self.country_code.as_str())])
            .form(&[("uuid", playlist_uuid)])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }

    pub async fn remove_favorite_playlist(
        &self,
        user_id: u64,
        playlist_uuid: &str,
    ) -> Result<(), SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;

        let response = self
            .client
            .delete(format!(
                "{}/users/{}/favorites/playlists/{}",
                TIDAL_API_URL, user_id, playlist_uuid
            ))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", self.country_code.as_str())])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }

    pub async fn get_favorite_artist_ids(&self, user_id: u64) -> Result<Vec<u64>, SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;
        let response = self
            .client
            .get(format!(
                "{}/users/{}/favorites/artists",
                TIDAL_API_URL, user_id
            ))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[
                ("countryCode", self.country_code.as_str()),
                ("limit", "2000"),
                ("offset", "0"),
                ("order", "DATE"),
                ("orderDirection", "DESC"),
            ])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        #[derive(Deserialize)]
        struct FavItem {
            item: TidalArtistDetail,
        }
        #[derive(Deserialize)]
        struct FavResponse {
            #[serde(default)]
            items: Vec<FavItem>,
        }

        let data = serde_json::from_str::<FavResponse>(&body)
            .map_err(|e| SoneError::Parse(e.to_string()))?;

        Ok(data.items.into_iter().map(|f| f.item.id).collect())
    }

    pub async fn get_all_favorite_ids(&self, user_id: u64) -> Result<AllFavoriteIds, SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;
        let response = self
            .client
            .get(format!("{}/users/{}/favorites/ids", TIDAL_API_URL, user_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[
                ("countryCode", self.country_code.as_str()),
                ("locale", "en_US"),
                ("deviceType", "BROWSER"),
            ])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        let raw: std::collections::HashMap<String, Vec<String>> =
            serde_json::from_str(&body).map_err(|e| SoneError::Parse(e.to_string()))?;

        let parse_u64s = |key: &str| -> Vec<u64> {
            raw.get(key)
                .map(|v| v.iter().filter_map(|s| s.parse::<u64>().ok()).collect())
                .unwrap_or_default()
        };

        Ok(AllFavoriteIds {
            tracks: parse_u64s("TRACK"),
            albums: parse_u64s("ALBUM"),
            artists: parse_u64s("ARTIST"),
            playlists: raw.get("PLAYLIST").cloned().unwrap_or_default(),
        })
    }

    pub async fn add_favorite_artist(&self, user_id: u64, artist_id: u64) -> Result<(), SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;
        let artist_id_str = artist_id.to_string();

        let response = self
            .client
            .post(format!(
                "{}/users/{}/favorites/artists",
                TIDAL_API_URL, user_id
            ))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", self.country_code.as_str())])
            .form(&[("artistId", artist_id_str.as_str())])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }

    pub async fn remove_favorite_artist(
        &self,
        user_id: u64,
        artist_id: u64,
    ) -> Result<(), SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;

        let response = self
            .client
            .delete(format!(
                "{}/users/{}/favorites/artists/{}",
                TIDAL_API_URL, user_id, artist_id
            ))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", self.country_code.as_str())])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }

    pub async fn add_favorite_mix(&self, mix_id: &str) -> Result<(), SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;

        log::debug!("[add_favorite_mix]: mix_id={}", mix_id);

        let response = self
            .client
            .put(format!("{}/favorites/mixes/add", TIDAL_API_V2_URL))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[
                ("countryCode", self.country_code.as_str()),
                ("mixIds", mix_id),
                ("onArtifactNotFound", "FAIL"),
            ])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        log::debug!(
            "[add_favorite_mix]: status={}, body={}",
            status,
            &body[..body.len().min(500)]
        );

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }

    pub async fn remove_favorite_mix(&self, mix_id: &str) -> Result<(), SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;

        log::debug!("[remove_favorite_mix]: mix_id={}", mix_id);

        let response = self
            .client
            .put(format!("{}/favorites/mixes/remove", TIDAL_API_V2_URL))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[
                ("countryCode", self.country_code.as_str()),
                ("mixIds", mix_id),
            ])
            .send()
            .await?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        log::debug!(
            "[remove_favorite_mix]: status={}, body={}",
            status,
            &body[..body.len().min(500)]
        );

        if !status.is_success() {
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }

    /// Fetch favorite mix IDs from api.tidal.com/v2/favorites/mixes.
    pub async fn get_favorite_mix_ids(&mut self) -> Result<Vec<String>, SoneError> {
        let response = self.get_favorite_mixes(0, 50).await?;
        let ids: Vec<String> = response.items.iter().map(|m| m.id.clone()).collect();
        log::debug!("[get_favorite_mix_ids]: found {} mix IDs", ids.len());
        Ok(ids)
    }

    /// Fetch full favorite mix objects from api.tidal.com/v2/favorites/mixes.
    pub async fn get_favorite_mixes(
        &mut self,
        offset: u32,
        limit: u32,
    ) -> Result<PaginatedResponse<TidalFavoriteMix>, SoneError> {
        let url = format!("{}/favorites/mixes", TIDAL_API_V2_URL);
        let cc = self.country_code.clone();
        let limit_str = limit.to_string();
        let offset_str = offset.to_string();
        let body = self
            .api_get_body(
                &url,
                &[
                    ("countryCode", &cc),
                    ("locale", "en_US"),
                    ("deviceType", "BROWSER"),
                    ("limit", &limit_str),
                    ("offset", &offset_str),
                ],
            )
            .await?;

        log::debug!(
            "[get_favorite_mixes]: body_preview={}",
            &body[..body.len().min(500)]
        );

        // v2 response is a wrapper object { items: [...] }; extract the inner array as raw Values first
        let raw_items: Vec<serde_json::Value> =
            if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&body) {
                arr
            } else if let Ok(obj) = serde_json::from_str::<serde_json::Value>(&body) {
                obj.get("items")
                    .or_else(|| obj.get("data"))
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default()
            } else {
                log::warn!(
                    "[get_favorite_mixes]: parse failed - body: {}",
                    &body[..body.len().min(500)]
                );
                Vec::new()
            };

        // Deserialize each item, skipping any that fail to parse
        let items: Vec<TidalFavoriteMix> = raw_items
            .into_iter()
            .filter_map(|v| serde_json::from_value::<TidalFavoriteMix>(v).ok())
            .collect();

        let count = items.len() as u32;
        log::debug!("[get_favorite_mixes]: found {} mixes", count);
        // v2 API doesn't return totalNumberOfItems — this is a synthetic sentinel for hasMore logic only, not a displayable count
        let estimated_total = if count == limit {
            offset + count + 1
        } else {
            offset + count
        };
        Ok(PaginatedResponse {
            items,
            total_number_of_items: estimated_total,
            offset,
            limit,
        })
    }

    pub async fn add_tracks_to_playlist(
        &self,
        playlist_id: &str,
        track_ids: &[u64],
    ) -> Result<(), SoneError> {
        let tokens = self.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;

        // Get the playlist ETag which is required for modifications
        let head_response = self
            .client
            .get(format!("{}/playlists/{}", TIDAL_API_URL, playlist_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", self.country_code.as_str())])
            .send()
            .await?;

        let etag = head_response
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("*")
            .to_string();

        let ids_str = track_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");

        let response = self
            .client
            .post(format!("{}/playlists/{}/items", TIDAL_API_URL, playlist_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .header("If-None-Match", &etag)
            .query(&[("countryCode", self.country_code.as_str())])
            .form(&[("trackIds", ids_str.as_str()), ("onDupes", "SKIP")])
            .send()
            .await?;

        let status = response.status();

        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(SoneError::Api {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }

    pub async fn get_stream_url(
        &mut self,
        track_id: u64,
        quality: &str,
    ) -> Result<StreamInfo, SoneError> {
        let cc = self.country_code.clone();
        let body = self
            .api_get_body(
                &format!("/tracks/{}/playbackinfopostpaywall", track_id),
                &[
                    ("countryCode", &cc),
                    ("audioquality", quality),
                    ("playbackmode", "STREAM"),
                    ("assetpresentation", "FULL"),
                ],
            )
            .await?;

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PlaybackInfo {
            manifest_mime_type: String,
            manifest: String,
            #[serde(default)]
            audio_quality: Option<String>,
            #[serde(default)]
            bit_depth: Option<u32>,
            #[serde(default)]
            sample_rate: Option<u32>,
            #[serde(default)]
            album_replay_gain: Option<f64>,
            #[serde(default)]
            album_peak_amplitude: Option<f64>,
            #[serde(default)]
            track_replay_gain: Option<f64>,
            #[serde(default)]
            track_peak_amplitude: Option<f64>,
        }

        let data = serde_json::from_str::<PlaybackInfo>(&body)
            .map_err(|e| SoneError::Parse(format!("{} - Body: {}", e, body)))?;

        use base64::Engine;
        let manifest_bytes = base64::engine::general_purpose::STANDARD
            .decode(&data.manifest)
            .map_err(|e| SoneError::Parse(format!("Failed to decode manifest: {}", e)))?;
        let manifest_str = String::from_utf8(manifest_bytes)
            .map_err(|e| SoneError::Parse(format!("Invalid manifest encoding: {}", e)))?;

        let mut codec: Option<String> = None;

        // Handle BTS format (JSON with urls array)
        let url = if data.manifest_mime_type.contains("vnd.tidal.bts") {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            #[allow(dead_code)]
            struct BtsManifest {
                urls: Vec<String>,
                codecs: Option<String>,
                mime_type: Option<String>,
                encryption_type: Option<String>,
            }

            let manifest_data = serde_json::from_str::<BtsManifest>(&manifest_str)
                .map_err(|e| SoneError::Parse(format!("{} - Manifest: {}", e, manifest_str)))?;

            codec = manifest_data
                .codecs
                .map(|c| c.to_uppercase().split('.').next().unwrap_or("").to_string());

            manifest_data
                .urls
                .into_iter()
                .next()
                .ok_or(SoneError::Parse("No URL in BTS manifest".into()))?
        }
        // Handle DASH/MPD format — return raw manifest for GStreamer
        else if data.manifest_mime_type.contains("dash+xml") {
            // Extract codec from manifest
            if let Some(codecs_start) = manifest_str.find("codecs=\"") {
                let start = codecs_start + 8;
                if let Some(codecs_end) = manifest_str[start..].find("\"") {
                    let raw = &manifest_str[start..start + codecs_end];
                    codec = Some(if raw.contains("flac") {
                        "FLAC".to_string()
                    } else {
                        raw.to_uppercase()
                    });
                }
            }

            return Ok(StreamInfo {
                url: String::new(),
                codec,
                bit_depth: data.bit_depth,
                sample_rate: data.sample_rate,
                audio_quality: data.audio_quality.clone(),
                audio_mode: None,
                asset_presentation: None,
                manifest: Some(manifest_str),
                manifest_mime_type: None,
                manifest_hash: None,
                track_id: None,
                album_replay_gain: data.album_replay_gain,
                album_peak_amplitude: data.album_peak_amplitude,
                track_replay_gain: data.track_replay_gain,
                track_peak_amplitude: data.track_peak_amplitude,
            });
        }
        // JSON fallback
        else {
            #[derive(Deserialize)]
            struct JsonManifest {
                urls: Option<Vec<String>>,
            }

            if let Ok(manifest_data) = serde_json::from_str::<JsonManifest>(&manifest_str) {
                if let Some(urls) = manifest_data.urls {
                    if let Some(u) = urls.into_iter().next() {
                        u
                    } else {
                        return Err(SoneError::Parse("Empty URL list in manifest".into()));
                    }
                } else {
                    return Err(SoneError::Parse("No urls in JSON manifest".into()));
                }
            } else {
                return Err(SoneError::Parse(format!(
                    "Unknown manifest format '{}': {}",
                    data.manifest_mime_type,
                    &manifest_str[..manifest_str.len().min(300)]
                )));
            }
        };

        Ok(StreamInfo {
            url,
            codec,
            bit_depth: data.bit_depth,
            sample_rate: data.sample_rate,
            audio_quality: data.audio_quality.clone(),
            audio_mode: None,
            asset_presentation: None,
            manifest: None,
            manifest_mime_type: None,
            manifest_hash: None,
            track_id: None,
            album_replay_gain: data.album_replay_gain,
            album_peak_amplitude: data.album_peak_amplitude,
            track_replay_gain: data.track_replay_gain,
            track_peak_amplitude: data.track_peak_amplitude,
        })
    }

    pub async fn get_track_lyrics(&mut self, track_id: u64) -> Result<TidalLyrics, SoneError> {
        let cc = self.country_code.clone();
        self.api_get(
            &format!("/tracks/{}/lyrics", track_id),
            &[("countryCode", &cc)],
        )
        .await
    }

    pub async fn get_track_credits(
        &mut self,
        track_id: u64,
    ) -> Result<Vec<TidalCredit>, SoneError> {
        let cc = self.country_code.clone();
        self.api_get(
            &format!("/tracks/{}/credits", track_id),
            &[("countryCode", &cc)],
        )
        .await
    }

    pub async fn get_track_radio(
        &mut self,
        track_id: u64,
        limit: u32,
    ) -> Result<Vec<TidalTrack>, SoneError> {
        let cc = self.country_code.clone();

        // Step 1: Fetch track detail to get mixes.TRACK_MIX
        if let Ok(detail_body) = self
            .api_get_body(&format!("/tracks/{}", track_id), &[("countryCode", &cc)])
            .await
        {
            if let Ok(detail) = serde_json::from_str::<Value>(&detail_body) {
                if let Some(track_mix_id) = detail
                    .get("mixes")
                    .and_then(|m| m.get("TRACK_MIX"))
                    .and_then(|v| v.as_str())
                {
                    // Step 2: Use get_mix_items (pages/mix with legacy fallback)
                    if let Ok(tracks) = self.get_mix_items(track_mix_id).await {
                        if !tracks.is_empty() {
                            return Ok(tracks);
                        }
                    }
                }
            }
        }

        // Step 3: Fall back to legacy /tracks/{id}/radio
        // 4xx errors mean "no radio available" — return empty vec instead of error.
        match self.get_track_radio_legacy(track_id, limit).await {
            Ok(tracks) => Ok(tracks),
            Err(SoneError::Api { status, .. }) if (400..500).contains(&status) => Ok(vec![]),
            Err(e) => Err(e),
        }
    }

    /// Legacy track radio endpoint: `/tracks/{id}/radio`
    async fn get_track_radio_legacy(
        &mut self,
        track_id: u64,
        limit: u32,
    ) -> Result<Vec<TidalTrack>, SoneError> {
        let cc = self.country_code.clone();
        let limit_str = limit.to_string();
        let body = self
            .api_get_body(
                &format!("/tracks/{}/radio", track_id),
                &[("countryCode", &cc), ("limit", &limit_str)],
            )
            .await?;

        #[derive(Deserialize)]
        struct RadioResponse {
            items: Vec<TidalTrack>,
        }

        if let Ok(mut data) = serde_json::from_str::<RadioResponse>(&body) {
            for t in &mut data.items {
                t.backfill_artist();
            }
            return Ok(data.items);
        }
        serde_json::from_str::<Vec<TidalTrack>>(&body)
            .map_err(|e| SoneError::Parse(format!("{} - Body: {}", e, body)))
    }

    pub async fn search(
        &mut self,
        query: &str,
        limit: u32,
    ) -> Result<TidalSearchResults, SoneError> {
        // Try the v2 API first (web app uses this, returns playlists properly)
        if let Ok(v2) = self.search_v2(query, limit).await {
            return Ok(v2);
        }

        // Fallback to v1 API
        self.search_v1(query, limit).await
    }

    async fn search_v2(
        &mut self,
        query: &str,
        limit: u32,
    ) -> Result<TidalSearchResults, SoneError> {
        let cc = self.country_code.clone();
        let limit_str = limit.to_string();
        // v2 uses a different base URL, so pass the full URL
        let body = self
            .api_get_body(
                &format!("{}/search", TIDAL_API_V2_URL),
                &[
                    ("query", query),
                    ("countryCode", &cc),
                    ("limit", &limit_str),
                    ("types", "ARTISTS,ALBUMS,TRACKS,PLAYLISTS"),
                    ("includeContributors", "true"),
                    ("includeUserPlaylists", "true"),
                    ("includeDidYouMean", "true"),
                    ("supportsUserData", "true"),
                    ("locale", "en_US"),
                    ("deviceType", "BROWSER"),
                ],
            )
            .await?;
        self.parse_search_response(&body, query, "v2")
    }

    async fn search_v1(
        &mut self,
        query: &str,
        limit: u32,
    ) -> Result<TidalSearchResults, SoneError> {
        let cc = self.country_code.clone();
        let limit_str = limit.to_string();
        let body = self
            .api_get_body(
                "/search",
                &[
                    ("query", query),
                    ("countryCode", &cc),
                    ("limit", &limit_str),
                    ("offset", "0"),
                    ("types", "ARTISTS,ALBUMS,TRACKS,PLAYLISTS"),
                    ("includeContributors", "true"),
                    ("includeUserPlaylists", "true"),
                    ("supportsUserData", "true"),
                ],
            )
            .await?;
        self.parse_search_response(&body, query, "v1")
    }

    fn parse_search_response(
        &self,
        body: &str,
        query: &str,
        tag: &str,
    ) -> Result<TidalSearchResults, SoneError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Sec<T> {
            items: Vec<T>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct SR {
            #[serde(default)]
            artists: Option<Sec<TidalArtist>>,
            #[serde(default)]
            albums: Option<Sec<TidalAlbumDetail>>,
            #[serde(default)]
            tracks: Option<Sec<TidalTrack>>,
            #[serde(default)]
            playlists: Option<Sec<TidalPlaylistRaw>>,
        }

        let data: SR = serde_json::from_str(body)
            .map_err(|e| SoneError::Parse(format!("search ({}): {}", tag, e)))?;

        // Parse topHits from the raw JSON (v2 returns an array of typed entities)
        let top_hits = serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|json| {
                json.get("topHits")
                    .and_then(|v| v.as_array())
                    .map(|arr| DirectHitItem::parse_array(arr))
            })
            .unwrap_or_default();

        log::debug!(
            "search [{}]: t={} al={} ar={} pl={} th={} for '{}'",
            tag,
            data.tracks.as_ref().map(|s| s.items.len()).unwrap_or(0),
            data.albums.as_ref().map(|s| s.items.len()).unwrap_or(0),
            data.artists.as_ref().map(|s| s.items.len()).unwrap_or(0),
            data.playlists.as_ref().map(|s| s.items.len()).unwrap_or(0),
            top_hits.len(),
            query
        );

        let mut tracks = data.tracks.map(|s| s.items).unwrap_or_default();
        for t in &mut tracks {
            t.backfill_artist();
        }

        let mut albums = data.albums.map(|s| s.items).unwrap_or_default();
        for a in &mut albums {
            a.backfill_artist();
        }

        Ok(TidalSearchResults {
            artists: data.artists.map(|s| s.items).unwrap_or_default(),
            albums,
            tracks,
            playlists: data
                .playlists
                .map(|s| s.items.into_iter().map(|p| p.into()).collect())
                .unwrap_or_default(),
            top_hit_type: None,
            top_hits,
        })
    }

    /// Fetch suggestions from Tidal's v2 /suggestions/ endpoint.
    /// Returns a SuggestionsResponse with text suggestions AND direct hit entities,
    /// exactly as the webapp's mini-search dropdown uses.
    pub async fn get_suggestions(&mut self, query: &str, limit: u32) -> SuggestionsResponse {
        let empty = SuggestionsResponse {
            text_suggestions: vec![],
            direct_hits: vec![],
        };
        let url = format!("{}/suggestions/", TIDAL_API_V2_URL);
        let country_code = self.country_code.clone();

        let resp = self
            .authenticated_get(
                &url,
                &[
                    ("query", query),
                    ("countryCode", &country_code),
                    ("explicit", "true"),
                    ("hybrid", "true"),
                ],
            )
            .await;

        match resp {
            Ok(r) if r.status().is_success() => {
                let body = r.text().await.unwrap_or_default();
                if let Some(result) = Self::parse_v2_suggestions_full(&body, limit) {
                    log::debug!(
                        "suggestions v2: {} text, {} hits for '{}'",
                        result.text_suggestions.len(),
                        result.direct_hits.len(),
                        query
                    );
                    return result;
                }
            }
            Ok(r) => log::debug!("suggestions v2: HTTP {} for '{}'", r.status(), query),
            Err(e) => log::debug!("suggestions v2: error: {} for '{}'", e, query),
        }

        empty
    }

    /// Parse the full v2 /suggestions/ response into SuggestionsResponse.
    /// Preserves directHits in exact API order (mixed entity types).
    fn parse_v2_suggestions_full(body: &str, limit: u32) -> Option<SuggestionsResponse> {
        let json: serde_json::Value = serde_json::from_str(body).ok()?;

        let mut text_suggestions = Vec::new();

        // Extract history items (source = "history")
        if let Some(arr) = json.get("history").and_then(|v| v.as_array()) {
            for item in arr {
                if let Some(q) = item.get("query").and_then(|v| v.as_str()) {
                    text_suggestions.push(SuggestionTextItem {
                        query: q.to_string(),
                        source: "history".to_string(),
                    });
                }
            }
        }

        // Extract suggestion items (source = "suggestion")
        if let Some(arr) = json.get("suggestions").and_then(|v| v.as_array()) {
            for item in arr {
                if let Some(q) = item.get("query").and_then(|v| v.as_str()) {
                    text_suggestions.push(SuggestionTextItem {
                        query: q.to_string(),
                        source: "suggestion".to_string(),
                    });
                }
            }
        }

        text_suggestions.truncate(limit as usize);

        // Extract directHits in exact API order using the shared helper
        let direct_hits = json
            .get("directHits")
            .and_then(|v| v.as_array())
            .map(|arr| DirectHitItem::parse_array(arr))
            .unwrap_or_default();

        Some(SuggestionsResponse {
            text_suggestions,
            direct_hits,
        })
    }

    // ==================== Home Page (Pages API) ====================

    /// Fetch the v2 home feed from api.tidal.com/v2/home/feed/static.
    /// Returns parsed sections, or empty vec on failure.
    pub async fn fetch_v2_home_feed(
        &mut self,
        cursor: Option<&str>,
    ) -> (Vec<HomePageSection>, Option<String>) {
        let url = format!("{}/home/feed/static", TIDAL_API_V2_URL);
        let country_code = self.country_code.clone();

        let mut params: Vec<(&str, &str)> = vec![
            ("countryCode", &country_code),
            ("locale", "en_US"),
            ("deviceType", "BROWSER"),
            ("platform", "WEB"),
        ];
        let cursor_owned;
        if let Some(c) = cursor {
            cursor_owned = c.to_string();
            params.push(("cursor", &cursor_owned));
        }

        let resp = self.authenticated_get(&url, &params).await;

        match resp {
            Ok(r) if r.status().is_success() => {
                let body = r.text().await.unwrap_or_default();
                match serde_json::from_str::<Value>(&body) {
                    Ok(json) => {
                        let next_cursor = json
                            .get("page")
                            .and_then(|p| p.get("cursor"))
                            .and_then(|c| c.as_str())
                            .map(|s| s.to_string());
                        let raw_count = json
                            .get("items")
                            .and_then(|i| i.as_array())
                            .map(|a| a.len())
                            .unwrap_or(0);
                        let result = Self::parse_page_response(&json).unwrap_or_default();
                        log::debug!("v2 home feed: cursor={:?}, raw items={}, parsed sections={}, next_cursor={:?}",
                            cursor.is_some(), raw_count, result.sections.len(), next_cursor.is_some());
                        if result.sections.len() < raw_count {
                            log::debug!(
                                "v2 home feed: {} sections dropped during parsing",
                                raw_count - result.sections.len()
                            );
                        }
                        (result.sections, next_cursor)
                    }
                    Err(e) => {
                        log::debug!("v2 home feed: parse error: {}", e);
                        (vec![], None)
                    }
                }
            }
            Ok(r) => {
                log::debug!("v2 home feed: HTTP {}", r.status());
                (vec![], None)
            }
            Err(e) => {
                log::debug!("v2 home feed: request error: {}", e);
                (vec![], None)
            }
        }
    }

    /// Fetch a single page endpoint. Handles both V1 and V2 response formats.
    async fn fetch_page_endpoint(
        &mut self,
        endpoint: &str,
    ) -> Result<Vec<HomePageSection>, SoneError> {
        let cc = self.country_code.clone();
        let body = match self
            .api_get_body(
                &format!("/{}", endpoint),
                &[
                    ("countryCode", &cc),
                    ("deviceType", "BROWSER"),
                    ("locale", "en_US"),
                ],
            )
            .await
        {
            Ok(b) => b,
            Err(e) => {
                log::warn!("Page endpoint {} failed: {}", endpoint, e);
                return Ok(vec![]); // Don't fail the whole home page for one endpoint
            }
        };

        let json: Value = serde_json::from_str(&body)
            .map_err(|e| SoneError::Parse(format!("{} JSON: {}", endpoint, e)))?;

        let result = Self::parse_page_response(&json)?;
        log::debug!(
            "[{}]: parsed {} sections: {:?}",
            endpoint,
            result.sections.len(),
            result
                .sections
                .iter()
                .map(|s| format!("\"{}\" ({})", s.title, s.section_type))
                .collect::<Vec<_>>()
        );

        if result.sections.is_empty() {
            if let Some(obj) = json.as_object() {
                log::debug!(
                    "[{}]: 0 sections parsed, top-level keys: {:?}",
                    endpoint,
                    obj.keys().collect::<Vec<_>>()
                );
            }
        }

        Ok(result.sections)
    }

    /// Build a dedup key from a section: uses title + first 3 item IDs.
    /// This ensures sections with the same title but different content are kept.
    fn section_dedup_key(s: &HomePageSection) -> String {
        let mut key = s.title.clone();
        if let Some(items) = s.items.as_array() {
            for item in items.iter().take(3) {
                let id = item
                    .get("id")
                    .and_then(|i| i.as_u64())
                    .map(|i| i.to_string())
                    .or_else(|| {
                        item.get("uuid")
                            .and_then(|u| u.as_str())
                            .map(|s| s.to_string())
                    })
                    .or_else(|| {
                        item.get("mixId")
                            .and_then(|m| m.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_default();
                key.push('|');
                key.push_str(&id);
            }
        }
        key
    }

    /// Helper: add sections to the collection, deduplicating smartly.
    /// Skips sections with empty titles.
    /// Uses title + item IDs for dedup key so same-title sections with different content are kept.
    fn add_unique_sections(
        all: &mut Vec<HomePageSection>,
        seen: &mut std::collections::HashSet<String>,
        new_sections: Vec<HomePageSection>,
    ) {
        for s in new_sections {
            // Skip sections with empty/blank titles
            if s.title.trim().is_empty() {
                continue;
            }
            // Skip PAGE_LINKS navigation sections on the home page
            if s.section_type == "PAGE_LINKS_CLOUD" || s.section_type == "PAGE_LINKS" {
                continue;
            }
            let key = Self::section_dedup_key(&s);
            if seen.insert(key) {
                all.push(s);
            }
        }
    }

    /// Fetch the home page. Tries the v2 home/feed/static endpoint first
    /// (what the Tidal web app uses). Falls back to multi-endpoint v1 approach.
    /// Trusts Tidal's section ordering — no manual resorting.
    pub async fn get_home_page(&mut self) -> Result<HomePageResponse, SoneError> {
        // Try v2 home feed first (single endpoint, personalized)
        let (mut all_sections, cursor) = self.fetch_v2_home_feed(None).await;

        if !all_sections.is_empty() {
            log::debug!(
                "[home v2]: got {} sections from home/feed/static",
                all_sections.len()
            );

            // Filter out non-content section types
            all_sections.retain(|s| {
                !s.title.trim().is_empty()
                    && s.section_type != "PAGE_LINKS_CLOUD"
                    && s.section_type != "PAGE_LINKS"
            });

            for s in &all_sections {
                log::debug!(
                    "[home v2] section: '{}' type={} items={}",
                    s.title,
                    s.section_type,
                    s.items.as_array().map(|a| a.len()).unwrap_or(0)
                );
            }
            log::debug!(
                "[home v2]: returning {} sections, cursor={:?}",
                all_sections.len(),
                cursor.is_some()
            );
            return Ok(HomePageResponse {
                sections: all_sections,
                cursor,
            });
        }

        // v2 unavailable — fall back to v1 multi-endpoint approach
        log::debug!("[home v1]: v2 empty, falling back to v1 endpoints");
        let mut seen_titles = std::collections::HashSet::new();

        let home_sections = self.fetch_page_endpoint("pages/home").await?;
        Self::add_unique_sections(&mut all_sections, &mut seen_titles, home_sections);

        if let Ok(sections) = self.fetch_page_endpoint("pages/for_you").await {
            Self::add_unique_sections(&mut all_sections, &mut seen_titles, sections);
        }

        if let Ok(sections) = self
            .fetch_page_endpoint("pages/my_collection_my_mixes")
            .await
        {
            Self::add_unique_sections(&mut all_sections, &mut seen_titles, sections);
        }

        if let Ok(sections) = self.fetch_page_endpoint("pages/explore").await {
            Self::add_unique_sections(&mut all_sections, &mut seen_titles, sections);
        }

        if let Ok(mut sections) = self.fetch_page_endpoint("pages/rising").await {
            sections.retain(|s| {
                s.section_type != "VIDEO_LIST"
                    && s.title != "Video Playlists"
                    && s.title != "New Videos"
            });
            Self::add_unique_sections(&mut all_sections, &mut seen_titles, sections);
        }

        log::debug!("[home v1]: returning {} sections", all_sections.len());
        Ok(HomePageResponse {
            sections: all_sections,
            cursor: None,
        })
    }

    /// Parse a pages API response, supporting V1, V2, and tab/category formats.
    fn parse_page_response(json: &Value) -> Result<HomePageResponse, SoneError> {
        let mut sections = Vec::new();

        // ---- V1 format: { rows: [ { modules: [ { type, title, pagedList, ... } ] } ] }
        if let Some(rows) = json.get("rows").and_then(|r| r.as_array()) {
            for row in rows {
                if let Some(modules) = row.get("modules").and_then(|m| m.as_array()) {
                    for module in modules {
                        if let Some(sec) = Self::parse_v1_module(module) {
                            sections.push(sec);
                        }
                    }
                }
            }
        }

        // ---- V2 format: { items: [ { type, title, items: [...], viewAll, ... } ] }
        if sections.is_empty() {
            if let Some(top_items) = json.get("items").and_then(|i| i.as_array()) {
                // Check if ANY item looks like a V2 section (objects with type/title/items)
                // vs just being raw content items (e.g. flat track/album objects)
                let looks_like_sections = top_items.iter().any(|f| {
                    f.get("items").is_some()
                        || f.get("type")
                            .and_then(|t| t.as_str())
                            .map(|t| {
                                t.contains("LIST")
                                    || t.contains("GRID")
                                    || t.contains("SHORTCUT")
                                    || t == "PAGE_LINKS_CLOUD"
                                    || t == "PAGE_LINKS"
                                    || t == "HIGHLIGHT_MODULE"
                            })
                            .unwrap_or(false)
                        || f.get("titleTextInfo").is_some()
                });

                if looks_like_sections {
                    for item in top_items {
                        if let Some(sec) = Self::parse_v2_section(item) {
                            sections.push(sec);
                        }
                    }
                }
            }
        }

        // ---- Tab format: { tabs: [ { title, items: [...] } ] }
        // The explore page often uses a tabs-based structure
        if sections.is_empty() {
            if let Some(tabs) = json.get("tabs").and_then(|t| t.as_array()) {
                for tab in tabs {
                    // Each tab may contain rows (V1) or items (V2) inside it
                    if let Some(rows) = tab.get("rows").and_then(|r| r.as_array()) {
                        for row in rows {
                            if let Some(modules) = row.get("modules").and_then(|m| m.as_array()) {
                                for module in modules {
                                    if let Some(sec) = Self::parse_v1_module(module) {
                                        sections.push(sec);
                                    }
                                }
                            }
                        }
                    }
                    if let Some(items) = tab.get("items").and_then(|i| i.as_array()) {
                        for item in items {
                            if let Some(sec) = Self::parse_v2_section(item) {
                                sections.push(sec);
                            }
                        }
                    }
                }
            }
        }

        // ---- Categories format: { categories: [...] } or { sections: [...] }
        if sections.is_empty() {
            let containers = [
                json.get("categories").and_then(|c| c.as_array()),
                json.get("sections").and_then(|s| s.as_array()),
            ];
            for container in containers.into_iter().flatten() {
                for item in container {
                    // Try V1 module parsing first, then V2
                    if let Some(sec) = Self::parse_v1_module(item) {
                        sections.push(sec);
                    } else if let Some(sec) = Self::parse_v2_section(item) {
                        sections.push(sec);
                    }
                }
            }
        }

        // ---- Fallback: if the response itself looks like a single section
        //      e.g. { title, items: [...] } from a "view all" endpoint
        if sections.is_empty() {
            if let Some(items) = json.get("items").and_then(|i| i.as_array()) {
                let page_title = json
                    .get("title")
                    .and_then(|t| t.as_str())
                    .unwrap_or("Results")
                    .to_string();
                // Unwrap {type, data} wrappers (v2 view-all format)
                let unwrapped: Vec<Value> = items
                    .iter()
                    .map(|item| {
                        if let Some(data) = item.get("data") {
                            let mut merged = data.clone();
                            if let Some(obj) = merged.as_object_mut() {
                                if let Some(item_type) = item.get("type").and_then(|t| t.as_str()) {
                                    obj.entry("_itemType".to_string())
                                        .or_insert(Value::String(item_type.to_string()));
                                }
                            }
                            merged
                        } else {
                            item.clone()
                        }
                    })
                    .collect();
                sections.push(HomePageSection {
                    title: page_title,
                    section_type: "MIXED_LIST".to_string(),
                    items: Value::Array(unwrapped),
                    has_more: false,
                    api_path: None,
                });
            }
        }

        Ok(HomePageResponse {
            sections,
            cursor: None,
        })
    }

    /// Parse a V1 module (from rows/modules format).
    fn parse_v1_module(module: &Value) -> Option<HomePageSection> {
        let section_type = module
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();

        // Only skip truly non-content promotional types
        if section_type == "FEATURED_PROMOTIONS"
            || section_type == "MULTIPLE_TOP_PROMOTIONS"
            || section_type == "TEXT_BLOCK"
            || section_type == "SOCIAL"
            || section_type == "ARTICLE_LIST"
        {
            return None;
        }

        // Get title - check multiple possible fields
        let title = module
            .get("title")
            .and_then(|t| t.as_str())
            .or_else(|| module.get("header").and_then(|h| h.as_str()))
            .unwrap_or("")
            .to_string();

        // PAGE_LINKS are navigation sections (explore categories) — allow them through
        // so the explore page can use them. The home page filters them out in add_unique_sections.

        // Allow sections even with empty titles if they have items
        // (some sections have descriptions but no title)

        // Extract items from pagedList, highlights, listItems, or other containers
        let items = if let Some(paged_list) = module.get("pagedList") {
            paged_list
                .get("items")
                .cloned()
                .unwrap_or(Value::Array(vec![]))
        } else if let Some(highlights) = module.get("highlights") {
            if let Some(arr) = highlights.as_array() {
                let unwrapped: Vec<Value> =
                    arr.iter().filter_map(|h| h.get("item").cloned()).collect();
                Value::Array(unwrapped)
            } else {
                Value::Array(vec![])
            }
        } else if let Some(list_items) = module.get("listItems").and_then(|l| l.as_array()) {
            // Some modules use "listItems" instead of "pagedList"
            Value::Array(list_items.clone())
        } else if module.get("mix").is_some() {
            // MIX_HEADER type - single mix as an item
            Value::Array(vec![module.get("mix").cloned().unwrap_or(Value::Null)])
        } else {
            // Last resort: look for any array field that looks like items
            let mut found = Value::Array(vec![]);
            if let Some(obj) = module.as_object() {
                for (key, val) in obj {
                    if key == "type"
                        || key == "title"
                        || key == "header"
                        || key == "showMore"
                        || key == "viewAll"
                        || key == "description"
                        || key == "id"
                        || key == "selfLink"
                    {
                        continue;
                    }
                    if let Some(arr) = val.as_array() {
                        if !arr.is_empty() && arr[0].is_object() {
                            found = val.clone();
                            break;
                        }
                    }
                }
            }
            found
        };

        // Skip truly empty sections
        if items.as_array().map(|a| a.is_empty()).unwrap_or(true) {
            return None;
        }

        // Extract "showMore" or "viewAll" api path - check multiple locations
        let api_path = module
            .get("showMore")
            .and_then(|sm| sm.get("apiPath"))
            .and_then(|p| p.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                module
                    .get("pagedList")
                    .and_then(|pl| pl.get("dataApiPath"))
                    .and_then(|p| p.as_str())
                    .map(|s| s.to_string())
            })
            .or_else(|| {
                module.get("viewAll").and_then(|va| {
                    if let Some(s) = va.as_str() {
                        Some(s.to_string())
                    } else {
                        va.get("apiPath")
                            .and_then(|p| p.as_str())
                            .map(|s| s.to_string())
                    }
                })
            });

        let has_more = api_path.is_some();

        Some(HomePageSection {
            title,
            section_type,
            items,
            has_more,
            api_path,
        })
    }

    /// Parse a V2 section (from the flat items format).
    /// V2 sections look like:
    /// { "type": "HORIZONTAL_LIST", "moduleId": "...", "title": "...",
    ///   "items": [ { "type": "ALBUM", "data": { ... } }, ... ],
    ///   "viewAll": "pages/..." }
    fn parse_v2_section(section: &Value) -> Option<HomePageSection> {
        let section_type = section
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();

        // Get title — v2 may use string, object {"text": "..."}, or titleTextInfo
        let title = section
            .get("title")
            .and_then(|t| {
                t.as_str().map(|s| s.to_string()).or_else(|| {
                    t.get("text")
                        .and_then(|tx| tx.as_str())
                        .map(|s| s.to_string())
                })
            })
            .or_else(|| {
                section
                    .get("titleTextInfo")
                    .and_then(|ti| ti.get("text"))
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_default();

        if title.is_empty() {
            log::debug!(
                "parse_v2_section: dropping section with empty title, type={}",
                section_type
            );
            return None;
        }

        // V2 items can be in "items" array, where each has { type, data }
        let raw_items = section.get("items").and_then(|i| i.as_array());

        let items = if let Some(raw) = raw_items {
            // Unwrap the "data" field from each item if present,
            // but keep the item type info by merging it
            let unwrapped: Vec<Value> = raw
                .iter()
                .map(|item| {
                    if let Some(data) = item.get("data") {
                        // Merge item-level type into data for identification
                        let mut merged = data.clone();
                        if let Some(obj) = merged.as_object_mut() {
                            if let Some(item_type) = item.get("type").and_then(|t| t.as_str()) {
                                obj.entry("_itemType".to_string())
                                    .or_insert(Value::String(item_type.to_string()));
                            }
                        }
                        merged
                    } else {
                        // No "data" wrapper — item is already flat
                        item.clone()
                    }
                })
                .collect();
            Value::Array(unwrapped)
        } else {
            Value::Array(vec![])
        };

        // V2 viewAll is either a string or an object
        let api_path = section
            .get("viewAll")
            .and_then(|va| {
                if let Some(s) = va.as_str() {
                    Some(s.to_string())
                } else {
                    va.get("apiPath")
                        .and_then(|p| p.as_str())
                        .map(|s| s.to_string())
                }
            })
            .or_else(|| {
                section
                    .get("showMore")
                    .and_then(|sm| sm.get("apiPath"))
                    .and_then(|p| p.as_str())
                    .map(|s| s.to_string())
            });

        let has_more = api_path.is_some();

        // Map V2 section types to something our frontend understands
        let mapped_type = match section_type.as_str() {
            "SHORTCUT_LIST" => "SHORTCUT_LIST",
            "HORIZONTAL_LIST" | "HORIZONTAL_LIST_WITH_CONTEXT" => {
                // Try to detect the content type from items
                if let Some(arr) = items.as_array() {
                    if let Some(first) = arr.first() {
                        let item_type = first
                            .get("_itemType")
                            .or_else(|| first.get("type"))
                            .and_then(|t| t.as_str())
                            .unwrap_or("");
                        match item_type {
                            "MIX" => "MIX_LIST",
                            "ALBUM" => "ALBUM_LIST",
                            "PLAYLIST" => "PLAYLIST_LIST",
                            "ARTIST" => "ARTIST_LIST",
                            "TRACK" => "TRACK_LIST",
                            _ => {
                                // Detect by data shape
                                if first.get("mixType").is_some()
                                    || first.get("mixImages").is_some()
                                {
                                    "MIX_LIST"
                                } else if first.get("uuid").is_some() {
                                    "PLAYLIST_LIST"
                                } else if first.get("cover").is_some()
                                    || first.get("numberOfTracks").is_some()
                                {
                                    "ALBUM_LIST"
                                } else if first.get("picture").is_some()
                                    && first.get("cover").is_none()
                                {
                                    "ARTIST_LIST"
                                } else {
                                    "MIXED_TYPES_LIST"
                                }
                            }
                        }
                    } else {
                        "MIXED_TYPES_LIST"
                    }
                } else {
                    "MIXED_TYPES_LIST"
                }
            }
            "TRACK_LIST" => "TRACK_LIST",
            other => other,
        };

        Some(HomePageSection {
            title,
            section_type: mapped_type.to_string(),
            items,
            has_more,
            api_path,
        })
    }

    pub async fn get_favorite_artists(
        &mut self,
        user_id: u64,
        offset: u32,
        limit: u32,
    ) -> Result<PaginatedResponse<TidalArtistDetail>, SoneError> {
        let cc = self.country_code.clone();
        let limit_str = limit.to_string();
        let offset_str = offset.to_string();
        let body = self
            .api_get_body(
                &format!("/users/{}/favorites/artists", user_id),
                &[
                    ("countryCode", &cc),
                    ("limit", &limit_str),
                    ("offset", &offset_str),
                    ("order", "DATE"),
                    ("orderDirection", "DESC"),
                ],
            )
            .await?;

        #[derive(Deserialize)]
        struct FavEntry {
            item: TidalArtistDetail,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FavResponse {
            items: Vec<FavEntry>,
            total_number_of_items: u32,
        }

        let data: FavResponse = serde_json::from_str(&body).map_err(|e| {
            SoneError::Parse(format!("{} - Body: {}", e, &body[..body.len().min(500)]))
        })?;
        let artists: Vec<TidalArtistDetail> = data.items.into_iter().map(|f| f.item).collect();
        log::debug!(
            "[get_favorite_artists]: got {} artists (total={})",
            artists.len(),
            data.total_number_of_items
        );
        Ok(PaginatedResponse {
            items: artists,
            total_number_of_items: data.total_number_of_items,
            offset,
            limit,
        })
    }

    /// Fetch user's favorite albums as structured data for the sidebar.
    pub async fn get_favorite_albums(
        &mut self,
        user_id: u64,
        offset: u32,
        limit: u32,
    ) -> Result<PaginatedResponse<TidalAlbumDetail>, SoneError> {
        let cc = self.country_code.clone();
        let limit_str = limit.to_string();
        let offset_str = offset.to_string();
        let body = self
            .api_get_body(
                &format!("/users/{}/favorites/albums", user_id),
                &[
                    ("countryCode", &cc),
                    ("limit", &limit_str),
                    ("offset", &offset_str),
                    ("order", "DATE"),
                    ("orderDirection", "DESC"),
                ],
            )
            .await?;

        #[derive(Deserialize)]
        struct FavEntry {
            item: TidalAlbumDetail,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FavResponse {
            items: Vec<FavEntry>,
            total_number_of_items: u32,
        }

        let data: FavResponse = serde_json::from_str(&body)
            .map_err(|e| SoneError::Parse(format!("{} - Body: {}", e, body)))?;
        let albums: Vec<TidalAlbumDetail> = data.items.into_iter().map(|e| e.item).collect();
        log::debug!(
            "[get_favorite_albums]: got {} albums (total={})",
            albums.len(),
            data.total_number_of_items
        );
        Ok(PaginatedResponse {
            items: albums,
            total_number_of_items: data.total_number_of_items,
            offset,
            limit,
        })
    }

    // ==================== Artist Detail ====================

    /// Fetch full artist detail (name, picture, etc.)
    pub async fn get_artist_detail(
        &mut self,
        artist_id: u64,
    ) -> Result<TidalArtistDetail, SoneError> {
        let cc = self.country_code.clone();
        self.api_get(&format!("/artists/{}", artist_id), &[("countryCode", &cc)])
            .await
    }

    // ==================== Mix / Radio Items ====================

    /// Parse tracks from a `pages/mix` JSON response body.
    /// Finds the first `TRACK_LIST` module and extracts `pagedList.items`.
    fn parse_mix_page_tracks(body: &str) -> Option<Vec<TidalTrack>> {
        let json: Value = serde_json::from_str(body).ok()?;
        let rows = json.get("rows")?.as_array()?;
        for row in rows {
            let modules = row.get("modules")?.as_array()?;
            for module in modules {
                if module.get("type").and_then(|t| t.as_str()) == Some("TRACK_LIST") {
                    let items = module.get("pagedList")?.get("items")?.as_array()?;
                    let mut tracks: Vec<TidalTrack> = items
                        .iter()
                        .filter_map(|item| serde_json::from_value::<TidalTrack>(item.clone()).ok())
                        .collect();
                    for t in &mut tracks {
                        t.backfill_artist();
                    }
                    return Some(tracks);
                }
            }
        }
        None
    }

    /// Fetch the tracks in a mix (custom mixes, radio stations, etc.)
    /// Tries `pages/mix` first, falls back to legacy `/mixes/{id}/items`.
    pub async fn get_mix_items(&mut self, mix_id: &str) -> Result<Vec<TidalTrack>, SoneError> {
        let cc = self.country_code.clone();

        // Primary: pages/mix endpoint (returns richer data, up to 100 tracks)
        if let Ok(body) = self
            .api_get_body(
                "/pages/mix",
                &[
                    ("mixId", mix_id),
                    ("countryCode", &cc),
                    ("deviceType", "BROWSER"),
                    ("locale", "en_US"),
                ],
            )
            .await
        {
            if let Some(tracks) = Self::parse_mix_page_tracks(&body) {
                if !tracks.is_empty() {
                    return Ok(tracks);
                }
            }
        }

        // Fallback: legacy /mixes/{id}/items
        self.get_mix_items_legacy(mix_id).await
    }

    /// Legacy mix endpoint: `/mixes/{id}/items`
    async fn get_mix_items_legacy(&mut self, mix_id: &str) -> Result<Vec<TidalTrack>, SoneError> {
        let cc = self.country_code.clone();
        let body = self
            .api_get_body(&format!("/mixes/{}/items", mix_id), &[("countryCode", &cc)])
            .await?;

        let json: Value =
            serde_json::from_str(&body).map_err(|e| SoneError::Parse(e.to_string()))?;
        if let Some(items) = json.get("items").and_then(|i| i.as_array()) {
            let mut tracks: Vec<TidalTrack> = items
                .iter()
                .filter_map(|entry| {
                    entry
                        .get("item")
                        .and_then(|item| serde_json::from_value::<TidalTrack>(item.clone()).ok())
                })
                .collect();
            for t in &mut tracks {
                t.backfill_artist();
            }
            Ok(tracks)
        } else {
            Ok(vec![])
        }
    }

    // ==================== Artist Page ====================

    /// Fetch an artist's top tracks
    pub async fn get_artist_top_tracks(
        &mut self,
        artist_id: u64,
        limit: u32,
    ) -> Result<Vec<TidalTrack>, SoneError> {
        let cc = self.country_code.clone();
        let limit_str = limit.to_string();
        let body = self
            .api_get_body(
                &format!("/artists/{}/toptracks", artist_id),
                &[("countryCode", &cc), ("limit", &limit_str), ("offset", "0")],
            )
            .await?;

        #[derive(Deserialize)]
        struct Resp {
            items: Vec<TidalTrack>,
        }

        let mut data: Resp = serde_json::from_str(&body).map_err(|e| {
            SoneError::Parse(format!("{} - Body: {}", e, &body[..body.len().min(500)]))
        })?;
        for t in &mut data.items {
            t.backfill_artist();
        }
        Ok(data.items)
    }

    /// Fetch an artist's albums
    pub async fn get_artist_albums(
        &mut self,
        artist_id: u64,
        limit: u32,
    ) -> Result<Vec<TidalAlbumDetail>, SoneError> {
        let cc = self.country_code.clone();
        let limit_str = limit.to_string();
        let body = self
            .api_get_body(
                &format!("/artists/{}/albums", artist_id),
                &[("countryCode", &cc), ("limit", &limit_str), ("offset", "0")],
            )
            .await?;

        #[derive(Deserialize)]
        struct Resp {
            items: Vec<TidalAlbumDetail>,
        }

        let data: Resp = serde_json::from_str(&body).map_err(|e| {
            SoneError::Parse(format!("{} - Body: {}", e, &body[..body.len().min(500)]))
        })?;
        Ok(data.items)
    }

    /// Fetch artist bio text
    pub async fn get_artist_bio(&mut self, artist_id: u64) -> Result<String, SoneError> {
        let cc = self.country_code.clone();
        match self
            .api_get_body(
                &format!("/artists/{}/bio", artist_id),
                &[("countryCode", &cc)],
            )
            .await
        {
            Ok(body) => {
                let json: Value = serde_json::from_str(&body).unwrap_or_default();
                Ok(json
                    .get("text")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string())
            }
            Err(_) => Ok(String::new()), // Bio not always available
        }
    }

    pub async fn get_artist_page(&mut self, artist_id: u64) -> Result<Value, SoneError> {
        let cc = self.country_code.clone();
        // Try v2 first
        let v2_url = format!("{}/artist/{}", TIDAL_API_V2_URL, artist_id);
        match self
            .api_get_body(
                &v2_url,
                &[
                    ("countryCode", &cc),
                    ("locale", "en_US"),
                    ("deviceType", "BROWSER"),
                    ("platform", "WEB"),
                ],
            )
            .await
        {
            Ok(body) => {
                return serde_json::from_str(&body)
                    .map_err(|e| SoneError::Parse(format!("artist page v2 JSON: {}", e)));
            }
            Err(e) => {
                log::warn!(
                    "[get_artist_page] v2 failed for artist {}: {:?}, falling back to v1",
                    artist_id,
                    e
                );
            }
        }
        // Fallback to v1
        let body = self
            .api_get_body(
                &format!("/pages/artist?artistId={}", artist_id),
                &[
                    ("countryCode", &cc),
                    ("deviceType", "BROWSER"),
                    ("locale", "en_US"),
                ],
            )
            .await?;
        serde_json::from_str(&body)
            .map_err(|e| SoneError::Parse(format!("artist page v1 JSON: {}", e)))
    }

    pub async fn get_artist_top_tracks_all(
        &mut self,
        artist_id: u64,
        offset: u32,
        limit: u32,
    ) -> Result<Value, SoneError> {
        let url = format!("{}/artist/ARTIST_TOP_TRACKS/view-all", TIDAL_API_V2_URL);
        let cc = self.country_code.clone();
        let id_str = artist_id.to_string();
        let limit_str = limit.to_string();
        let offset_str = offset.to_string();
        let body = self
            .api_get_body(
                &url,
                &[
                    ("artistId", &id_str),
                    ("locale", "en_US"),
                    ("countryCode", &cc),
                    ("deviceType", "BROWSER"),
                    ("platform", "WEB"),
                    ("limit", &limit_str),
                    ("offset", &offset_str),
                ],
            )
            .await?;
        serde_json::from_str(&body)
            .map_err(|e| SoneError::Parse(format!("artist top tracks JSON: {}", e)))
    }

    pub async fn get_artist_view_all(
        &mut self,
        artist_id: u64,
        view_all_path: &str,
    ) -> Result<Value, SoneError> {
        let cc = self.country_code.clone();
        let id_str = artist_id.to_string();
        // viewAll paths from v2 API are relative like "artist/ARTIST_ALBUMS/view-all?artistId=123"
        // They need the v2 base URL, and may already contain query params
        let url = if view_all_path.starts_with("http") {
            view_all_path.to_string()
        } else {
            let path = view_all_path.trim_start_matches('/');
            format!("{}/{}", TIDAL_API_V2_URL, path)
        };
        // The path may already contain ?artistId=... — reqwest .query() appends correctly
        let body = self
            .api_get_body(
                &url,
                &[
                    ("artistId", &id_str),
                    ("locale", "en_US"),
                    ("countryCode", &cc),
                    ("deviceType", "BROWSER"),
                    ("platform", "WEB"),
                    ("limit", "50"),
                    ("offset", "0"),
                ],
            )
            .await?;
        serde_json::from_str(&body)
            .map_err(|e| SoneError::Parse(format!("artist view-all JSON: {}", e)))
    }

    pub fn parse_album_page(&self, body: &str) -> Result<AlbumPageResponse, SoneError> {
        let json: Value = serde_json::from_str(body)
            .map_err(|e| SoneError::Parse(format!("album page JSON: {}", e)))?;

        let rows = json
            .get("rows")
            .and_then(|r| r.as_array())
            .ok_or_else(|| SoneError::Parse("album page: missing rows".into()))?;

        let mut album: Option<TidalAlbumDetail> = None;
        let mut tracks: Vec<TidalTrack> = Vec::new();
        let mut total_tracks: u32 = 0;
        let mut credits: Vec<TidalCredit> = Vec::new();
        let mut review: Option<TidalReview> = None;
        let mut sections: Vec<AlbumPageSection> = Vec::new();
        let mut vibrant_color: Option<String> = None;
        let mut copyright: Option<String> = None;

        for row in rows {
            let modules = match row.get("modules").and_then(|m| m.as_array()) {
                Some(m) => m,
                None => continue,
            };

            for module in modules {
                let mtype = module.get("type").and_then(|t| t.as_str()).unwrap_or("");

                match mtype {
                    "ALBUM_HEADER" => {
                        if let Some(album_val) = module.get("album") {
                            if let Ok(mut detail) =
                                serde_json::from_value::<TidalAlbumDetail>(album_val.clone())
                            {
                                detail.backfill_artist();
                                copyright = detail.copyright.clone();
                                album = Some(detail);
                            }
                        }
                        // Credits
                        if let Some(creds) = module.get("credits").and_then(|c| c.as_array()) {
                            for c in creds {
                                if let Ok(credit) = serde_json::from_value::<TidalCredit>(c.clone())
                                {
                                    credits.push(credit);
                                }
                            }
                        }
                        // Review
                        if let Some(rev) = module.get("review") {
                            if let Ok(r) = serde_json::from_value::<TidalReview>(rev.clone()) {
                                if r.text.is_some() {
                                    review = Some(r);
                                }
                            }
                        }
                    }
                    "ALBUM_ITEMS" => {
                        if let Some(paged) = module.get("pagedList") {
                            total_tracks = paged
                                .get("totalNumberOfItems")
                                .and_then(|n| n.as_u64())
                                .unwrap_or(0) as u32;

                            if let Some(items) = paged.get("items").and_then(|i| i.as_array()) {
                                for item_wrapper in items {
                                    // Items are wrapped as {item: {...}, type: "track"}
                                    let track_val =
                                        item_wrapper.get("item").unwrap_or(item_wrapper);
                                    if let Ok(mut track) =
                                        serde_json::from_value::<TidalTrack>(track_val.clone())
                                    {
                                        track.backfill_artist();
                                        // Extract vibrant color from first track's album
                                        if vibrant_color.is_none() {
                                            if let Some(ref alb) = track.album {
                                                vibrant_color = alb.vibrant_color.clone();
                                            }
                                        }
                                        tracks.push(track);
                                    }
                                }
                            }
                        }
                    }
                    "ALBUM_LIST" | "ARTIST_LIST" => {
                        let title = module
                            .get("title")
                            .and_then(|t| t.as_str())
                            .unwrap_or("")
                            .to_string();
                        let mut items: Vec<Value> = Vec::new();

                        if let Some(paged) = module.get("pagedList") {
                            if let Some(arr) = paged.get("items").and_then(|i| i.as_array()) {
                                items = arr.clone();
                            }
                        }

                        let api_path = module
                            .get("showMore")
                            .and_then(|sm| sm.get("apiPath"))
                            .and_then(|p| p.as_str())
                            .map(|s| s.to_string());

                        if !items.is_empty() {
                            sections.push(AlbumPageSection {
                                title,
                                section_type: mtype.to_string(),
                                items,
                                api_path,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }

        let album =
            album.ok_or_else(|| SoneError::Parse("album page: no ALBUM_HEADER found".into()))?;

        Ok(AlbumPageResponse {
            album,
            tracks,
            total_tracks,
            vibrant_color,
            copyright,
            credits,
            review,
            sections,
        })
    }

    pub async fn get_album_page(&mut self, album_id: u64) -> Result<AlbumPageResponse, SoneError> {
        let cc = self.country_code.clone();
        let id_str = album_id.to_string();
        let body = self
            .api_get_body(
                "/pages/album",
                &[
                    ("albumId", &id_str),
                    ("countryCode", &cc),
                    ("deviceType", "BROWSER"),
                ],
            )
            .await?;
        self.parse_album_page(&body)
    }

    pub async fn get_page(&mut self, api_path: &str) -> Result<HomePageResponse, SoneError> {
        let cc = self.country_code.clone();
        // Route v2 paths (home/*, artist/*, feed/*) through v2 base URL,
        // v1 paths (pages/*) through v1
        let path = if api_path.starts_with("http") {
            api_path.to_string()
        } else {
            let trimmed = api_path.trim_start_matches('/');
            if trimmed.starts_with("pages/") {
                format!("/{}", trimmed)
            } else {
                format!("{}/{}", TIDAL_API_V2_URL, trimmed)
            }
        };
        let is_v2 = path.contains("/v2/");
        let body = if is_v2 {
            self.api_get_body(
                &path,
                &[
                    ("countryCode", &cc),
                    ("locale", "en_US"),
                    ("deviceType", "BROWSER"),
                    ("platform", "WEB"),
                ],
            )
            .await?
        } else {
            self.api_get_body(&path, &[("countryCode", &cc), ("deviceType", "BROWSER")])
                .await?
        };

        let json: Value =
            serde_json::from_str(&body).map_err(|e| SoneError::Parse(e.to_string()))?;
        Self::parse_page_response(&json)
    }
}
