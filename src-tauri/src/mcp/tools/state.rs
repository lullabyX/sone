use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::schemars::JsonSchema;
use rmcp::{ErrorData, tool_router};
use serde::Deserialize;
use tauri::Manager;

use crate::AppState;
use crate::mcp::server::SoneMcpServer;

use super::util::NoArgs;

#[derive(Deserialize, JsonSchema)]
pub struct GetQueueArgs {
    /// Max items to return (default 20, max 50).
    pub limit: Option<u32>,
}

#[tool_router(router = state_tools, vis = "pub(crate)")]
impl SoneMcpServer {
    #[rmcp::tool(
        name = "get_now_playing",
        description = "Get the currently-playing track, position, duration, and play state. Returns nowPlaying:null if nothing is playing."
    )]
    async fn get_now_playing(
        &self,
        Parameters(_): Parameters<NoArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let state = self.app_handle.state::<AppState>();
        let s = state.mcp_state.read().await;
        let json = match &s.now_playing {
            Some(np) => serde_json::json!({ "nowPlaying": np }),
            None => serde_json::json!({ "nowPlaying": null }),
        };
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }

    #[rmcp::tool(
        name = "get_queue",
        description = "Get the upcoming tracks in the play queue. Returns up to `limit` items from the front of the queue."
    )]
    async fn get_queue(
        &self,
        Parameters(args): Parameters<GetQueueArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let limit = args.limit.unwrap_or(20).min(50) as usize;
        let state = self.app_handle.state::<AppState>();
        let s = state.mcp_state.read().await;
        let take: Vec<_> = s.queue.iter().take(limit).cloned().collect();
        let total = s.queue.len();
        let json = serde_json::json!({ "queue": take, "totalSnapshot": total });
        Ok(CallToolResult::success(vec![rmcp::model::Content::text(
            json.to_string(),
        )]))
    }
}
