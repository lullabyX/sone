use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const TIDAL_AUTH_URL: &str = "https://auth.tidal.com/v1/oauth2";
const TIDAL_API_URL: &str = "https://api.tidal.com/v1";
// Device-code credentials (from python-tidal) – limited to LOSSLESS quality
const CLIENT_ID: &str = "REDACTED_CLIENT_ID";
const CLIENT_SECRET: &str = "REDACTED_CLIENT_SECRET";
// PKCE credentials (from python-tidal) – enables HI_RES_LOSSLESS (24-bit)
const CLIENT_ID_PKCE: &str = "REDACTED_CLIENT_ID_PKCE";
const CLIENT_SECRET_PKCE: &str = "REDACTED_CLIENT_SECRET_PKCE";

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
    pub token_type: String,
    #[serde(default)]
    pub user_id: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalTrack {
    pub id: u64,
    pub title: String,
    pub duration: u32,
    #[serde(default)]
    pub artist: Option<TidalArtist>,
    #[serde(default)]
    pub album: Option<TidalAlbum>,
    #[serde(default)]
    pub audio_quality: Option<String>,
    #[serde(default)]
    pub track_number: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalAlbumDetail {
    pub id: u64,
    pub title: String,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub artist: Option<TidalArtist>,
    #[serde(default)]
    pub number_of_tracks: Option<u32>,
    #[serde(default)]
    pub duration: Option<u32>,
    #[serde(default)]
    pub release_date: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedTracks {
    pub items: Vec<TidalTrack>,
    pub total_number_of_items: u32,
    pub offset: u32,
    pub limit: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TidalArtist {
    pub id: u64,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TidalAlbum {
    pub id: u64,
    pub title: String,
    #[serde(default)]
    pub cover: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalPlaylistRaw {
    pub uuid: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub square_image: Option<String>,
    #[serde(default)]
    pub number_of_tracks: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalPlaylist {
    pub uuid: String,
    pub title: String,
    pub description: Option<String>,
    pub image: Option<String>,
    pub number_of_tracks: Option<u32>,
}

impl From<TidalPlaylistRaw> for TidalPlaylist {
    fn from(raw: TidalPlaylistRaw) -> Self {
        TidalPlaylist {
            uuid: raw.uuid,
            title: raw.title,
            description: raw.description,
            // Prefer squareImage, fallback to image
            image: raw.square_image.or(raw.image),
            number_of_tracks: raw.number_of_tracks,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalLyrics {
    #[serde(default)]
    pub track_id: Option<u64>,
    #[serde(default)]
    pub lyrics_provider: Option<String>,
    #[serde(default)]
    pub provider_commontrack_id: Option<String>,
    #[serde(default)]
    pub provider_lyrics_id: Option<String>,
    #[serde(default)]
    pub lyrics: Option<String>,
    #[serde(default)]
    pub subtitles: Option<String>,
    #[serde(default)]
    pub is_right_to_left: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TidalContributor {
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TidalCredit {
    #[serde(rename = "type")]
    pub credit_type: String,
    #[serde(default)]
    pub contributors: Vec<TidalContributor>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub url: String,
    #[serde(default)]
    pub codec: Option<String>,
    #[serde(default)]
    pub bit_depth: Option<u32>,
    #[serde(default)]
    pub sample_rate: Option<u32>,
    #[serde(default)]
    pub audio_quality: Option<String>,
    /// Raw MPD/DASH manifest XML when the stream is DASH.
    /// `None` for BTS (single-URL) streams.
    #[serde(default)]
    pub manifest: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TidalSearchResults {
    pub artists: Vec<TidalArtist>,
    pub albums: Vec<TidalAlbumDetail>,
    pub tracks: Vec<TidalTrack>,
    pub playlists: Vec<TidalPlaylist>,
    #[serde(default)]
    pub top_hit_type: Option<String>,
}

pub struct TidalClient {
    client: Client,
    pub tokens: Option<AuthTokens>,
    pub is_pkce: bool,
}

impl TidalClient {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap(),
            tokens: None,
            is_pkce: false,
        }
    }

    pub fn start_device_auth(&self) -> Result<DeviceCode, String> {
        let params = [
            ("client_id", CLIENT_ID),
            ("scope", "r_usr w_usr w_sub"),
        ];

        let response = self
            .client
            .post(format!("{}/device_authorization", TIDAL_AUTH_URL))
            .form(&params)
            .send()
            .map_err(|e| format!("Failed to start auth: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();
        
        if !status.is_success() {
            return Err(format!("Auth request failed ({}): {}", status, body));
        }

        serde_json::from_str::<DeviceCode>(&body)
            .map_err(|e| format!("Failed to parse response: {} - Body: {}", e, body))
    }

    pub fn poll_for_token(&mut self, device_code: &str) -> Result<AuthTokens, String> {
        let params = [
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("scope", "r_usr w_usr w_sub"),
        ];

        let response = self
            .client
            .post(format!("{}/token", TIDAL_AUTH_URL))
            .form(&params)
            .send()
            .map_err(|e| format!("Failed to poll token: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            // Check if it's still pending
            if body.contains("authorization_pending") {
                return Err("Pending".to_string());
            }
            return Err(format!("Token request failed ({}): {}", status, body));
        }

        let tokens = serde_json::from_str::<AuthTokens>(&body)
            .map_err(|e| format!("Failed to parse tokens: {} - Body: {}", e, body))?;

        self.tokens = Some(tokens.clone());
        Ok(tokens)
    }

    pub fn refresh_token(&mut self) -> Result<AuthTokens, String> {
        let current_tokens = self.tokens.as_ref().ok_or("Not authenticated")?;
        let refresh_tok = current_tokens.refresh_token.clone();
        let old_user_id = current_tokens.user_id;

        let (cid, csec) = if self.is_pkce {
            (CLIENT_ID_PKCE, CLIENT_SECRET_PKCE)
        } else {
            (CLIENT_ID, CLIENT_SECRET)
        };

        let params = [
            ("client_id", cid),
            ("client_secret", csec),
            ("refresh_token", refresh_tok.as_str()),
            ("grant_type", "refresh_token"),
            ("scope", "r_usr w_usr w_sub"),
        ];

        let response = self
            .client
            .post(format!("{}/token", TIDAL_AUTH_URL))
            .form(&params)
            .send()
            .map_err(|e| format!("Failed to refresh token: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            return Err(format!("Token refresh failed ({}): {}", status, body));
        }

        // Tidal's refresh response may not include refresh_token, so use a
        // permissive struct and fall back to the existing refresh token.
        #[derive(Deserialize)]
        struct RefreshResponse {
            access_token: String,
            #[serde(default)]
            refresh_token: Option<String>,
            expires_in: u64,
            token_type: String,
            #[serde(default)]
            user_id: Option<u64>,
        }

        let parsed = serde_json::from_str::<RefreshResponse>(&body)
            .map_err(|e| format!("Failed to parse refreshed tokens: {} - Body: {}", e, body))?;

        let new_tokens = AuthTokens {
            access_token: parsed.access_token,
            refresh_token: parsed.refresh_token.unwrap_or(refresh_tok),
            expires_in: parsed.expires_in,
            token_type: parsed.token_type,
            user_id: parsed.user_id.or(old_user_id),
        };

        self.tokens = Some(new_tokens.clone());
        Ok(new_tokens)
    }

    pub fn exchange_pkce_code(
        &mut self,
        code: &str,
        code_verifier: &str,
        redirect_uri: &str,
        client_unique_key: &str,
    ) -> Result<AuthTokens, String> {
        let response = self
            .client
            .post(format!("{}/token", TIDAL_AUTH_URL))
            .form(&[
                ("code", code),
                ("client_id", CLIENT_ID_PKCE),
                ("grant_type", "authorization_code"),
                ("redirect_uri", redirect_uri),
                ("scope", "r_usr+w_usr+w_sub"),
                ("code_verifier", code_verifier),
                ("client_unique_key", client_unique_key),
            ])
            .send()
            .map_err(|e| format!("Failed to exchange PKCE code: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            return Err(format!("PKCE token exchange failed ({}): {}", status, body));
        }

        let tokens = serde_json::from_str::<AuthTokens>(&body)
            .map_err(|e| format!("Failed to parse PKCE tokens: {} - Body: {}", e, body))?;

        self.tokens = Some(tokens.clone());
        self.is_pkce = true;
        Ok(tokens)
    }

    pub fn get_user_profile(&self, user_id: u64) -> Result<(String, Option<String>), String> {
        let tokens = self.tokens.as_ref().ok_or("Not authenticated")?;

        let response = self
            .client
            .get(format!("{}/users/{}", TIDAL_API_URL, user_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", "US")])
            .send()
            .map_err(|e| format!("Failed to get user profile: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("User profile request failed: {}", response.status()));
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct UserProfile {
            #[serde(default)]
            first_name: Option<String>,
            #[serde(default)]
            last_name: Option<String>,
            #[serde(default)]
            username: Option<String>,
        }

        let data = response
            .json::<UserProfile>()
            .map_err(|e| format!("Failed to parse user profile: {}", e))?;

        let username = data.username.clone();
        let name = match (&data.first_name, &data.last_name) {
            (Some(f), Some(l)) if !f.is_empty() => format!("{} {}", f, l),
            (Some(f), _) if !f.is_empty() => f.clone(),
            _ => username.clone().unwrap_or_else(|| "Tidal User".to_string()),
        };

        Ok((name, username))
    }

    pub fn get_session_info(&self) -> Result<u64, String> {
        let tokens = self.tokens.as_ref().ok_or("Not authenticated")?;

        let response = self
            .client
            .get(format!("{}/sessions", TIDAL_API_URL))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .send()
            .map_err(|e| format!("Failed to get session: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("Session request failed: {}", response.status()));
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct SessionResponse {
            user_id: u64,
        }

        let data = response
            .json::<SessionResponse>()
            .map_err(|e| format!("Failed to parse session: {}", e))?;

        Ok(data.user_id)
    }

    pub fn get_user_playlists(&self, user_id: u64) -> Result<Vec<TidalPlaylist>, String> {
        let tokens = self.tokens.as_ref().ok_or("Not authenticated")?;

        let response = self
            .client
            .get(format!("{}/users/{}/playlists", TIDAL_API_URL, user_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", "US"), ("limit", "50")])
            .send()
            .map_err(|e| format!("Failed to fetch playlists: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            return Err(format!("API error ({}): {}", status, body));
        }

        #[derive(Deserialize)]
        struct PlaylistResponse {
            items: Vec<TidalPlaylistRaw>,
        }

        let data = serde_json::from_str::<PlaylistResponse>(&body)
            .map_err(|e| format!("Failed to parse playlists: {} - Body: {}", e, body))?;
        
        // Convert raw playlists to our format
        let playlists: Vec<TidalPlaylist> = data.items.into_iter().map(|p| p.into()).collect();

        Ok(playlists)
    }

    pub fn get_playlist_tracks(&self, playlist_id: &str) -> Result<Vec<TidalTrack>, String> {
        let tokens = self.tokens.as_ref().ok_or("Not authenticated")?;

        let response = self
            .client
            .get(format!("{}/playlists/{}/items", TIDAL_API_URL, playlist_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", "US"), ("limit", "100")])
            .send()
            .map_err(|e| format!("Failed to fetch tracks: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            return Err(format!("API error ({}): {}", status, body));
        }

        #[derive(Deserialize)]
        struct TrackItem {
            item: TidalTrack,
        }

        #[derive(Deserialize)]
        struct TracksResponse {
            items: Vec<TrackItem>,
        }

        let data = serde_json::from_str::<TracksResponse>(&body)
            .map_err(|e| format!("Failed to parse tracks: {} - Body: {}", e, body))?;

        Ok(data.items.into_iter().map(|t| t.item).collect())
    }

    pub fn get_album_detail(&self, album_id: u64) -> Result<TidalAlbumDetail, String> {
        let tokens = self.tokens.as_ref().ok_or("Not authenticated")?;

        let response = self
            .client
            .get(format!("{}/albums/{}", TIDAL_API_URL, album_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", "US")])
            .send()
            .map_err(|e| format!("Failed to fetch album: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            return Err(format!("API error ({}): {}", status, body));
        }

        serde_json::from_str::<TidalAlbumDetail>(&body)
            .map_err(|e| format!("Failed to parse album: {} - Body: {}", e, body))
    }

    pub fn get_album_tracks(&self, album_id: u64, offset: u32, limit: u32) -> Result<PaginatedTracks, String> {
        let tokens = self.tokens.as_ref().ok_or("Not authenticated")?;

        let response = self
            .client
            .get(format!("{}/albums/{}/tracks", TIDAL_API_URL, album_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[
                ("countryCode", "US"),
                ("limit", &limit.to_string()),
                ("offset", &offset.to_string()),
            ])
            .send()
            .map_err(|e| format!("Failed to fetch album tracks: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            return Err(format!("API error ({}): {}", status, body));
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct AlbumTracksResponse {
            items: Vec<TidalTrack>,
            total_number_of_items: u32,
            #[serde(default)]
            offset: u32,
            #[serde(default)]
            limit: u32,
        }

        let data = serde_json::from_str::<AlbumTracksResponse>(&body)
            .map_err(|e| format!("Failed to parse album tracks: {} - Body: {}", e, body))?;

        Ok(PaginatedTracks {
            items: data.items,
            total_number_of_items: data.total_number_of_items,
            offset: data.offset,
            limit: data.limit,
        })
    }

    pub fn get_favorite_tracks(&self, user_id: u64, offset: u32, limit: u32) -> Result<PaginatedTracks, String> {
        let tokens = self.tokens.as_ref().ok_or("Not authenticated")?;

        let response = self
            .client
            .get(format!("{}/users/{}/favorites/tracks", TIDAL_API_URL, user_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[
                ("countryCode", "US"),
                ("limit", &limit.to_string()),
                ("offset", &offset.to_string()),
                ("order", "DATE"),
                ("orderDirection", "DESC"),
            ])
            .send()
            .map_err(|e| format!("Failed to fetch favorite tracks: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            return Err(format!("API error ({}): {}", status, body));
        }

        #[derive(Deserialize)]
        struct FavoriteTrackItem {
            item: TidalTrack,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FavoriteTracksResponse {
            items: Vec<FavoriteTrackItem>,
            total_number_of_items: u32,
            #[serde(default)]
            offset: u32,
            #[serde(default)]
            limit: u32,
        }

        let data = serde_json::from_str::<FavoriteTracksResponse>(&body)
            .map_err(|e| format!("Failed to parse favorite tracks: {} - Body: {}", e, body))?;

        Ok(PaginatedTracks {
            items: data.items.into_iter().map(|f| f.item).collect(),
            total_number_of_items: data.total_number_of_items,
            offset: data.offset,
            limit: data.limit,
        })
    }

    pub fn is_track_favorited(&self, user_id: u64, track_id: u64) -> Result<bool, String> {
        let tokens = self.tokens.as_ref().ok_or("Not authenticated")?;
        let response = self
            .client
            .get(format!("{}/users/{}/favorites/tracks", TIDAL_API_URL, user_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[
                ("countryCode", "US"),
                ("limit", "2000"),
                ("offset", "0"),
                ("order", "DATE"),
                ("orderDirection", "DESC"),
            ])
            .send()
            .map_err(|e| format!("Failed to fetch favorite tracks: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            return Err(format!("API error ({}): {}", status, body));
        }

        #[derive(Deserialize)]
        struct FavoriteTrackItem {
            #[serde(default)]
            id: Option<u64>,
            #[serde(default)]
            item: Option<TidalTrack>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FavoriteTracksResponse {
            #[serde(default)]
            items: Vec<FavoriteTrackItem>,
        }

        let data = serde_json::from_str::<FavoriteTracksResponse>(&body)
            .map_err(|e| format!("Failed to parse favorite tracks: {} - Body: {}", e, body))?;

        Ok(data.items.iter().any(|entry| {
            entry.id == Some(track_id)
                || entry
                    .item
                    .as_ref()
                    .is_some_and(|track| track.id == track_id)
        }))
    }

    pub fn add_favorite_track(&self, user_id: u64, track_id: u64) -> Result<(), String> {
        let tokens = self.tokens.as_ref().ok_or("Not authenticated")?;
        let track_id_str = track_id.to_string();

        let response = self
            .client
            .post(format!("{}/users/{}/favorites/tracks", TIDAL_API_URL, user_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", "US")])
            .form(&[("trackId", track_id_str.as_str())])
            .send()
            .map_err(|e| format!("Failed to favorite track: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            return Err(format!("API error ({}): {}", status, body));
        }

        Ok(())
    }

    pub fn remove_favorite_track(&self, user_id: u64, track_id: u64) -> Result<(), String> {
        let tokens = self.tokens.as_ref().ok_or("Not authenticated")?;

        let response = self
            .client
            .delete(format!(
                "{}/users/{}/favorites/tracks/{}",
                TIDAL_API_URL, user_id, track_id
            ))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", "US")])
            .send()
            .map_err(|e| format!("Failed to remove favorite track: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            return Err(format!("API error ({}): {}", status, body));
        }

        Ok(())
    }

    pub fn is_album_favorited(&self, user_id: u64, album_id: u64) -> Result<bool, String> {
        let tokens = self.tokens.as_ref().ok_or("Not authenticated")?;
        let response = self
            .client
            .get(format!("{}/users/{}/favorites/albums", TIDAL_API_URL, user_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[
                ("countryCode", "US"),
                ("limit", "2000"),
                ("offset", "0"),
                ("order", "DATE"),
                ("orderDirection", "DESC"),
            ])
            .send()
            .map_err(|e| format!("Failed to fetch favorite albums: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            return Err(format!("API error ({}): {}", status, body));
        }

        #[derive(Deserialize)]
        struct FavoriteAlbumItem {
            #[serde(default)]
            id: Option<u64>,
            #[serde(default)]
            item: Option<TidalAlbum>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FavoriteAlbumsResponse {
            #[serde(default)]
            items: Vec<FavoriteAlbumItem>,
        }

        let data = serde_json::from_str::<FavoriteAlbumsResponse>(&body)
            .map_err(|e| format!("Failed to parse favorite albums: {} - Body: {}", e, body))?;

        Ok(data.items.iter().any(|entry| {
            entry.id == Some(album_id)
                || entry
                    .item
                    .as_ref()
                    .is_some_and(|album| album.id == album_id)
        }))
    }

    pub fn add_favorite_album(&self, user_id: u64, album_id: u64) -> Result<(), String> {
        let tokens = self.tokens.as_ref().ok_or("Not authenticated")?;
        let album_id_str = album_id.to_string();

        let response = self
            .client
            .post(format!("{}/users/{}/favorites/albums", TIDAL_API_URL, user_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", "US")])
            .form(&[("albumId", album_id_str.as_str())])
            .send()
            .map_err(|e| format!("Failed to favorite album: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            return Err(format!("API error ({}): {}", status, body));
        }

        Ok(())
    }

    pub fn remove_favorite_album(&self, user_id: u64, album_id: u64) -> Result<(), String> {
        let tokens = self.tokens.as_ref().ok_or("Not authenticated")?;

        let response = self
            .client
            .delete(format!(
                "{}/users/{}/favorites/albums/{}",
                TIDAL_API_URL, user_id, album_id
            ))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", "US")])
            .send()
            .map_err(|e| format!("Failed to remove favorite album: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            return Err(format!("API error ({}): {}", status, body));
        }

        Ok(())
    }

    pub fn get_stream_url(&self, track_id: u64, quality: &str) -> Result<StreamInfo, String> {
        let tokens = self.tokens.as_ref().ok_or("Not authenticated")?;

        let response = self
            .client
            .get(format!(
                "{}/tracks/{}/playbackinfopostpaywall",
                TIDAL_API_URL, track_id
            ))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[
                ("countryCode", "US"),
                ("audioquality", quality),
                ("playbackmode", "STREAM"),
                ("assetpresentation", "FULL"),
            ])
            .send()
            .map_err(|e| format!("Failed to get stream URL: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            return Err(format!("API error ({}): {}", status, body));
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct PlaybackInfo {
            manifest_mime_type: String,
            manifest: String,
            #[serde(default)]
            audio_quality: Option<String>,
            #[serde(default)]
            bit_depth: Option<u32>,
            #[serde(default)]
            sample_rate: Option<u32>,
        }

        let data = serde_json::from_str::<PlaybackInfo>(&body)
            .map_err(|e| format!("Failed to parse playback info: {} - Body: {}", e, body))?;

        use base64::Engine;
        let manifest_bytes = base64::engine::general_purpose::STANDARD.decode(&data.manifest)
            .map_err(|e| format!("Failed to decode manifest: {}", e))?;
        let manifest_str = String::from_utf8(manifest_bytes)
            .map_err(|e| format!("Invalid manifest encoding: {}", e))?;

        let mut codec: Option<String> = None;

        // Handle BTS format (JSON with urls array)
        let url = if data.manifest_mime_type.contains("vnd.tidal.bts") {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            #[allow(dead_code)]
            struct BtsManifest {
                urls: Vec<String>,
                codecs: Option<String>,
                mime_type: Option<String>,
                encryption_type: Option<String>,
            }

            let manifest_data = serde_json::from_str::<BtsManifest>(&manifest_str)
                .map_err(|e| format!("Failed to parse BTS manifest: {} - Manifest: {}", e, manifest_str))?;

            codec = manifest_data.codecs.map(|c| c.to_uppercase().split('.').next().unwrap_or("").to_string());

            manifest_data
                .urls
                .into_iter()
                .next()
                .ok_or("No URL in BTS manifest".to_string())?
        }
        // Handle DASH/MPD format — return raw manifest for GStreamer
        else if data.manifest_mime_type.contains("dash+xml") {
            // Extract codec from manifest
            if let Some(codecs_start) = manifest_str.find("codecs=\"") {
                let start = codecs_start + 8;
                if let Some(codecs_end) = manifest_str[start..].find("\"") {
                    let raw = &manifest_str[start..start + codecs_end];
                    codec = Some(if raw.contains("flac") { "FLAC".to_string() } else { raw.to_uppercase() });
                }
            }

            return Ok(StreamInfo {
                url: String::new(),
                codec,
                bit_depth: data.bit_depth,
                sample_rate: data.sample_rate,
                audio_quality: data.audio_quality,
                manifest: Some(manifest_str),
            });
        }
        // JSON fallback
        else {
            #[derive(Deserialize)]
            struct JsonManifest {
                urls: Option<Vec<String>>,
            }

            if let Ok(manifest_data) = serde_json::from_str::<JsonManifest>(&manifest_str) {
                if let Some(urls) = manifest_data.urls {
                    if let Some(u) = urls.into_iter().next() {
                        u
                    } else {
                        return Err("Empty URL list in manifest".to_string());
                    }
                } else {
                    return Err("No urls in JSON manifest".to_string());
                }
            } else {
                return Err(format!("Unknown manifest format '{}': {}", data.manifest_mime_type, &manifest_str[..manifest_str.len().min(300)]));
            }
        };

        Ok(StreamInfo {
            url,
            codec,
            bit_depth: data.bit_depth,
            sample_rate: data.sample_rate,
            audio_quality: data.audio_quality,
            manifest: None,
        })
    }

    pub fn get_track_lyrics(&self, track_id: u64) -> Result<TidalLyrics, String> {
        let tokens = self.tokens.as_ref().ok_or("Not authenticated")?;

        let response = self
            .client
            .get(format!("{}/tracks/{}/lyrics", TIDAL_API_URL, track_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", "US")])
            .send()
            .map_err(|e| format!("Failed to fetch lyrics: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            return Err(format!("Lyrics not available ({})", status));
        }

        serde_json::from_str::<TidalLyrics>(&body)
            .map_err(|e| format!("Failed to parse lyrics: {} - Body: {}", e, body))
    }

    pub fn get_track_credits(&self, track_id: u64) -> Result<Vec<TidalCredit>, String> {
        let tokens = self.tokens.as_ref().ok_or("Not authenticated")?;

        let response = self
            .client
            .get(format!("{}/tracks/{}/credits", TIDAL_API_URL, track_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[("countryCode", "US")])
            .send()
            .map_err(|e| format!("Failed to fetch credits: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            return Err(format!("Credits not available ({})", status));
        }

        serde_json::from_str::<Vec<TidalCredit>>(&body)
            .map_err(|e| format!("Failed to parse credits: {} - Body: {}", e, body))
    }

    pub fn get_track_radio(&self, track_id: u64, limit: u32) -> Result<Vec<TidalTrack>, String> {
        let tokens = self.tokens.as_ref().ok_or("Not authenticated")?;

        let response = self
            .client
            .get(format!("{}/tracks/{}/radio", TIDAL_API_URL, track_id))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[
                ("countryCode", "US"),
                ("limit", &limit.to_string()),
            ])
            .send()
            .map_err(|e| format!("Failed to fetch track radio: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            return Err(format!("Track radio not available ({})", status));
        }

        // Tidal v1 radio endpoint may return { items: [...] } or a flat array
        #[derive(Deserialize)]
        struct RadioResponse {
            items: Vec<TidalTrack>,
        }

        if let Ok(data) = serde_json::from_str::<RadioResponse>(&body) {
            return Ok(data.items);
        }

        // Fallback: try parsing as a flat array
        serde_json::from_str::<Vec<TidalTrack>>(&body)
            .map_err(|e| format!("Failed to parse track radio: {} - Body: {}", e, body))
    }

    pub fn search(&self, query: &str, limit: u32) -> Result<TidalSearchResults, String> {
        let tokens = self.tokens.as_ref().ok_or("Not authenticated")?;

        let response = self
            .client
            .get(format!("{}/search", TIDAL_API_URL))
            .header("Authorization", format!("Bearer {}", tokens.access_token))
            .query(&[
                ("query", query),
                ("countryCode", "US"),
                ("limit", &limit.to_string()),
                ("offset", "0"),
                ("types", "ARTISTS,ALBUMS,TRACKS,PLAYLISTS"),
            ])
            .send()
            .map_err(|e| format!("Failed to search: {}", e))?;

        let status = response.status();
        let body = response.text().unwrap_or_default();

        if !status.is_success() {
            return Err(format!("Search failed ({}): {}", status, body));
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct SearchSection<T> {
            items: Vec<T>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct TopHit {
            #[serde(rename = "type")]
            hit_type: Option<String>,
        }

        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct SearchResponse {
            #[serde(default)]
            artists: Option<SearchSection<TidalArtist>>,
            #[serde(default)]
            albums: Option<SearchSection<TidalAlbumDetail>>,
            #[serde(default)]
            tracks: Option<SearchSection<TidalTrack>>,
            #[serde(default)]
            playlists: Option<SearchSection<TidalPlaylistRaw>>,
            #[serde(default)]
            top_hit: Option<TopHit>,
        }

        let data = serde_json::from_str::<SearchResponse>(&body)
            .map_err(|e| format!("Failed to parse search results: {} - Body: {}", e, body))?;

        Ok(TidalSearchResults {
            artists: data.artists.map(|s| s.items).unwrap_or_default(),
            albums: data.albums.map(|s| s.items).unwrap_or_default(),
            tracks: data.tracks.map(|s| s.items).unwrap_or_default(),
            playlists: data
                .playlists
                .map(|s| s.items.into_iter().map(|p| p.into()).collect())
                .unwrap_or_default(),
            top_hit_type: data.top_hit.and_then(|h| h.hit_type),
        })
    }
}
