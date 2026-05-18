pub mod server;
pub mod state_mirror;

pub use server::{start_server, McpHandle, SoneMcpServer};
pub use state_mirror::{
    new_state, McpState, McpStateRef, NowPlayingSnapshot, QueueTrackSnapshot,
};
