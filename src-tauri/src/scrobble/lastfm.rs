use std::collections::BTreeMap;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::SoneError;

use super::{ScrobbleProvider, ScrobbleResult, ScrobbleTrack};

// ---------------------------------------------------------------------------
// Session data
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionData {
    pub session_key: String,
    pub username: String,
}

// ---------------------------------------------------------------------------
// AudioscrobblerProvider
// ---------------------------------------------------------------------------

pub struct AudioscrobblerProvider {
    name: &'static str,
    api_url: &'static str,
    auth_base_url: &'static str,
    api_key: String,
    api_secret: String,
    session: RwLock<Option<SessionData>>,
    client: reqwest::Client,
}

impl AudioscrobblerProvider {
    pub fn new(
        name: &'static str,
        api_url: &'static str,
        auth_base_url: &'static str,
        api_key: String,
        api_secret: String,
        client: reqwest::Client,
    ) -> Self {
        Self {
            name,
            api_url,
            auth_base_url,
            api_key,
            api_secret,
            session: RwLock::new(None),
            client,
        }
    }

    pub async fn set_session(&self, session_key: String, username: String) {
        let mut session = self.session.write().await;
        *session = Some(SessionData {
            session_key,
            username,
        });
    }

    /// Fetch an unauthorized request token from the API (desktop auth step 2).
    pub async fn get_token(&self) -> Result<String, SoneError> {
        let mut params = BTreeMap::new();
        params.insert("method", "auth.getToken".to_string());
        params.insert("api_key", self.api_key.clone());

        let sig = self.sign(&params);
        params.insert("api_sig", sig);
        params.insert("format", "json".to_string());

        let resp = self
            .client
            .get(self.api_url)
            .query(&params)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| SoneError::Scrobble(format!("auth.getToken request failed: {e}")))?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| SoneError::Scrobble(format!("auth.getToken parse failed: {e}")))?;

        if let Some(err_code) = Self::parse_error_code(&body) {
            return Err(SoneError::Scrobble(format!(
                "auth.getToken error {err_code}: {}",
                body.get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown error")
            )));
        }

        body.get("token")
            .and_then(|t| t.as_str())
            .map(|t| t.to_string())
            .ok_or_else(|| SoneError::Scrobble("auth.getToken: missing token".into()))
    }

    /// Generate the browser auth URL for the user to grant access (desktop auth step 3).
    /// The token must be obtained from `get_token()` first.
    pub fn auth_url_with_token(&self, token: &str) -> String {
        format!(
            "{}?api_key={}&token={}",
            self.auth_base_url, self.api_key, token
        )
    }

    /// Exchange an auth token for a permanent session key.
    /// Returns (session_key, username).
    pub async fn get_session(&self, token: &str) -> Result<(String, String), SoneError> {
        let mut params = BTreeMap::new();
        params.insert("method", "auth.getSession".to_string());
        params.insert("api_key", self.api_key.clone());
        params.insert("token", token.to_string());

        let sig = self.sign(&params);
        params.insert("api_sig", sig);
        params.insert("format", "json".to_string());

        let resp = self
            .client
            .post(self.api_url)
            .form(&params)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| SoneError::Scrobble(format!("auth.getSession request failed: {e}")))?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| SoneError::Scrobble(format!("auth.getSession parse failed: {e}")))?;

        if let Some(err_code) = Self::parse_error_code(&body) {
            return Err(SoneError::Scrobble(format!(
                "auth.getSession error {err_code}: {}",
                body.get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown error")
            )));
        }

        let session = body
            .get("session")
            .ok_or_else(|| SoneError::Scrobble("auth.getSession: missing session".into()))?;
        let key = session
            .get("key")
            .and_then(|k| k.as_str())
            .ok_or_else(|| SoneError::Scrobble("auth.getSession: missing key".into()))?;
        let name = session
            .get("name")
            .and_then(|n| n.as_str())
            .ok_or_else(|| SoneError::Scrobble("auth.getSession: missing name".into()))?;

        Ok((key.to_string(), name.to_string()))
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /// MD5 API signature.
    /// Algorithm: sort params alphabetically by key, concatenate key1value1key2value2...,
    /// append api_secret, compute MD5 hex digest.
    /// The "format" and "callback" params are excluded from the signature.
    fn sign(&self, params: &BTreeMap<&str, String>) -> String {
        let mut sig_input = String::new();
        for (k, v) in params {
            if *k == "format" || *k == "callback" {
                continue;
            }
            sig_input.push_str(k);
            sig_input.push_str(v);
        }
        sig_input.push_str(&self.api_secret);
        format!("{:x}", md5::compute(sig_input.as_bytes()))
    }

    /// Same as `sign` but for indexed params (batch scrobbles like artist[0], track[0]).
    /// Params are already sorted as (String, String) tuples.
    fn sign_indexed(&self, params: &[(String, String)]) -> String {
        // Sort by key alphabetically
        let mut sorted: Vec<(&str, &str)> = params
            .iter()
            .filter(|(k, _)| k != "format" && k != "callback")
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        sorted.sort_by_key(|(k, _)| *k);

        let mut sig_input = String::new();
        for (k, v) in sorted {
            sig_input.push_str(k);
            sig_input.push_str(v);
        }
        sig_input.push_str(&self.api_secret);
        format!("{:x}", md5::compute(sig_input.as_bytes()))
    }

    /// Get session key or return an error.
    async fn session_key(&self) -> Result<String, SoneError> {
        let session = self.session.read().await;
        session
            .as_ref()
            .map(|s| s.session_key.clone())
            .ok_or_else(|| SoneError::Scrobble(format!("{}: not authenticated", self.name)))
    }

    /// Parse an error code from a Last.fm API JSON response.
    fn parse_error_code(body: &serde_json::Value) -> Option<u32> {
        body.get("error").and_then(|e| e.as_u64()).map(|e| e as u32)
    }
}

