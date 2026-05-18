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

use super::util::{require_user_id, NoArgs};

#[derive(Deserialize, JsonSchema)]
pub struct CreatePlaylistArgs {
    /// Playlist name (non-empty).
    pub name: String,
    /// Optional description; defaults to empty string.
    pub description: Option<String>,
    /// Optional list of track IDs to add immediately after creation.
    pub track_ids: Option<Vec<u64>>,
}

#[derive(Deserialize, JsonSchema)]
pub struct UpdatePlaylistArgs {
    pub playlist_uuid: String,
    /// New name (if updating).
    pub name: Option<String>,
    /// New description (if updating).
    pub description: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct DeletePlaylistArgs {
    pub playlist_uuid: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct AddToPlaylistArgs {
    pub playlist_uuid: Option<String>,
    pub playlist_name: Option<String>,
    /// Track IDs to add (must be non-empty).
    pub track_ids: Vec<u64>,
}

#[derive(Deserialize, JsonSchema)]
pub struct RemoveTrackFromPlaylistArgs {
    pub playlist_uuid: String,
    /// 0-based index of the track within the playlist.
    pub index: u32,
}

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

    #[rmcp::tool(
        name = "create_playlist",
        description = "Create a new playlist with optional initial tracks. Returns the new playlist's uuid."
    )]
    async fn create_playlist(
        &self,
        Parameters(args): Parameters<CreatePlaylistArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let name = args.name.trim().to_string();
        if name.is_empty() {
            return Err(ErrorData::invalid_params("Playlist name required", None));
        }
        let description = args.description.unwrap_or_default();
        let state = self.app_handle.state::<AppState>();
        let client = state.tidal_client.lock().await;
        let user_id = require_user_id(&client)?;
        let playlist = client
            .create_playlist(&name, &description, "PUBLIC")
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let uuid = playlist.uuid.clone();
        let track_count = if let Some(ids) = args.track_ids.filter(|v| !v.is_empty()) {
            client
                .add_tracks_to_playlist(&uuid, &ids)
                .await
                .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
            ids.len() as u32
        } else {
            0
        };
        state
            .disk_cache
            .invalidate_tag(&format!("user:{}", user_id))
            .await;
        state.disk_cache.invalidate_tag("folders").await;
        let json = serde_json::json!({ "uuid": uuid, "name": playlist.title, "trackCount": track_count });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }

    #[rmcp::tool(
        name = "update_playlist",
        description = "Rename a playlist or change its description."
    )]
    async fn update_playlist(
        &self,
        Parameters(args): Parameters<UpdatePlaylistArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let state = self.app_handle.state::<AppState>();
        let mut client = state.tidal_client.lock().await;
        // Fetch current playlist details to use as fallback for unchanged fields.
        let current = client
            .get_playlist_details(&args.playlist_uuid)
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let current_name = current
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let current_desc = current
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let current_access = current
            .get("accessType")
            .and_then(|v| v.as_str())
            .unwrap_or("PUBLIC")
            .to_string();
        let new_name = args.name.as_deref().unwrap_or(&current_name);
        let new_desc = args.description.as_deref().unwrap_or(&current_desc);
        client
            .update_playlist(&args.playlist_uuid, new_name, new_desc, &current_access)
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let user_id = require_user_id(&client)?;
        state
            .disk_cache
            .invalidate_tag(&format!("user:{}", user_id))
            .await;
        state
            .disk_cache
            .invalidate_tag(&format!("playlist:{}", args.playlist_uuid))
            .await;
        state.disk_cache.invalidate_tag("folders").await;
        let json = serde_json::json!({ "status": "updated" });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }

    #[rmcp::tool(
        name = "delete_playlist",
        description = "Permanently delete a playlist. Cannot be undone."
    )]
    async fn delete_playlist(
        &self,
        Parameters(args): Parameters<DeletePlaylistArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let state = self.app_handle.state::<AppState>();
        let client = state.tidal_client.lock().await;
        let user_id = require_user_id(&client)?;
        client
            .delete_playlist(&args.playlist_uuid)
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        state
            .disk_cache
            .invalidate_tag(&format!("user:{}", user_id))
            .await;
        state
            .disk_cache
            .invalidate_tag(&format!("playlist:{}", args.playlist_uuid))
            .await;
        state.disk_cache.invalidate_tag("folders").await;
        let json = serde_json::json!({ "status": "deleted" });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }

    #[rmcp::tool(
        name = "add_to_playlist",
        description = "Add tracks to an existing playlist (by uuid or name)."
    )]
    async fn add_to_playlist(
        &self,
        Parameters(args): Parameters<AddToPlaylistArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        if args.track_ids.is_empty() {
            return Err(ErrorData::invalid_params("track_ids must not be empty", None));
        }
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
        let added = args.track_ids.len();
        client
            .add_tracks_to_playlist(&uuid, &args.track_ids)
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        state
            .disk_cache
            .invalidate_tag(&format!("playlist:{}", uuid))
            .await;
        let json = serde_json::json!({ "uuid": uuid, "added": added });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }

    #[rmcp::tool(
        name = "remove_track_from_playlist",
        description = "Remove a track from a playlist by its 0-based index in the tracklist."
    )]
    async fn remove_track_from_playlist(
        &self,
        Parameters(args): Parameters<RemoveTrackFromPlaylistArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let state = self.app_handle.state::<AppState>();
        let client = state.tidal_client.lock().await;
        client
            .remove_track_from_playlist(&args.playlist_uuid, args.index)
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        state
            .disk_cache
            .invalidate_tag(&format!("playlist:{}", args.playlist_uuid))
            .await;
        let json = serde_json::json!({ "status": "removed" });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }
}
