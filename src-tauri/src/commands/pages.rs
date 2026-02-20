use serde::Serialize;
use serde_json::Value;
use tauri::{Manager, State};

use crate::AppState;
use crate::SoneError;
use crate::cache::{CacheResult, CacheTier};
use crate::tidal_api::{HomePageResponse, PaginatedTracks, TidalAlbumDetail, TidalArtistDetail, TidalTrack};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HomePageCached {
    home: HomePageResponse,
    is_stale: bool,
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_album_detail(state: State<'_, AppState>, album_id: u64) -> Result<TidalAlbumDetail, SoneError> {
    log::debug!("[get_album_detail]: album_id={}", album_id);

    let cache_key = format!("album:{}", album_id);
    match state.disk_cache.get(&cache_key, CacheTier::StaticMeta).await {
        CacheResult::Fresh(bytes) => {
            if let Ok(detail) = serde_json::from_slice(&bytes) {
                return Ok(detail);
            }
        }
        CacheResult::Stale(bytes) => {
            if let Ok(detail) = serde_json::from_slice::<TidalAlbumDetail>(&bytes) {
                // Static metadata — no SWR refresh needed (7-day TTL is generous).
                return Ok(detail);
            }
        }
        CacheResult::Miss => {}
    }

    let mut client = state.tidal_client.lock().await;
    let detail = client.get_album_detail(album_id).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&detail) {
        state.disk_cache
            .put(&cache_key, &json, CacheTier::StaticMeta, &["album", &format!("album:{}", album_id)])
            .await
            .ok();
    }
    Ok(detail)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_album_tracks(
    state: State<'_, AppState>,
    album_id: u64,
    offset: u32,
    limit: u32,
) -> Result<PaginatedTracks, SoneError> {
    log::debug!("[get_album_tracks]: album_id={}, offset={}, limit={}", album_id, offset, limit);

    let cache_key = format!("album-tracks:{}:{}:{}", album_id, offset, limit);
    match state.disk_cache.get(&cache_key, CacheTier::StaticMeta).await {
        CacheResult::Fresh(bytes) | CacheResult::Stale(bytes) => {
            if let Ok(tracks) = serde_json::from_slice(&bytes) {
                return Ok(tracks);
            }
        }
        CacheResult::Miss => {}
    }

    let mut client = state.tidal_client.lock().await;
    let tracks = client.get_album_tracks(album_id, offset, limit).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&tracks) {
        state.disk_cache
            .put(&cache_key, &json, CacheTier::StaticMeta, &["album-tracks", &format!("album:{}", album_id)])
            .await
            .ok();
    }
    Ok(tracks)
}

#[tauri::command]
pub async fn get_home_page(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<HomePageCached, SoneError> {
    log::debug!("[get_home_page]");

    let cache_key = "home_page";
    match state.disk_cache.get(cache_key, CacheTier::Dynamic).await {
        CacheResult::Fresh(bytes) => {
            if let Ok(home) = serde_json::from_slice(&bytes) {
                return Ok(HomePageCached { home, is_stale: false });
            }
        }
        CacheResult::Stale(bytes) => {
            if let Ok(home) = serde_json::from_slice::<HomePageResponse>(&bytes) {
                // SWR: return stale data, refresh in background.
                if state.disk_cache.mark_in_flight(cache_key).await {
                    // Only retry if last attempt was >5min ago (300s)
                    if state.disk_cache.should_retry_refresh(cache_key, 300).await {
                        state.disk_cache.mark_refresh_attempt(cache_key).await;
                        let handle = app_handle.clone();
                        tokio::spawn(async move {
                            let st = handle.state::<AppState>();
                            let result = {
                                let mut client = st.tidal_client.lock().await;
                                client.get_home_page().await
                            };
                            if let Ok(fresh) = result {
                                if let Ok(json) = serde_json::to_vec(&fresh) {
                                    st.disk_cache
                                        .put(cache_key, &json, CacheTier::Dynamic, &["home-page"])
                                        .await
                                        .ok();
                                }
                            }
                            st.disk_cache.clear_in_flight(cache_key).await;
                        });
                    } else {
                        state.disk_cache.clear_in_flight(cache_key).await;
                    }
                }
                return Ok(HomePageCached { home, is_stale: true });
            }
        }
        CacheResult::Miss => {}
    }

    let mut client = state.tidal_client.lock().await;
    let home = client.get_home_page().await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&home) {
        state.disk_cache
            .put(cache_key, &json, CacheTier::Dynamic, &["home-page"])
            .await
            .ok();
    }
    Ok(HomePageCached { home, is_stale: false })
}

#[tauri::command]
pub async fn refresh_home_page(state: State<'_, AppState>) -> Result<HomePageResponse, SoneError> {
    log::debug!("[refresh_home_page]");
    let mut client = state.tidal_client.lock().await;
    let home = client.get_home_page().await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&home) {
        state.disk_cache
            .put("home_page", &json, CacheTier::Dynamic, &["home-page"])
            .await
            .ok();
    }
    Ok(home)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_home_page_more(
    state: State<'_, AppState>,
    cursor: String,
) -> Result<HomePageResponse, SoneError> {
    log::debug!("[get_home_page_more]: cursor={}", &cursor[..cursor.len().min(32)]);
    let mut client = state.tidal_client.lock().await;
    let (mut sections, next_cursor) = client.fetch_v2_home_feed(Some(&cursor)).await;
    drop(client);

    sections.retain(|s| {
        !s.title.trim().is_empty()
            && s.section_type != "PAGE_LINKS_CLOUD"
            && s.section_type != "PAGE_LINKS"
            && s.section_type != "SHORTCUT_LIST"
    });

    log::debug!("[get_home_page_more]: got {} sections, next_cursor={:?}", sections.len(), next_cursor.is_some());
    Ok(HomePageResponse { sections, cursor: next_cursor })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_page_section(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    api_path: String,
) -> Result<HomePageResponse, SoneError> {
    log::debug!("[get_page_section]: api_path={}", api_path);

    let cache_key = format!("section:{}", api_path);
    match state.disk_cache.get(&cache_key, CacheTier::Dynamic).await {
        CacheResult::Fresh(bytes) => {
            if let Ok(page) = serde_json::from_slice(&bytes) {
                return Ok(page);
            }
        }
        CacheResult::Stale(bytes) => {
            if let Ok(page) = serde_json::from_slice::<HomePageResponse>(&bytes) {
                if state.disk_cache.mark_in_flight(&cache_key).await {
                    // Only retry if last attempt was >5min ago (300s)
                    if state.disk_cache.should_retry_refresh(&cache_key, 300).await {
                        state.disk_cache.mark_refresh_attempt(&cache_key).await;
                        let handle = app_handle.clone();
                        let path = api_path.clone();
                        let key = cache_key.clone();
                        tokio::spawn(async move {
                            let st = handle.state::<AppState>();
                            let result = {
                                let mut client = st.tidal_client.lock().await;
                                client.get_page(&path).await
                            };
                            if let Ok(fresh) = result {
                                if let Ok(json) = serde_json::to_vec(&fresh) {
                                    st.disk_cache
                                        .put(&key, &json, CacheTier::Dynamic, &["section"])
                                        .await
                                        .ok();
                                }
                            }
                            st.disk_cache.clear_in_flight(&key).await;
                        });
                    } else {
                        state.disk_cache.clear_in_flight(&cache_key).await;
                    }
                }
                return Ok(page);
            }
        }
        CacheResult::Miss => {}
    }

    let mut client = state.tidal_client.lock().await;
    let page = client.get_page(&api_path).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&page) {
        state.disk_cache
            .put(&cache_key, &json, CacheTier::Dynamic, &["section"])
            .await
            .ok();
    }
    Ok(page)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_mix_items(state: State<'_, AppState>, mix_id: String) -> Result<Vec<TidalTrack>, SoneError> {
    log::debug!("[get_mix_items]: mix_id={}", mix_id);

    let cache_key = format!("mix:{}", mix_id);
    match state.disk_cache.get(&cache_key, CacheTier::Dynamic).await {
        CacheResult::Fresh(bytes) | CacheResult::Stale(bytes) => {
            if let Ok(items) = serde_json::from_slice(&bytes) {
                return Ok(items);
            }
        }
        CacheResult::Miss => {}
    }

    let mut client = state.tidal_client.lock().await;
    let items = client.get_mix_items(&mix_id).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&items) {
        state.disk_cache
            .put(&cache_key, &json, CacheTier::Dynamic, &["mix"])
            .await
            .ok();
    }
    Ok(items)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_artist_detail(state: State<'_, AppState>, artist_id: u64) -> Result<TidalArtistDetail, SoneError> {
    log::debug!("[get_artist_detail]: artist_id={}", artist_id);

    let cache_key = format!("artist:{}", artist_id);
    match state.disk_cache.get(&cache_key, CacheTier::StaticMeta).await {
        CacheResult::Fresh(bytes) | CacheResult::Stale(bytes) => {
            if let Ok(detail) = serde_json::from_slice(&bytes) {
                return Ok(detail);
            }
        }
        CacheResult::Miss => {}
    }

    let mut client = state.tidal_client.lock().await;
    let detail = client.get_artist_detail(artist_id).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&detail) {
        state.disk_cache
            .put(&cache_key, &json, CacheTier::StaticMeta, &["artist", &format!("artist:{}", artist_id)])
            .await
            .ok();
    }
    Ok(detail)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_artist_top_tracks(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    artist_id: u64,
    limit: u32,
) -> Result<Vec<TidalTrack>, SoneError> {
    log::debug!("[get_artist_top_tracks]: artist_id={}, limit={}", artist_id, limit);

    let cache_key = format!("artist-tracks:{}:{}", artist_id, limit);
    match state.disk_cache.get(&cache_key, CacheTier::Dynamic).await {
        CacheResult::Fresh(bytes) => {
            if let Ok(tracks) = serde_json::from_slice(&bytes) {
                return Ok(tracks);
            }
        }
        CacheResult::Stale(bytes) => {
            if let Ok(tracks) = serde_json::from_slice::<Vec<TidalTrack>>(&bytes) {
                if state.disk_cache.mark_in_flight(&cache_key).await {
                    // Only retry if last attempt was >5min ago (300s)
                    if state.disk_cache.should_retry_refresh(&cache_key, 300).await {
                        state.disk_cache.mark_refresh_attempt(&cache_key).await;
                        let handle = app_handle.clone();
                        let key = cache_key.clone();
                        tokio::spawn(async move {
                            let st = handle.state::<AppState>();
                            let result = {
                                let mut client = st.tidal_client.lock().await;
                                client.get_artist_top_tracks(artist_id, limit).await
                            };
                            if let Ok(fresh) = result {
                                if let Ok(json) = serde_json::to_vec(&fresh) {
                                    st.disk_cache
                                        .put(&key, &json, CacheTier::Dynamic, &["artist-tracks", &format!("artist:{}", artist_id)])
                                        .await
                                        .ok();
                                }
                            }
                            st.disk_cache.clear_in_flight(&key).await;
                        });
                    } else {
                        state.disk_cache.clear_in_flight(&cache_key).await;
                    }
                }
                return Ok(tracks);
            }
        }
        CacheResult::Miss => {}
    }

    let mut client = state.tidal_client.lock().await;
    let tracks = client.get_artist_top_tracks(artist_id, limit).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&tracks) {
        state.disk_cache
            .put(&cache_key, &json, CacheTier::Dynamic, &["artist-tracks", &format!("artist:{}", artist_id)])
            .await
            .ok();
    }
    Ok(tracks)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_artist_albums(state: State<'_, AppState>, artist_id: u64, limit: u32) -> Result<Vec<TidalAlbumDetail>, SoneError> {
    log::debug!("[get_artist_albums]: artist_id={}, limit={}", artist_id, limit);

    let cache_key = format!("artist-albums:{}:{}", artist_id, limit);
    match state.disk_cache.get(&cache_key, CacheTier::StaticMeta).await {
        CacheResult::Fresh(bytes) | CacheResult::Stale(bytes) => {
            if let Ok(albums) = serde_json::from_slice(&bytes) {
                return Ok(albums);
            }
        }
        CacheResult::Miss => {}
    }

    let mut client = state.tidal_client.lock().await;
    let albums = client.get_artist_albums(artist_id, limit).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&albums) {
        state.disk_cache
            .put(&cache_key, &json, CacheTier::StaticMeta, &["artist-albums", &format!("artist:{}", artist_id)])
            .await
            .ok();
    }
    Ok(albums)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_artist_bio(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    artist_id: u64,
) -> Result<String, SoneError> {
    log::debug!("[get_artist_bio]: artist_id={}", artist_id);

    let cache_key = format!("artist-bio:{}", artist_id);
    match state.disk_cache.get(&cache_key, CacheTier::Dynamic).await {
        CacheResult::Fresh(bytes) => {
            if let Ok(bio) = serde_json::from_slice(&bytes) {
                return Ok(bio);
            }
        }
        CacheResult::Stale(bytes) => {
            if let Ok(bio) = serde_json::from_slice::<String>(&bytes) {
                if state.disk_cache.mark_in_flight(&cache_key).await {
                    // Only retry if last attempt was >5min ago (300s)
                    if state.disk_cache.should_retry_refresh(&cache_key, 300).await {
                        state.disk_cache.mark_refresh_attempt(&cache_key).await;
                        let handle = app_handle.clone();
                        let key = cache_key.clone();
                        tokio::spawn(async move {
                            let st = handle.state::<AppState>();
                            let result = {
                                let mut client = st.tidal_client.lock().await;
                                client.get_artist_bio(artist_id).await
                            };
                            if let Ok(fresh) = result {
                                if let Ok(json) = serde_json::to_vec(&fresh) {
                                    st.disk_cache
                                        .put(&key, &json, CacheTier::Dynamic, &["artist-bio", &format!("artist:{}", artist_id)])
                                        .await
                                        .ok();
                                }
                            }
                            st.disk_cache.clear_in_flight(&key).await;
                        });
                    } else {
                        state.disk_cache.clear_in_flight(&cache_key).await;
                    }
                }
                return Ok(bio);
            }
        }
        CacheResult::Miss => {}
    }

    let mut client = state.tidal_client.lock().await;
    let bio = client.get_artist_bio(artist_id).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&bio) {
        state.disk_cache
            .put(&cache_key, &json, CacheTier::Dynamic, &["artist-bio", &format!("artist:{}", artist_id)])
            .await
            .ok();
    }
    Ok(bio)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_artist_page(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    artist_id: u64,
) -> Result<Value, SoneError> {
    log::debug!("[get_artist_page]: artist_id={}", artist_id);

    let cache_key = format!("artist-page:{}", artist_id);
    match state.disk_cache.get(&cache_key, CacheTier::Dynamic).await {
        CacheResult::Fresh(bytes) => {
            if let Ok(page) = serde_json::from_slice(&bytes) {
                return Ok(page);
            }
        }
        CacheResult::Stale(bytes) => {
            if let Ok(page) = serde_json::from_slice::<Value>(&bytes) {
                if state.disk_cache.mark_in_flight(&cache_key).await {
                    if state.disk_cache.should_retry_refresh(&cache_key, 300).await {
                        state.disk_cache.mark_refresh_attempt(&cache_key).await;
                        let handle = app_handle.clone();
                        let key = cache_key.clone();
                        tokio::spawn(async move {
                            let st = handle.state::<AppState>();
                            let result = {
                                let mut client = st.tidal_client.lock().await;
                                client.get_artist_page(artist_id).await
                            };
                            if let Ok(fresh) = result {
                                if let Ok(json) = serde_json::to_vec(&fresh) {
                                    st.disk_cache
                                        .put(&key, &json, CacheTier::Dynamic, &["artist", &format!("artist:{}", artist_id)])
                                        .await
                                        .ok();
                                }
                            }
                            st.disk_cache.clear_in_flight(&key).await;
                        });
                    } else {
                        state.disk_cache.clear_in_flight(&cache_key).await;
                    }
                }
                return Ok(page);
            }
        }
        CacheResult::Miss => {}
    }

    let mut client = state.tidal_client.lock().await;
    let page = client.get_artist_page(artist_id).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&page) {
        state.disk_cache
            .put(&cache_key, &json, CacheTier::Dynamic, &["artist", &format!("artist:{}", artist_id)])
            .await
            .ok();
    }
    Ok(page)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_artist_top_tracks_all(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    artist_id: u64,
    offset: u32,
    limit: u32,
) -> Result<Value, SoneError> {
    log::debug!("[get_artist_top_tracks_all]: artist_id={} offset={} limit={}", artist_id, offset, limit);

    let cache_key = format!("artist-top-tracks-all:{}:{}:{}", artist_id, offset, limit);
    match state.disk_cache.get(&cache_key, CacheTier::Dynamic).await {
        CacheResult::Fresh(bytes) => {
            if let Ok(data) = serde_json::from_slice(&bytes) {
                return Ok(data);
            }
        }
        CacheResult::Stale(bytes) => {
            if let Ok(data) = serde_json::from_slice::<Value>(&bytes) {
                if state.disk_cache.mark_in_flight(&cache_key).await {
                    if state.disk_cache.should_retry_refresh(&cache_key, 300).await {
                        state.disk_cache.mark_refresh_attempt(&cache_key).await;
                        let handle = app_handle.clone();
                        let key = cache_key.clone();
                        tokio::spawn(async move {
                            let st = handle.state::<AppState>();
                            let result = {
                                let mut client = st.tidal_client.lock().await;
                                client.get_artist_top_tracks_all(artist_id, offset, limit).await
                            };
                            if let Ok(fresh) = result {
                                if let Ok(json) = serde_json::to_vec(&fresh) {
                                    st.disk_cache
                                        .put(&key, &json, CacheTier::Dynamic, &["artist", &format!("artist:{}", artist_id)])
                                        .await
                                        .ok();
                                }
                            }
                            st.disk_cache.clear_in_flight(&key).await;
                        });
                    } else {
                        state.disk_cache.clear_in_flight(&cache_key).await;
                    }
                }
                return Ok(data);
            }
        }
        CacheResult::Miss => {}
    }

    let mut client = state.tidal_client.lock().await;
    let data = client.get_artist_top_tracks_all(artist_id, offset, limit).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&data) {
        state.disk_cache
            .put(&cache_key, &json, CacheTier::Dynamic, &["artist", &format!("artist:{}", artist_id)])
            .await
            .ok();
    }
    Ok(data)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_artist_view_all(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    artist_id: u64,
    view_all_path: String,
) -> Result<Value, SoneError> {
    log::debug!("[get_artist_view_all]: artist_id={}, path={}", artist_id, view_all_path);

    let cache_key = format!("artist-view-all:{}:{}", artist_id, view_all_path);
    match state.disk_cache.get(&cache_key, CacheTier::Dynamic).await {
        CacheResult::Fresh(bytes) => {
            if let Ok(data) = serde_json::from_slice(&bytes) {
                return Ok(data);
            }
        }
        CacheResult::Stale(bytes) => {
            if let Ok(data) = serde_json::from_slice::<Value>(&bytes) {
                if state.disk_cache.mark_in_flight(&cache_key).await {
                    if state.disk_cache.should_retry_refresh(&cache_key, 300).await {
                        state.disk_cache.mark_refresh_attempt(&cache_key).await;
                        let handle = app_handle.clone();
                        let key = cache_key.clone();
                        let path = view_all_path.clone();
                        tokio::spawn(async move {
                            let st = handle.state::<AppState>();
                            let result = {
                                let mut client = st.tidal_client.lock().await;
                                client.get_artist_view_all(artist_id, &path).await
                            };
                            if let Ok(fresh) = result {
                                if let Ok(json) = serde_json::to_vec(&fresh) {
                                    st.disk_cache
                                        .put(&key, &json, CacheTier::Dynamic, &["artist", &format!("artist:{}", artist_id)])
                                        .await
                                        .ok();
                                }
                            }
                            st.disk_cache.clear_in_flight(&key).await;
                        });
                    } else {
                        state.disk_cache.clear_in_flight(&cache_key).await;
                    }
                }
                return Ok(data);
            }
        }
        CacheResult::Miss => {}
    }

    let mut client = state.tidal_client.lock().await;
    let data = client.get_artist_view_all(artist_id, &view_all_path).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&data) {
        state.disk_cache
            .put(&cache_key, &json, CacheTier::Dynamic, &["artist", &format!("artist:{}", artist_id)])
            .await
            .ok();
    }
    Ok(data)
}

