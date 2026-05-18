pub mod server;
pub mod state_mirror;

pub use server::{start_server, McpHandle};
pub use state_mirror::{
    new_state, McpStateRef, NowPlayingSnapshot, QueueTrackSnapshot,
};
