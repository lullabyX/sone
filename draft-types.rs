// v1/pages/explore

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExploreResponse {
    pub self_link: Option<String>,
    pub id: String,
    pub title: String,
    pub rows: Vec<ExploreRow>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExploreRow {
    pub modules: Vec<ExploreModule>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExploreModule {
    pub id: String,
    #[serde(rename = "type")]
    pub module_type: String,
    pub width: i32,
    pub title: String,
    pub description: String,
    pub show_more: Option<ShowMore>,
    pub paged_list: PagedList,
    pub lines: Option<i32>,
    pub pre_title: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowMore {
    pub title: String,
    pub api_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PagedList {
    pub data_api_path: Option<String>,
    pub limit: i32,
    pub offset: i32,
    pub total_number_of_items: i32,
    pub items: Vec<ExploreItem>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExploreItem {
    pub title: String,
    pub icon: Option<String>,
    pub api_path: String,
    pub image_id: Option<String>,
}

// v1/pages/genre_pop

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TidalPageResponse {
    pub self_link: Option<String>,
    pub id: String,
    pub title: String,
    pub rows: Vec<Row>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub modules: Vec<Module>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Module {
    pub id: String,
    #[serde(rename = "type")]
    pub module_type: String,
    pub width: i64,
    pub scroll: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub show_more: Option<ShowMore>,
    pub paged_list: PagedList,
    pub supports_paging: Option<bool>,
    pub layout: Option<String>,
    pub quick_play: Option<bool>,
    pub playlist_style: Option<String>,
    pub pre_title: Option<String>,
    pub list_format: Option<String>,
    pub show_table_headers: Option<bool>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowMore {
    pub title: String,
    pub api_path: String,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PagedList {
    pub data_api_path: String,
    pub limit: i64,
    pub offset: i64,
    pub total_number_of_items: i64,
    pub items: Vec<ModuleItem>,
}

/// An untagged enum to handle the polymorphic nature of the "items" array.
/// Serde will try to match the JSON to the variant fields in order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ModuleItem {
    Playlist(Playlist),
    Video(Video),
    Track(Track),
    Album(Album),
    Artist(Artist),
}

// --- Specific Item Structs ---

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub uuid: String,
    pub title: String,
    #[serde(rename = "type")]
    pub playlist_type: String,
    pub url: String,
    pub image: Option<String>,
    pub square_image: Option<String>,
    pub duration: i64,
    pub number_of_tracks: i64,
    pub number_of_videos: i64,
    pub last_item_added_at: String,
    pub promoted_artists: Vec<ArtistSummary>,
    pub creators: Vec<Creator>,
    pub description: Option<String>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub title: String,
    pub duration: i64,
    pub version: Option<String>,
    pub url: String,
    pub artists: Vec<ArtistSummary>,
    pub album: AlbumSummary,
    pub explicit: bool,
    pub volume_number: i64,
    pub track_number: i64,
    pub popularity: i64,
    pub double_popularity: f64,
    pub allow_streaming: bool,
    pub stream_ready: bool,
    pub stream_start_date: Option<String>,
    pub ad_supported_stream_ready: bool,
    pub dj_ready: bool,
    pub stem_ready: bool,
    pub editable: bool,
    pub replay_gain: f64,
    pub audio_quality: String,
    pub audio_modes: Vec<String>,
    pub mixes: Option<Mixes>,
    pub media_metadata: Option<MediaMetadata>,
    pub upload: bool,
    pub pay_to_stream: bool,
    pub access_type: String,
    pub spotlighted: bool,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Video {
    pub id: i64,
    pub title: String,
    pub duration: i64,
    pub version: Option<String>,
    pub url: String,
    pub artists: Vec<ArtistSummary>,
    pub album: Option<AlbumSummary>,
    pub explicit: bool,
    pub volume_number: i64,
    pub track_number: i64,
    pub popularity: i64,
    pub double_popularity: f64,
    pub allow_streaming: bool,
    pub stream_ready: bool,
    pub stream_start_date: String,
    pub ad_supported_stream_ready: bool,
    pub dj_ready: bool,
    pub stem_ready: bool,
    pub image_id: String,
    pub vibrant_color: Option<String>,
    pub release_date: String,
    #[serde(rename = "type")]
    pub video_type: String,
    pub ads_url: Option<String>,
    pub ads_pre_paywall_only: bool,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: i64,
    pub title: String,
    pub cover: String,
    pub vibrant_color: Option<String>,
    pub video_cover: Option<String>,
    pub url: String,
    pub artists: Vec<ArtistSummary>,
    pub explicit: bool,
    pub stream_ready: bool,
    pub stream_start_date: String,
    pub allow_streaming: bool,
    pub pay_to_stream: bool,
    pub number_of_tracks: i64,
    pub number_of_videos: i64,
    pub audio_quality: String,
    pub audio_modes: Vec<String>,
    pub release_date: String,
    pub duration: i64,
    pub upload: bool,
    pub media_metadata: Option<MediaMetadata>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub id: i64,
    pub name: String,
    pub picture: Option<String>,
    pub selected_album_cover_fallback: Option<String>,
    pub artist_types: Option<Vec<String>>,
    pub artist_roles: Option<Vec<ArtistRole>>,
    pub mixes: Option<Mixes>,
    pub handle: Option<String>,
    pub user_id: Option<i64>,
    pub contribution_link_url: Option<String>,
    // Only used in Playlists sometimes
    #[serde(rename = "type")]
    pub artist_type_in_playlist: Option<String>, 
}

// --- Helpers ---

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistSummary {
    pub id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub artist_type: String,
    pub picture: Option<String>,
    pub handle: Option<String>,
    pub user_id: Option<i64>,
    pub contribution_link_url: Option<String>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumSummary {
    pub id: i64,
    pub title: String,
    pub cover: Option<String>,
    pub vibrant_color: Option<String>,
    pub video_cover: Option<String>,
    pub url: String,
    pub release_date: Option<String>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Creator {
    pub id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub creator_type: Option<String>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetadata {
    pub tags: Vec<String>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mixes {
    #[serde(rename = "TRACK_MIX")]
    pub track_mix: Option<String>,
    #[serde(rename = "ARTIST_MIX")]
    pub artist_mix: Option<String>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistRole {
    pub category: String,
    pub category_id: i64,
}

// v1/pages/genre_page


use serde::{Deserialize, Serialize};

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenresResponse {
    pub self_link: Option<String>,
    pub id: String,
    pub title: String,
    pub rows: Vec<Row>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub modules: Vec<Module>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Module {
    pub id: String,
    #[serde(rename = "type")]
    pub module_type: String,
    pub width: i64,
    pub title: String,
    pub description: String,
    pub paged_list: PagedList,
    pub pre_title: Option<String>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PagedList {
    pub limit: i64,
    pub offset: i64,
    pub total_number_of_items: i64,
    pub items: Vec<Item>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub title: String,
    pub icon: Option<String>,
    pub api_path: String,
    pub image_id: Option<String>,
}

// v1/pages/m_1960

use serde::{Deserialize, Serialize};

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TidalPageResponse {
    pub self_link: Option<String>,
    pub id: String,
    pub title: String,
    pub rows: Vec<Row>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub modules: Vec<Module>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Module {
    pub id: String,
    #[serde(rename = "type")]
    pub module_type: String,
    pub width: i64,
    pub scroll: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub show_more: Option<ShowMore>,
    pub paged_list: PagedList,
    pub list_format: Option<String>,
    pub supports_paging: Option<bool>,
    pub layout: Option<String>,
    pub quick_play: Option<bool>,
    pub playlist_style: Option<String>,
    pub pre_title: Option<String>,
    pub header: Option<String>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowMore {
    pub title: String,
    pub api_path: String,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PagedList {
    pub data_api_path: String,
    pub limit: i64,
    pub offset: i64,
    pub total_number_of_items: i64,
    pub items: Vec<ModuleItem>,
}

/// Untagged enum to handle different item types in the list (Playlist, Album).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ModuleItem {
    Playlist(Playlist),
    Album(Album),
}

// --- Item Variants ---

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub uuid: String,
    pub title: String,
    #[serde(rename = "type")]
    pub playlist_type: String,
    pub url: String,
    pub image: Option<String>,
    pub square_image: Option<String>,
    pub duration: i64,
    pub number_of_tracks: i64,
    pub number_of_videos: i64,
    pub last_item_added_at: String,
    pub promoted_artists: Vec<ArtistSummary>,
    pub creators: Vec<Creator>,
    pub description: Option<String>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: i64,
    pub title: String,
    pub cover: String,
    pub vibrant_color: Option<String>,
    pub video_cover: Option<String>,
    pub url: String,
    pub artists: Vec<ArtistSummary>,
    pub explicit: bool,
    pub stream_ready: bool,
    pub stream_start_date: String,
    pub allow_streaming: bool,
    pub pay_to_stream: bool,
    pub number_of_tracks: i64,
    pub number_of_videos: i64,
    pub audio_quality: String,
    pub audio_modes: Vec<String>,
    pub release_date: String,
    pub duration: i64,
    pub upload: bool,
    pub media_metadata: Option<MediaMetadata>,
}

// --- Helpers ---

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistSummary {
    pub id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub artist_type: String,
    pub picture: Option<String>,
    pub handle: Option<String>,
    pub user_id: Option<i64>,
    pub contribution_link_url: Option<String>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Creator {
    pub id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub creator_type: Option<String>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetadata {
    pub tags: Vec<String>,
}

// v1/pages/explore_top_music

use serde::{Deserialize, Serialize};

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TidalPageResponse {
    pub self_link: Option<String>,
    pub id: String,
    pub title: String,
    pub rows: Vec<Row>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub modules: Vec<Module>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Module {
    pub id: String,
    #[serde(rename = "type")]
    pub module_type: String,
    pub width: i64,
    pub scroll: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub show_more: Option<ShowMore>,
    pub paged_list: PagedList,
    pub list_format: Option<String>,
    pub supports_paging: Option<bool>,
    pub layout: Option<String>,
    pub quick_play: Option<bool>,
    pub playlist_style: Option<String>,
    pub pre_title: Option<String>,
    pub header: Option<String>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowMore {
    pub title: String,
    pub api_path: String,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PagedList {
    pub data_api_path: String,
    pub limit: i64,
    pub offset: i64,
    pub total_number_of_items: i64,
    pub items: Vec<ModuleItem>,
}

/// Untagged enum to handle the polymorphic `items` array.
/// Serde will attempt to match the JSON against the variants in order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ModuleItem {
    Playlist(Playlist),
    Track(Track),
    Album(Album),
    Artist(Artist),
}

// --- Entity Structs ---

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub uuid: String,
    pub title: String,
    #[serde(rename = "type")]
    pub playlist_type: String,
    pub url: String,
    pub image: Option<String>,
    pub square_image: Option<String>,
    pub duration: i64,
    pub number_of_tracks: i64,
    pub number_of_videos: i64,
    pub last_item_added_at: String,
    pub promoted_artists: Vec<ArtistSummary>,
    pub creators: Vec<Creator>,
    pub description: Option<String>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub title: String,
    pub duration: i64,
    pub version: Option<String>,
    pub url: String,
    pub artists: Vec<ArtistSummary>,
    pub album:


