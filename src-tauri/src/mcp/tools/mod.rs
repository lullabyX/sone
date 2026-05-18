mod catalog;
mod favorites;
mod playlists;
mod util;

use rmcp::handler::server::router::tool::ToolRouter;

use crate::mcp::server::SoneMcpServer;

pub fn build_router() -> ToolRouter<SoneMcpServer> {
    SoneMcpServer::catalog_tools()
        + SoneMcpServer::favorites_tools()
        + SoneMcpServer::playlists_tools()
}
