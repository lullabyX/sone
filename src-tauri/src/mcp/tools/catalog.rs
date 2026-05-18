use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::schemars::JsonSchema;
use rmcp::{ErrorData, tool_router};
use serde::Deserialize;
use tauri::Manager;

use crate::AppState;
use crate::mcp::sanitizer::{SanitizedAlbum, SanitizedArtist, backfill_and_sanitize_tracks};
use crate::mcp::server::SoneMcpServer;

#[derive(Deserialize, JsonSchema)]
pub struct SearchTracksArgs {
    /// Search query string.
    pub query: String,
    /// Maximum number of results per category (tracks, albums, artists). Defaults to 10, max 50.
    pub limit: Option<u32>,
}

#[tool_router(router = catalog_tools, vis = "pub(crate)")]
impl SoneMcpServer {
    #[rmcp::tool(
        name = "search_tracks",
        description = "Search the Tidal catalog for tracks, albums, and artists. Returns up to `limit` of each."
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

        let json = serde_json::json!({ "tracks": tracks, "albums": albums, "artists": artists });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }
}
