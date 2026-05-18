use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::schemars::JsonSchema;
use rmcp::{ErrorData, tool_router};
use serde::Deserialize;
use tauri::Manager;

use crate::AppState;
use crate::mcp::sanitizer::{SanitizedPlaylist, backfill_and_sanitize_tracks};
use crate::mcp::server::SoneMcpServer;
use crate::tidal_api::TidalClient;

use super::util::require_user_id;

#[derive(Deserialize, JsonSchema, Default)]
pub struct NoArgs {}

#[derive(Deserialize, JsonSchema)]
pub struct GetPlaylistTracksArgs {
    /// Playlist UUID (preferred when known).
    pub playlist_uuid: Option<String>,
    /// Playlist name (case-insensitive lookup; used only if playlist_uuid is absent).
    pub playlist_name: Option<String>,
}

async fn resolve_playlist_uuid(
    client: &mut TidalClient,
    user_id: u64,
    uuid: Option<&str>,
    name: Option<&str>,
) -> Result<String, ErrorData> {
    if let Some(u) = uuid.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        return Ok(u.to_string());
    }
    let needle = name
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ErrorData::invalid_params(
                "playlist_uuid or playlist_name required".to_string(),
                None,
            )
        })?;
    let resp = client
        .get_user_playlists(user_id, 0, 200)
        .await
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    let lower = needle.to_lowercase();
    resp.items
        .into_iter()
        .find(|p| p.title.to_lowercase() == lower)
        .map(|p| p.uuid)
        .ok_or_else(|| {
            ErrorData::invalid_params(format!("Playlist not found: {needle}"), None)
        })
}

#[tool_router(router = playlists_tools, vis = "pub(crate)")]
impl SoneMcpServer {
    #[rmcp::tool(
        name = "get_user_playlists",
        description = "Get all of the user's playlists. Returns playlist uuid, title, and track count."
    )]
    async fn get_user_playlists(
        &self,
        Parameters(_): Parameters<NoArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let state = self.app_handle.state::<AppState>();
        let mut client = state.tidal_client.lock().await;
        let user_id = require_user_id(&client)?;
        let resp = client
            .get_user_playlists(user_id, 0, 200)
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let playlists: Vec<SanitizedPlaylist> =
            resp.items.iter().map(SanitizedPlaylist::from_tidal).collect();
        let json = serde_json::json!({ "playlists": playlists });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }

    #[rmcp::tool(
        name = "get_playlist_tracks",
        description = "Get all tracks in a playlist. Provide either playlist_uuid or playlist_name (case-insensitive)."
    )]
    async fn get_playlist_tracks(
        &self,
        Parameters(args): Parameters<GetPlaylistTracksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let state = self.app_handle.state::<AppState>();
        let mut client = state.tidal_client.lock().await;
        let user_id = require_user_id(&client)?;
        let uuid = resolve_playlist_uuid(
            &mut client,
            user_id,
            args.playlist_uuid.as_deref(),
            args.playlist_name.as_deref(),
        )
        .await?;
        let raw_tracks = client
            .get_playlist_tracks(&uuid)
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let tracks = backfill_and_sanitize_tracks(raw_tracks);
        let json = serde_json::json!({ "tracks": tracks, "uuid": uuid });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }
}