/// Debug command: returns the raw JSON structure of multiple page endpoints
#[tauri::command]
pub async fn debug_home_page_raw(state: State<'_, AppState>) -> Result<String, SoneError> {
    let access_token = {
        let client = state.tidal_client.lock().await;
        let tokens = client.tokens.as_ref().ok_or(SoneError::NotAuthenticated)?;
        tokens.access_token.clone()
    };

    let http = reqwest::Client::new();
    let mut summary = String::new();

    let endpoints = [
        "pages/home",
        "pages/for_you",
        "pages/my_collection_recently_played",
        "pages/my_collection_my_mixes",
        "pages/explore",
        "pages/suggested_new_tracks_for_you",
        "pages/suggested_new_albums_for_you",
        "pages/show/essential_album",
    ];

    for endpoint in &endpoints {
        summary.push_str(&format!("=== {} ===\n", endpoint));

        let response = http
            .get(format!("https://api.tidal.com/v1/{}", endpoint))
            .header("Authorization", format!("Bearer {}", access_token))
            .query(&[("countryCode", "US"), ("deviceType", "BROWSER"), ("locale", "en_US")])
            .send()
            .await;

        match response {
            Ok(resp) => {
                let status = resp.status();
                if !status.is_success() {
                    summary.push_str(&format!("  ERROR: status {}\n\n", status));
                    continue;
                }
                let body = resp.text().await.unwrap_or_default();
                let json: serde_json::Value = match serde_json::from_str(&body) {
                    Ok(j) => j,
                    Err(e) => { summary.push_str(&format!("  PARSE ERROR: {}\n\n", e)); continue; }
                };

                summary.push_str(&format!("  Top-level keys: {:?}\n",
                    json.as_object().map(|o| o.keys().collect::<Vec<_>>()).unwrap_or_default()));

                // V1
                if let Some(rows) = json.get("rows").and_then(|r| r.as_array()) {
                    summary.push_str(&format!("  FORMAT: V1 (rows), {} rows\n", rows.len()));
                    for (i, row) in rows.iter().enumerate() {
                        if let Some(modules) = row.get("modules").and_then(|m| m.as_array()) {
                            for module in modules {
                                let mtype = module.get("type").and_then(|t| t.as_str()).unwrap_or("?");
                                let title = module.get("title").and_then(|t| t.as_str()).unwrap_or("(no title)");
                                let item_count = module.get("pagedList")
                                    .and_then(|pl| pl.get("items"))
                                    .and_then(|i| i.as_array())
                                    .map(|a| a.len())
                                    .or_else(|| module.get("highlights").and_then(|h| h.as_array()).map(|a| a.len()))
                                    .unwrap_or(0);
                                let has_more = module.get("showMore").is_some();
                                summary.push_str(&format!("    Row {}: type={:<30} title=\"{}\" items={} more={}\n",
                                    i, mtype, title, item_count, has_more));
                            }
                        }
                    }
                }

                // V2
                if let Some(items) = json.get("items").and_then(|i| i.as_array()) {
                    summary.push_str(&format!("  FORMAT: V2 (items), {} sections\n", items.len()));
                    for (i, item) in items.iter().enumerate() {
                        let stype = item.get("type").and_then(|t| t.as_str()).unwrap_or("?");
                        let title = item.get("title")
                            .and_then(|t| t.as_str())
                            .or_else(|| item.get("titleTextInfo").and_then(|ti| ti.get("text")).and_then(|t| t.as_str()))
                            .unwrap_or("(no title)");
                        let item_count = item.get("items").and_then(|i| i.as_array()).map(|a| a.len()).unwrap_or(0);
                        let has_view_all = item.get("viewAll").is_some() || item.get("showMore").is_some();
                        let first_type = item.get("items").and_then(|i| i.as_array())
                            .and_then(|a| a.first()).and_then(|f| f.get("type")).and_then(|t| t.as_str()).unwrap_or("?");
                        summary.push_str(&format!("    Sec {}: type={:<35} title=\"{}\" items={} first={} more={}\n",
                            i, stype, title, item_count, first_type, has_view_all));
                    }
                }
            }
            Err(e) => {
                summary.push_str(&format!("  FETCH ERROR: {}\n", e));
            }
        }
        summary.push('\n');
    }

    Ok(summary)
}

