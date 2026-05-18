use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::schemars::JsonSchema;
use rmcp::{ErrorData, tool_router};
use serde::Deserialize;
use tauri::Manager;

use crate::AppState;
use crate::mcp::sanitizer::{SanitizedAlbum, SanitizedArtist, backfill_and_sanitize_tracks};
use crate::mcp::server::SoneMcpServer;

use super::util::require_user_id;

#[derive(Deserialize, JsonSchema)]
pub struct PaginatedArgs {
    /// Max items to return (default 50, max 100).
    pub limit: Option<u32>,
    /// Offset for pagination (default 0).
    pub offset: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
pub struct TrackIdArgs {
    pub track_id: u64,
}

#[tool_router(router = favorites_tools, vis = "pub(crate)")]
impl SoneMcpServer {
    #[rmcp::tool(
        name = "get_favorite_tracks",
        description = "Get the user's favorite tracks, paginated. Returns track id, title, artist, album, and duration in seconds."
    )]
    async fn get_favorite_tracks(
        &self,
        Parameters(args): Parameters<PaginatedArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let limit = args.limit.unwrap_or(50).min(100);
        let offset = args.offset.unwrap_or(0);
        let state = self.app_handle.state::<AppState>();
        let mut client = state.tidal_client.lock().await;
        let user_id = require_user_id(&client)?;
        let resp = client
            .get_favorite_tracks(user_id, offset, limit, "DATE", "DESC")
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let total = resp.total_number_of_items;
        let tracks = backfill_and_sanitize_tracks(resp.items);
        let json = serde_json::json!({
            "tracks": tracks,
            "total": total,
            "offset": offset,
            "limit": limit,
        });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }

    #[rmcp::tool(
        name = "get_favorite_albums",
        description = "Get the user's favorite albums, paginated. Returns album id, title, artist, track count, and release year."
    )]
    async fn get_favorite_albums(
        &self,
        Parameters(args): Parameters<PaginatedArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let limit = args.limit.unwrap_or(50).min(100);
        let offset = args.offset.unwrap_or(0);
        let state = self.app_handle.state::<AppState>();
        let mut client = state.tidal_client.lock().await;
        let user_id = require_user_id(&client)?;
        let resp = client
            .get_favorite_albums(user_id, offset, limit, "DATE", "DESC")
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let total = resp.total_number_of_items;
        let albums: Vec<SanitizedAlbum> = resp.items.iter().map(SanitizedAlbum::from_tidal).collect();
        let json = serde_json::json!({
            "albums": albums,
            "total": total,
            "offset": offset,
            "limit": limit,
        });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }

    #[rmcp::tool(
        name = "get_favorite_artists",
        description = "Get the user's favorite artists, paginated. Returns artist id and name."
    )]
    async fn get_favorite_artists(
        &self,
        Parameters(args): Parameters<PaginatedArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let limit = args.limit.unwrap_or(50).min(100);
        let offset = args.offset.unwrap_or(0);
        let state = self.app_handle.state::<AppState>();
        let mut client = state.tidal_client.lock().await;
        let user_id = require_user_id(&client)?;
        let resp = client
            .get_favorite_artists(user_id, offset, limit, "DATE", "DESC")
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let total = resp.total_number_of_items;
        let artists: Vec<SanitizedArtist> = resp.items.iter().map(SanitizedArtist::from_tidal_detail).collect();
        let json = serde_json::json!({
            "artists": artists,
            "total": total,
            "offset": offset,
            "limit": limit,
        });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }

    #[rmcp::tool(
        name = "is_track_favorited",
        description = "Check whether a track is in the user's favorites."
    )]
    async fn is_track_favorited(
        &self,
        Parameters(args): Parameters<TrackIdArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let state = self.app_handle.state::<AppState>();
        let client = state.tidal_client.lock().await;
        let user_id = require_user_id(&client)?;
        let favorited = client
            .is_track_favorited(user_id, args.track_id)
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let json = serde_json::json!({ "favorited": favorited });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }
}