// ---------------------------------------------------------------------------
// ScrobbleProvider trait implementation
// ---------------------------------------------------------------------------

#[async_trait]
impl ScrobbleProvider for AudioscrobblerProvider {
    fn name(&self) -> &str {
        self.name
    }

    fn is_authenticated(&self) -> bool {
        self.session
            .try_read()
            .map(|s| s.is_some())
            .unwrap_or(false)
    }

    fn max_batch_size(&self) -> usize {
        50
    }

    async fn username(&self) -> Option<String> {
        let session = self.session.read().await;
        session.as_ref().map(|s| s.username.clone())
    }

    async fn now_playing(&self, track: &ScrobbleTrack) -> ScrobbleResult {
        let sk = match self.session_key().await {
            Ok(sk) => sk,
            Err(_) => return ScrobbleResult::AuthError("not authenticated".into()),
        };

        let mut params = BTreeMap::new();
        params.insert("method", "track.updateNowPlaying".to_string());
        params.insert("artist", track.artist.clone());
        params.insert("track", track.track.clone());
        params.insert("api_key", self.api_key.clone());
        params.insert("sk", sk);
        params.insert("duration", track.duration_secs.to_string());

        if let Some(ref album) = track.album {
            params.insert("album", album.clone());
        }
        if let Some(ref album_artist) = track.album_artist {
            params.insert("albumArtist", album_artist.clone());
        }
        if let Some(track_number) = track.track_number {
            params.insert("trackNumber", track_number.to_string());
        }

        let sig = self.sign(&params);
        params.insert("api_sig", sig);
        params.insert("format", "json".to_string());

        let result = self
            .client
            .post(self.api_url)
            .form(&params)
            .timeout(Duration::from_secs(5))
            .send()
            .await;

        match result {
            Ok(resp) => {
                if let Ok(body) = resp.json::<serde_json::Value>().await {
                    if let Some(code) = Self::parse_error_code(&body) {
                        let msg = body
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        log::warn!("{}: now_playing error {code}: {msg}", self.name);
                        // Auth errors must be surfaced so the provider gets disconnected
                        if matches!(code, 9 | 10 | 26) {
                            return ScrobbleResult::AuthError(msg);
                        }
                        // All other now_playing failures are non-critical
                        return ScrobbleResult::Ok;
                    }
                }
                ScrobbleResult::Ok
            }
            Err(e) => {
                log::warn!("{}: now_playing failed: {e}", self.name);
                // Network failures for now_playing are non-critical
                ScrobbleResult::Ok
            }
        }
    }

    async fn scrobble(&self, tracks: &[ScrobbleTrack]) -> ScrobbleResult {
        let sk = match self.session_key().await {
            Ok(sk) => sk,
            Err(_) => return ScrobbleResult::AuthError("not authenticated".into()),
        };

        // Build indexed params for batch scrobble
        let mut params: Vec<(String, String)> = Vec::new();
        params.push(("method".to_string(), "track.scrobble".to_string()));
        params.push(("api_key".to_string(), self.api_key.clone()));
        params.push(("sk".to_string(), sk));

        for (i, track) in tracks.iter().enumerate() {
            params.push((format!("artist[{i}]"), track.artist.clone()));
            params.push((format!("track[{i}]"), track.track.clone()));
            params.push((format!("timestamp[{i}]"), track.timestamp.to_string()));
            params.push((format!("duration[{i}]"), track.duration_secs.to_string()));

            if let Some(ref album) = track.album {
                params.push((format!("album[{i}]"), album.clone()));
            }
            if let Some(ref album_artist) = track.album_artist {
                params.push((format!("albumArtist[{i}]"), album_artist.clone()));
            }
            if let Some(track_number) = track.track_number {
                params.push((format!("trackNumber[{i}]"), track_number.to_string()));
            }
            if !track.chosen_by_user {
                params.push((format!("chosenByUser[{i}]"), "0".to_string()));
            }
            if let Some(ref mbid) = track.recording_mbid {
                params.push((format!("mbid[{i}]"), mbid.clone()));
            }
        }

        let sig = self.sign_indexed(&params);
        params.push(("api_sig".to_string(), sig));
        params.push(("format".to_string(), "json".to_string()));

        let result = self
            .client
            .post(self.api_url)
            .form(&params)
            .timeout(Duration::from_secs(5))
            .send()
            .await;

        match result {
            Ok(resp) => {
                let body: serde_json::Value = match resp.json().await {
                    Ok(b) => b,
                    Err(e) => {
                        return ScrobbleResult::Retryable(format!("response parse error: {e}"));
                    }
                };

                if let Some(code) = Self::parse_error_code(&body) {
                    let msg = body
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown error")
                        .to_string();

                    return match code {
                        // 9 = Invalid session, 10 = Invalid API key, 26 = Key suspended
                        9 | 10 | 26 => ScrobbleResult::AuthError(msg),
                        // 8 = Temporary error, 11 = Service offline,
                        // 16 = Temporarily unavailable, 29 = Rate limit
                        8 | 11 | 16 | 29 => ScrobbleResult::Retryable(msg),
                        // All other errors are permanent failures — do not retry
                        _ => {
                            log::error!("{}: permanent scrobble error {code}: {msg}", self.name);
                            ScrobbleResult::Ok
                        }
                    };
                }

                ScrobbleResult::Ok
            }
            Err(e) => ScrobbleResult::Retryable(format!("request failed: {e}")),
        }
    }
}
