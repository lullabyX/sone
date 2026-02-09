use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const TIDAL_AUTH_URL: &str = "https://auth.tidal.com/v1/oauth2";
const TIDAL_API_URL: &str = "https://api.tidal.com/v1";
// Credentials from python-tidal
const CLIENT_ID: &str = "REDACTED_CLIENT_ID";
const CLIENT_SECRET: &str = "REDACTED_CLIENT_SECRET";

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

pub struct TidalClient {
    client: Client,
    pub tokens: Option<AuthTokens>,
}

impl TidalClient {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap(),
            tokens: None,
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

        let params = [
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
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

    pub fn get_stream_url(&self, track_id: u64, quality: &str) -> Result<String, String> {
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
        }

        let data = serde_json::from_str::<PlaybackInfo>(&body)
            .map_err(|e| format!("Failed to parse playback info: {} - Body: {}", e, body))?;

        use base64::Engine;
        let manifest_bytes = base64::engine::general_purpose::STANDARD.decode(&data.manifest)
            .map_err(|e| format!("Failed to decode manifest: {}", e))?;
        let manifest_str = String::from_utf8(manifest_bytes)
            .map_err(|e| format!("Invalid manifest encoding: {}", e))?;
        
        println!("DEBUG: Manifest MIME type = '{}'", data.manifest_mime_type);
        println!("DEBUG: Decoded manifest = '{}'", &manifest_str[..manifest_str.len().min(500)]);

        // Handle BTS format (JSON with urls array)
        if data.manifest_mime_type.contains("vnd.tidal.bts") {
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

            let url = manifest_data
                .urls
                .into_iter()
                .next()
                .ok_or("No URL in BTS manifest".to_string())?;
            
            println!("DEBUG: BTS Stream URL: {}", url);
            Ok(url)
        }
        // Handle MPD/DASH format - extract URL from XML
        else if data.manifest_mime_type.contains("dash+xml") {
            // Parse the MPD XML to extract the base URL and segment template
            // Look for BaseURL or SegmentTemplate initialization
            if let Some(base_url_start) = manifest_str.find("<BaseURL>") {
                let start = base_url_start + 9;
                if let Some(base_url_end) = manifest_str[start..].find("</BaseURL>") {
                    let url = &manifest_str[start..start + base_url_end];
                    println!("DEBUG: MPD BaseURL: {}", url);
                    return Ok(url.to_string());
                }
            }
            
            // Try to find initialization URL in SegmentTemplate
            if let Some(init_start) = manifest_str.find("initialization=\"") {
                let start = init_start + 16;
                if let Some(init_end) = manifest_str[start..].find("\"") {
                    let url = &manifest_str[start..start + init_end];
                    println!("DEBUG: MPD initialization URL: {}", url);
                    return Ok(url.to_string());
                }
            }
            
            Err(format!("Could not extract URL from MPD manifest: {}", &manifest_str[..manifest_str.len().min(300)]))
        }
        // Try JSON format as fallback
        else {
            #[derive(Deserialize)]
            struct JsonManifest {
                urls: Option<Vec<String>>,
            }

            if let Ok(manifest_data) = serde_json::from_str::<JsonManifest>(&manifest_str) {
                if let Some(urls) = manifest_data.urls {
                    if let Some(url) = urls.into_iter().next() {
                        println!("DEBUG: JSON fallback URL: {}", url);
                        return Ok(url);
                    }
                }
            }
            
            Err(format!("Unknown manifest format '{}': {}", data.manifest_mime_type, &manifest_str[..manifest_str.len().min(300)]))
        }
    }
}
