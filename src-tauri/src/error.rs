use serde::Serialize;

/// Structured error type for all Sone backend operations.
/// Serialized as JSON to the frontend via Tauri IPC.
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum SoneError {
    /// HTTP API returned a non-success status.
    #[error("API error ({status}): {body}")]
    Api { status: u16, body: String },

    /// JSON deserialization or other parse failure.
    #[error("Parse error: {0}")]
    Parse(String),

    /// Network/transport failure (timeout, DNS, connection refused).
    #[error("Network error: {0}")]
    Network(String),

    /// No auth tokens available (user not logged in).
    #[error("Not authenticated")]
    NotAuthenticated,

    /// Client ID / secret not configured.
    #[error("Not configured: {0}")]
    NotConfigured(String),

    /// File system / IO error.
    #[error("IO error: {0}")]
    Io(String),

    /// GStreamer / audio pipeline error.
    #[error("Audio error: {0}")]
    Audio(String),

    /// Encryption / decryption failure.
    #[error("Crypto error: {0}")]
    Crypto(String),

    /// Scrobbling service error.
    #[error("Scrobble error: {0}")]
    Scrobble(String),
}

impl SoneError {
    /// Returns true if this is a network/transport error.
    pub fn is_network(&self) -> bool {
        matches!(self, SoneError::Network(_))
    }
}

impl From<std::io::Error> for SoneError {
    fn from(e: std::io::Error) -> Self {
        SoneError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for SoneError {
    fn from(e: serde_json::Error) -> Self {
        SoneError::Parse(e.to_string())
    }
}

impl From<reqwest::Error> for SoneError {
    fn from(e: reqwest::Error) -> Self {
        SoneError::Network(e.to_string())
    }
}

impl From<tauri::Error> for SoneError {
    fn from(e: tauri::Error) -> Self {
        SoneError::Io(e.to_string())
    }
}
