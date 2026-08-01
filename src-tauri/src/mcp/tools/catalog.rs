use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::schemars::JsonSchema;
use rmcp::{ErrorData, tool_router};
use serde::Deserialize;
use tauri::Manager;

use crate::AppState;
use crate::mcp::sanitizer::{SanitizedAlbum, SanitizedArtist, SanitizedPlaylist, backfill_and_sanitize_tracks};
use crate::mcp::server::SoneMcpServer;

#[derive(Deserialize, JsonSchema)]
pub struct SearchTracksArgs {
    /// Search query string.
    pub query: String,
    /// Maximum number of results per category (tracks, albums, artists). Defaults to 10, max 50.
    pub limit: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
pub struct TrackRadioArgs {
    /// Tidal track ID to seed the radio.
    pub track_id: u64,
    /// Max similar tracks (default 10, max 50).
    pub limit: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
pub struct ArtistTopTracksArgs {
    /// Tidal artist ID.
    pub artist_id: u64,
    /// Max tracks to return (default 10, max 50).
    pub limit: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
pub struct AlbumTracksArgs {
    /// Tidal album ID.
    pub album_id: u64,
}

#[derive(Deserialize, JsonSchema)]
pub struct LyricsArgs {
    /// Tidal track ID.
    pub track_id: u64,
}

#[tool_router(router = catalog_tools, vis = "pub(crate)")]
impl SoneMcpServer {
    #[rmcp::tool(
        name = "search_tracks",
        description = "Search the Tidal catalog for tracks, albums, artists, and playlists. Returns up to `limit` of each."
    )]
    async fn search_tracks(
        &self,
        Parameters(SearchTracksArgs { query, limit }): Parameters<SearchTracksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let limit = limit.unwrap_or(10).min(50);
        let state = self.app_handle.state::<AppState>();
        let results = state
            .tidal_client
            .lock()
            .await
            .search(&query, limit)
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        let tracks = backfill_and_sanitize_tracks(results.tracks);
        let albums: Vec<SanitizedAlbum> = results.albums.iter().map(SanitizedAlbum::from_tidal).collect();
        let artists: Vec<SanitizedArtist> = results.artists.iter().map(SanitizedArtist::from_tidal).collect();
        let playlists: Vec<SanitizedPlaylist> = results.playlists.iter().map(SanitizedPlaylist::from_tidal).collect();

        let json = serde_json::json!({ "tracks": tracks, "albums": albums, "artists": artists, "playlists": playlists });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }

    #[rmcp::tool(
        name = "get_track_radio",
        description = "Get tracks similar to a given track (Tidal's recommendation engine)."
    )]
    async fn get_track_radio(
        &self,
        Parameters(TrackRadioArgs { track_id, limit }): Parameters<TrackRadioArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let limit = limit.unwrap_or(10).min(50) as usize;
        let state = self.app_handle.state::<AppState>();
        let mut client = state.tidal_client.lock().await;

        // Fetch the track detail to get the TRACK_MIX mix ID from the `mixes` field.
        let track_detail = client
            .get_track(track_id)
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        let mix_id = track_detail
            .get("mixes")
            .and_then(|m| m.get("TRACK_MIX"))
            .and_then(|v| v.as_str())
            .map(String::from)
            .ok_or_else(|| {
                ErrorData::internal_error(
                    format!("No TRACK_MIX available for track {}", track_id),
                    None,
                )
            })?;

        let mix = client
            .get_mix_items(&mix_id)
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        let tracks: Vec<_> = backfill_and_sanitize_tracks(mix.tracks)
            .into_iter()
            .take(limit)
            .collect();

        let json = serde_json::json!({ "tracks": tracks });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }

    #[rmcp::tool(
        name = "get_artist_top_tracks",
        description = "Get an artist's most-popular tracks."
    )]
    async fn get_artist_top_tracks(
        &self,
        Parameters(ArtistTopTracksArgs { artist_id, limit }): Parameters<ArtistTopTracksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let limit = limit.unwrap_or(10).min(50);
        let state = self.app_handle.state::<AppState>();
        let tracks = state
            .tidal_client
            .lock()
            .await
            .get_artist_top_tracks(artist_id, limit)
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        let tracks = backfill_and_sanitize_tracks(tracks);
        let json = serde_json::json!({ "tracks": tracks });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }

    #[rmcp::tool(
        name = "get_album_tracks",
        description = "Get the tracklist of an album."
    )]
    async fn get_album_tracks(
        &self,
        Parameters(AlbumTracksArgs { album_id }): Parameters<AlbumTracksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let state = self.app_handle.state::<AppState>();
        // Request up to 200 tracks (full album); offset 0 is sufficient for standard albums.
        let paginated = state
            .tidal_client
            .lock()
            .await
            .get_album_tracks(album_id, 0, 200)
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        let tracks = backfill_and_sanitize_tracks(paginated.items);
        let json = serde_json::json!({ "tracks": tracks });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }

    #[rmcp::tool(
        name = "get_track_lyrics",
        description = "Get the lyrics of a track if available. Returns plain text and optional sync points."
    )]
    async fn get_track_lyrics(
        &self,
        Parameters(LyricsArgs { track_id }): Parameters<LyricsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let state = self.app_handle.state::<AppState>();
        let lyrics = state
            .tidal_client
            .lock()
            .await
            .get_track_lyrics(track_id)
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;

        // Expose only fields useful to an LLM; drop provider ID fields (not user-facing).
        let json = serde_json::json!({
            "lyrics": lyrics.lyrics,
            "subtitles": lyrics.subtitles,
            "isRightToLeft": lyrics.is_right_to_left,
        });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }
}
