use std::net::SocketAddr;

use rmcp::handler::server::ServerHandler;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::model::{Implementation, ProtocolVersion, ServerCapabilities, ServerInfo};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::StreamableHttpService;
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use crate::error::SoneError;

#[derive(Clone)]
pub struct SoneMcpServer {
    pub(crate) app_handle: AppHandle,
    pub(crate) tool_router: ToolRouter<Self>,
}

#[rmcp::tool_handler(router = self.tool_router)]
impl ServerHandler for SoneMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_protocol_version(ProtocolVersion::V_2024_11_05)
            .with_server_info(Implementation::new("sone", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "SONE — Tidal music player. Tools cover catalog search, favorites, playlists, playback, and queue control.",
            )
    }
}

pub struct McpHandle {
    pub(crate) port: u16,
    pub(crate) token: String,
    pub(crate) cancel: CancellationToken,
}

impl McpHandle {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/{}/mcp", self.port, self.token)
    }
}

pub async fn start_server(
    app_handle: AppHandle,
    port: u16,
    token: String,
) -> Result<McpHandle, SoneError> {
    let cancel = CancellationToken::new();

    let server = SoneMcpServer {
        app_handle: app_handle.clone(),
        tool_router: crate::mcp::tools::build_router(),
    };

    let service = StreamableHttpService::new(
        move || Ok(server.clone()),
        LocalSessionManager::default().into(),
        Default::default(),
    );

    let path = format!("/{}/mcp", token);
    let app = axum::Router::new().nest_service(&path, service);

    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| SoneError::Mcp(format!("bind {addr}: {e}")))?;
    let bound_port = listener
        .local_addr()
        .map_err(|e| SoneError::Mcp(format!("local_addr: {e}")))?
        .port();

    log::info!(
        "MCP server listening on http://127.0.0.1:{}/{}/mcp",
        bound_port,
        token
    );

    let cancel_clone = cancel.clone();
    tokio::spawn(async move {
        tokio::select! {
            result = axum::serve(listener, app) => {
                if let Err(e) = result {
                    log::error!("MCP server exited with error: {e}");
                }
            }
            _ = cancel_clone.cancelled() => {
                log::info!("MCP server shutting down (abrupt)");
            }
        }
    });

    Ok(McpHandle {
        port: bound_port,
        token,
        cancel,
    })
}
