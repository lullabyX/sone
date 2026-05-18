use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::schemars::JsonSchema;
use rmcp::{ErrorData, tool_router};
use serde::Deserialize;
use tauri::Emitter;

use crate::mcp::events::{
    EV_CLEAR_QUEUE, EV_PAUSE, EV_PLAY_SOURCE, EV_PLAY_TRACKS, EV_REMOVE_FROM_QUEUE, EV_RESUME,
    EV_SEEK, EV_SET_REPEAT, EV_SET_VOLUME, EV_SKIP_NEXT, EV_SKIP_PREVIOUS, EV_TOGGLE_SHUFFLE,
    PlaySourcePayload, PlayTracksPayload, RemoveFromQueuePayload, RepeatPayload, SeekPayload,
    VolumePayload,
};
use crate::mcp::server::SoneMcpServer;

use super::util::NoArgs;

#[derive(Deserialize, JsonSchema)]
pub struct PlayTracksArgs {
    /// List of Tidal track IDs to act on. Must be non-empty.
    pub track_ids: Vec<u64>,
    /// "play_now" replaces queue and plays immediately; "queue" appends; "play_next" inserts after current track.
    pub action: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct PlaySourceArgs {
    /// "playlist", "album", "artist", or "mix"
    pub source_type: String,
    /// Tidal ID of the source.
    pub id: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct SeekArgs {
    /// Seconds from the start of the track.
    pub position_seconds: u32,
}

#[derive(Deserialize, JsonSchema)]
pub struct VolumeArgs {
    /// Volume level from 0.0 (silent) to 1.0 (max).
    pub level: f32,
}

#[derive(Deserialize, JsonSchema)]
pub struct RemoveFromQueueArgs {
    /// Tidal track ID to remove from the queue.
    pub track_id: u64,
}

#[derive(Deserialize, JsonSchema)]
pub struct RepeatArgs {
    /// "off", "all", or "one"
    pub mode: String,
}

#[tool_router(router = playback_tools, vis = "pub(crate)")]
impl SoneMcpServer {
    #[rmcp::tool(
        name = "play_tracks",
        description = "Play, queue, or insert tracks. action: \"play_now\" replaces the auto queue and plays immediately; \"queue\" appends to the Next-up list; \"play_next\" prepends to the Next-up list."
    )]
    async fn play_tracks(
        &self,
        Parameters(args): Parameters<PlayTracksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        if args.track_ids.is_empty() {
            return Err(ErrorData::invalid_params("track_ids must not be empty", None));
        }
        if !matches!(args.action.as_str(), "play_now" | "queue" | "play_next") {
            return Err(ErrorData::invalid_params(
                "action must be \"play_now\", \"queue\", or \"play_next\"",
                None,
            ));
        }
        let action = args.action.clone();
        self.app_handle
            .emit(EV_PLAY_TRACKS, PlayTracksPayload { track_ids: args.track_ids, action: args.action })
            .map_err(|e| ErrorData::internal_error(format!("emit failed: {e}"), None))?;
        let json = serde_json::json!({ "status": action });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(json.to_string())]))
    }

    #[rmcp::tool(
        name = "play_source",
        description = "Play an entire playlist, album, artist's top tracks, or mix immediately."
    )]
    async fn play_source(
        &self,
        Parameters(args): Parameters<PlaySourceArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        if !matches!(args.source_type.as_str(), "playlist" | "album" | "artist" | "mix") {
            return Err(ErrorData::invalid_params(
                "source_type must be \"playlist\", \"album\", \"artist\", or \"mix\"",
                None,
            ));
        }
        self.app_handle
            .emit(EV_PLAY_SOURCE, PlaySourcePayload { source_type: args.source_type, id: args.id })
            .map_err(|e| ErrorData::internal_error(format!("emit failed: {e}"), None))?;
        let json = serde_json::json!({ "status": "playing" });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(json.to_string())]))
    }

    #[rmcp::tool(name = "pause", description = "Pause playback.")]
    async fn pause(&self, Parameters(_): Parameters<NoArgs>) -> Result<CallToolResult, ErrorData> {
        self.app_handle
            .emit(EV_PAUSE, ())
            .map_err(|e| ErrorData::internal_error(format!("emit failed: {e}"), None))?;
        let json = serde_json::json!({ "status": "ok" });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(json.to_string())]))
    }

    #[rmcp::tool(name = "resume", description = "Resume playback.")]
    async fn resume(&self, Parameters(_): Parameters<NoArgs>) -> Result<CallToolResult, ErrorData> {
        self.app_handle
            .emit(EV_RESUME, ())
            .map_err(|e| ErrorData::internal_error(format!("emit failed: {e}"), None))?;
        let json = serde_json::json!({ "status": "ok" });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(json.to_string())]))
    }

    #[rmcp::tool(name = "skip_next", description = "Skip to the next track.")]
    async fn skip_next(
        &self,
        Parameters(_): Parameters<NoArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.app_handle
            .emit(EV_SKIP_NEXT, ())
            .map_err(|e| ErrorData::internal_error(format!("emit failed: {e}"), None))?;
        let json = serde_json::json!({ "status": "ok" });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(json.to_string())]))
    }

    #[rmcp::tool(name = "skip_previous", description = "Go back to the previous track.")]
    async fn skip_previous(
        &self,
        Parameters(_): Parameters<NoArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.app_handle
            .emit(EV_SKIP_PREVIOUS, ())
            .map_err(|e| ErrorData::internal_error(format!("emit failed: {e}"), None))?;
        let json = serde_json::json!({ "status": "ok" });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(json.to_string())]))
    }

    #[rmcp::tool(name = "clear_queue", description = "Clear the play queue.")]
    async fn clear_queue(
        &self,
        Parameters(_): Parameters<NoArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.app_handle
            .emit(EV_CLEAR_QUEUE, ())
            .map_err(|e| ErrorData::internal_error(format!("emit failed: {e}"), None))?;
        let json = serde_json::json!({ "status": "ok" });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(json.to_string())]))
    }

    #[rmcp::tool(name = "toggle_shuffle", description = "Toggle shuffle on/off.")]
    async fn toggle_shuffle(
        &self,
        Parameters(_): Parameters<NoArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.app_handle
            .emit(EV_TOGGLE_SHUFFLE, ())
            .map_err(|e| ErrorData::internal_error(format!("emit failed: {e}"), None))?;
        let json = serde_json::json!({ "status": "ok" });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(json.to_string())]))
    }

    #[rmcp::tool(
        name = "seek_to",
        description = "Seek to a position in the current track (seconds from start)."
    )]
    async fn seek_to(
        &self,
        Parameters(args): Parameters<SeekArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.app_handle
            .emit(EV_SEEK, SeekPayload { position_seconds: args.position_seconds })
            .map_err(|e| ErrorData::internal_error(format!("emit failed: {e}"), None))?;
        let json = serde_json::json!({ "status": "seeking" });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(json.to_string())]))
    }

    #[rmcp::tool(
        name = "set_volume",
        description = "Set playback volume from 0.0 (silent) to 1.0 (max)."
    )]
    async fn set_volume(
        &self,
        Parameters(args): Parameters<VolumeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let level = args.level.clamp(0.0, 1.0);
        self.app_handle
            .emit(EV_SET_VOLUME, VolumePayload { level })
            .map_err(|e| ErrorData::internal_error(format!("emit failed: {e}"), None))?;
        let json = serde_json::json!({ "status": "ok" });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(json.to_string())]))
    }

    #[rmcp::tool(
        name = "remove_from_queue",
        description = "Remove a specific track from the play queue by ID."
    )]
    async fn remove_from_queue(
        &self,
        Parameters(args): Parameters<RemoveFromQueueArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.app_handle
            .emit(EV_REMOVE_FROM_QUEUE, RemoveFromQueuePayload { track_id: args.track_id })
            .map_err(|e| ErrorData::internal_error(format!("emit failed: {e}"), None))?;
        let json = serde_json::json!({ "status": "removed" });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(json.to_string())]))
    }

    #[rmcp::tool(
        name = "set_repeat",
        description = "Set repeat mode. mode: \"off\", \"all\", or \"one\"."
    )]
    async fn set_repeat(
        &self,
        Parameters(args): Parameters<RepeatArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        if !matches!(args.mode.as_str(), "off" | "all" | "one") {
            return Err(ErrorData::invalid_params(
                "mode must be \"off\", \"all\", or \"one\"",
                None,
            ));
        }
        let mode = args.mode.clone();
        self.app_handle
            .emit(EV_SET_REPEAT, RepeatPayload { mode: args.mode })
            .map_err(|e| ErrorData::internal_error(format!("emit failed: {e}"), None))?;
        let json = serde_json::json!({ "status": mode });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(json.to_string())]))
    }
}
