use serde::{Deserialize, Serialize};
use tauri::State;

use crate::scrobble::listenbrainz::ListenBrainzProvider;
use crate::scrobble::{ProviderStatus, ScrobbleTrack};
use crate::{AppState, LastfmCredentials, ListenBrainzCredentials, SoneError};

#[derive(Debug, Serialize)]
pub struct AuthStartResponse {
    pub url: String,
    pub token: String,
}

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackStartedPayload {
    pub artist: String,
    pub title: String,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub duration_secs: u32,
    pub track_number: Option<u32>,
    pub chosen_by_user: bool,
    pub isrc: Option<String>,
    pub track_id: Option<u64>,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "camelCase")]
pub async fn notify_track_started(
    state: State<'_, AppState>,
    payload: TrackStartedPayload,
) -> Result<(), SoneError> {
    let track = ScrobbleTrack {
        artist: payload.artist,
        track: payload.title,
        album: payload.album,
        album_artist: payload.album_artist,
        duration_secs: payload.duration_secs,
        track_number: payload.track_number,
        timestamp: crate::now_secs() as i64,
        chosen_by_user: payload.chosen_by_user,
        isrc: payload.isrc,
        track_id: payload.track_id,
        recording_mbid: None,
    };
    state.scrobble_manager.on_track_started(track).await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn notify_track_paused(state: State<'_, AppState>) -> Result<(), SoneError> {
    state.scrobble_manager.on_pause().await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn notify_track_resumed(state: State<'_, AppState>) -> Result<(), SoneError> {
    state.scrobble_manager.on_resume().await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn notify_track_seeked(state: State<'_, AppState>) -> Result<(), SoneError> {
    state.scrobble_manager.on_seek().await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn notify_track_stopped(state: State<'_, AppState>) -> Result<(), SoneError> {
    state.scrobble_manager.on_track_stopped().await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_scrobble_status(
    state: State<'_, AppState>,
) -> Result<Vec<ProviderStatus>, SoneError> {
    Ok(state.scrobble_manager.provider_statuses().await)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_scrobble_queue_size(state: State<'_, AppState>) -> Result<usize, SoneError> {
    Ok(state.scrobble_manager.queue_size().await)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn connect_listenbrainz(
    state: State<'_, AppState>,
    token: String,
) -> Result<String, SoneError> {
    let http_client = {
        let client = state.tidal_client.lock().await;
        client.raw_client().clone()
    };
    let username = ListenBrainzProvider::validate_token(&http_client, &token).await?;

    // Create and register the provider
    let provider = ListenBrainzProvider::new(http_client);
    provider.set_token(token.clone(), username.clone()).await;
    state
        .scrobble_manager
        .add_provider(Box::new(provider))
        .await;

    // Save credentials to settings
    if let Some(mut settings) = state.load_settings() {
        settings.scrobble.listenbrainz = Some(ListenBrainzCredentials {
            token,
            username: username.clone(),
        });
        state.save_settings(&settings)?;
    }

    Ok(username)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn disconnect_provider(
    state: State<'_, AppState>,
    provider: String,
) -> Result<(), SoneError> {
    // Clear credentials from settings
    if let Some(mut settings) = state.load_settings() {
        match provider.as_str() {
            "lastfm" => settings.scrobble.lastfm = None,
            "listenbrainz" => settings.scrobble.listenbrainz = None,
            "librefm" => settings.scrobble.librefm = None,
            _ => {
                return Err(SoneError::Scrobble(format!("unknown provider: {provider}")));
            }
        }
        state.save_settings(&settings)?;
    }

    state.scrobble_manager.remove_provider(&provider).await;
    Ok(())
}

/// Fetch a request token and return the auth URL + token for Last.fm desktop auth.
#[tauri::command(rename_all = "camelCase")]
pub async fn connect_lastfm(state: State<'_, AppState>) -> Result<AuthStartResponse, SoneError> {
    if !crate::embedded_lastfm::has_stream_keys() {
        return Err(SoneError::Scrobble("Last.fm not configured".into()));
    }
    let http_client = {
        let client = state.tidal_client.lock().await;
        client.raw_client().clone()
    };
    let provider = crate::scrobble::lastfm::AudioscrobblerProvider::new(
        "lastfm",
        "https://ws.audioscrobbler.com/2.0/",
        "https://www.last.fm/api/auth/",
        crate::embedded_lastfm::stream_key_a(),
        crate::embedded_lastfm::stream_key_b(),
        http_client,
    );
    let token = provider.get_token().await?;
    let url = provider.auth_url_with_token(&token);
    Ok(AuthStartResponse { url, token })
}

/// Fetch a request token and return the auth URL + token for Libre.fm desktop auth.
#[tauri::command(rename_all = "camelCase")]
pub async fn connect_librefm(state: State<'_, AppState>) -> Result<AuthStartResponse, SoneError> {
    if !crate::embedded_librefm::has_stream_keys() {
        return Err(SoneError::Scrobble("Libre.fm not configured".into()));
    }
    let http_client = {
        let client = state.tidal_client.lock().await;
        client.raw_client().clone()
    };
    let provider = crate::scrobble::lastfm::AudioscrobblerProvider::new(
        "librefm",
        crate::scrobble::librefm::LIBREFM_API_URL,
        "https://libre.fm/api/auth/",
        crate::embedded_librefm::stream_key_a(),
        crate::embedded_librefm::stream_key_b(),
        http_client,
    );
    let token = provider.get_token().await?;
    let url = provider.auth_url_with_token(&token);
    Ok(AuthStartResponse { url, token })
}

/// Exchange an auth token for a permanent session key.
/// The frontend calls this after the user authorizes in the browser and
/// provides the token.
#[tauri::command(rename_all = "camelCase")]
pub async fn complete_audioscrobbler_auth(
    state: State<'_, AppState>,
    provider_name: String,
    token: String,
) -> Result<String, SoneError> {
    let (api_key, api_secret, api_url, auth_base_url) = match provider_name.as_str() {
        "lastfm" => {
            if !crate::embedded_lastfm::has_stream_keys() {
                return Err(SoneError::Scrobble("Last.fm not configured".into()));
            }
            (
                crate::embedded_lastfm::stream_key_a(),
                crate::embedded_lastfm::stream_key_b(),
                "https://ws.audioscrobbler.com/2.0/",
                "https://www.last.fm/api/auth/",
            )
        }
        "librefm" => {
            if !crate::embedded_librefm::has_stream_keys() {
                return Err(SoneError::Scrobble("Libre.fm not configured".into()));
            }
            (
                crate::embedded_librefm::stream_key_a(),
                crate::embedded_librefm::stream_key_b(),
                crate::scrobble::librefm::LIBREFM_API_URL,
                "https://libre.fm/api/auth/",
            )
        }
        _ => {
            return Err(SoneError::Scrobble(format!(
                "Unknown provider: {provider_name}"
            )));
        }
    };

    let http_client = {
        let client = state.tidal_client.lock().await;
        client.raw_client().clone()
    };
    let provider = crate::scrobble::lastfm::AudioscrobblerProvider::new(
        if provider_name == "lastfm" {
            "lastfm"
        } else {
            "librefm"
        },
        api_url,
        auth_base_url,
        api_key,
        api_secret,
        http_client,
    );

    let (session_key, username) = provider.get_session(&token).await?;
    provider
        .set_session(session_key.clone(), username.clone())
        .await;

    // Save credentials
    if let Some(mut settings) = state.load_settings() {
        let creds = LastfmCredentials {
            session_key,
            username: username.clone(),
        };
        match provider_name.as_str() {
            "lastfm" => settings.scrobble.lastfm = Some(creds),
            "librefm" => settings.scrobble.librefm = Some(creds),
            _ => {}
        }
        state.save_settings(&settings)?;
    }

    // Register provider with the scrobble manager
    state
        .scrobble_manager
        .add_provider(Box::new(provider))
        .await;

    Ok(username)
}
