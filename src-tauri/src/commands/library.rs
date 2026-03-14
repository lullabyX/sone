use tauri::{Manager, State};

use crate::cache::{CacheResult, CacheTier};
use crate::tidal_api::{
    AllFavoriteIds, PaginatedTracks, TidalAlbumDetail, TidalArtistDetail, TidalPlaylist, TidalTrack,
};
use crate::AppState;
use crate::SoneError;

#[tauri::command(rename_all = "camelCase")]
pub async fn get_user_playlists(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    user_id: u64,
    offset: u32,
    limit: u32,
) -> Result<crate::tidal_api::PaginatedResponse<TidalPlaylist>, SoneError> {
    log::debug!(
        "[get_user_playlists]: user_id={}, offset={}, limit={}",
        user_id,
        offset,
        limit
    );

    let cache_key = format!("user-playlists:{}:{}:{}", user_id, offset, limit);
    match state
        .disk_cache
        .get(&cache_key, CacheTier::UserContent)
        .await
    {
        CacheResult::Fresh(bytes) => {
            if let Ok(data) = serde_json::from_slice(&bytes) {
                return Ok(data);
            }
        }
        CacheResult::Stale(bytes) => {
            if let Ok(data) =
                serde_json::from_slice::<crate::tidal_api::PaginatedResponse<TidalPlaylist>>(&bytes)
            {
                if state.disk_cache.mark_in_flight(&cache_key).await {
                    if state.disk_cache.should_retry_refresh(&cache_key, 300).await {
                        state.disk_cache.mark_refresh_attempt(&cache_key).await;
                        let handle = app_handle.clone();
                        let key = cache_key.clone();
                        tokio::spawn(async move {
                            let st = handle.state::<AppState>();
                            let result = {
                                let mut client = st.tidal_client.lock().await;
                                client.get_user_playlists(user_id, offset, limit).await
                            };
                            if let Ok(fresh) = result {
                                if let Ok(json) = serde_json::to_vec(&fresh) {
                                    st.disk_cache
                                        .put(
                                            &key,
                                            &json,
                                            CacheTier::UserContent,
                                            &["user-playlists", &format!("user:{}", user_id)],
                                        )
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
    let data = client.get_user_playlists(user_id, offset, limit).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&data) {
        state
            .disk_cache
            .put(
                &cache_key,
                &json,
                CacheTier::UserContent,
                &["user-playlists", &format!("user:{}", user_id)],
            )
            .await
            .ok();
    }
    Ok(data)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_playlist_tracks(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    playlist_id: String,
) -> Result<Vec<TidalTrack>, SoneError> {
    log::debug!("[get_playlist_tracks]: playlist_id={}", playlist_id);

    let cache_key = format!("playlist:{}", playlist_id);
    match state
        .disk_cache
        .get(&cache_key, CacheTier::UserContent)
        .await
    {
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
                        let pid = playlist_id.clone();
                        tokio::spawn(async move {
                            let st = handle.state::<AppState>();
                            let result = {
                                let mut client = st.tidal_client.lock().await;
                                client.get_playlist_tracks(&pid).await
                            };
                            if let Ok(fresh) = result {
                                if let Ok(json) = serde_json::to_vec(&fresh) {
                                    st.disk_cache
                                        .put(
                                            &key,
                                            &json,
                                            CacheTier::UserContent,
                                            &["playlist", &format!("playlist:{}", pid)],
                                        )
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
    let tracks = client.get_playlist_tracks(&playlist_id).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&tracks) {
        state
            .disk_cache
            .put(
                &cache_key,
                &json,
                CacheTier::UserContent,
                &["playlist", &format!("playlist:{}", playlist_id)],
            )
            .await
            .ok();
    }
    Ok(tracks)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_playlist_tracks_page(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    playlist_id: String,
    offset: u32,
    limit: u32,
) -> Result<PaginatedTracks, SoneError> {
    log::debug!(
        "[get_playlist_tracks_page]: playlist_id={}, offset={}, limit={}",
        playlist_id,
        offset,
        limit
    );

    let cache_key = format!("playlist-page:{}:{}:{}", playlist_id, offset, limit);
    match state
        .disk_cache
        .get(&cache_key, CacheTier::UserContent)
        .await
    {
        CacheResult::Fresh(bytes) => {
            if let Ok(tracks) = serde_json::from_slice(&bytes) {
                return Ok(tracks);
            }
        }
        CacheResult::Stale(bytes) => {
            if let Ok(tracks) = serde_json::from_slice::<PaginatedTracks>(&bytes) {
                if state.disk_cache.mark_in_flight(&cache_key).await {
                    // Only retry if last attempt was >5min ago (300s)
                    if state.disk_cache.should_retry_refresh(&cache_key, 300).await {
                        state.disk_cache.mark_refresh_attempt(&cache_key).await;
                        let handle = app_handle.clone();
                        let key = cache_key.clone();
                        let pid = playlist_id.clone();
                        tokio::spawn(async move {
                            let st = handle.state::<AppState>();
                            let result = {
                                let mut client = st.tidal_client.lock().await;
                                client.get_playlist_tracks_page(&pid, offset, limit).await
                            };
                            if let Ok(fresh) = result {
                                if let Ok(json) = serde_json::to_vec(&fresh) {
                                    st.disk_cache
                                        .put(
                                            &key,
                                            &json,
                                            CacheTier::UserContent,
                                            &["playlist", &format!("playlist:{}", pid)],
                                        )
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
    let tracks = client
        .get_playlist_tracks_page(&playlist_id, offset, limit)
        .await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&tracks) {
        state
            .disk_cache
            .put(
                &cache_key,
                &json,
                CacheTier::UserContent,
                &["playlist", &format!("playlist:{}", playlist_id)],
            )
            .await
            .ok();
    }
    Ok(tracks)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_favorite_playlists(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    user_id: u64,
    offset: u32,
    limit: u32,
) -> Result<crate::tidal_api::PaginatedResponse<TidalPlaylist>, SoneError> {
    log::debug!(
        "[get_favorite_playlists]: user_id={}, offset={}, limit={}",
        user_id,
        offset,
        limit
    );

    let cache_key = format!("fav-playlists:{}:{}:{}", user_id, offset, limit);
    match state
        .disk_cache
        .get(&cache_key, CacheTier::UserContent)
        .await
    {
        CacheResult::Fresh(bytes) => {
            if let Ok(data) = serde_json::from_slice(&bytes) {
                return Ok(data);
            }
        }
        CacheResult::Stale(bytes) => {
            if let Ok(data) =
                serde_json::from_slice::<crate::tidal_api::PaginatedResponse<TidalPlaylist>>(&bytes)
            {
                if state.disk_cache.mark_in_flight(&cache_key).await {
                    if state.disk_cache.should_retry_refresh(&cache_key, 300).await {
                        state.disk_cache.mark_refresh_attempt(&cache_key).await;
                        let handle = app_handle.clone();
                        let key = cache_key.clone();
                        tokio::spawn(async move {
                            let st = handle.state::<AppState>();
                            let result = {
                                let mut client = st.tidal_client.lock().await;
                                client.get_favorite_playlists(user_id, offset, limit).await
                            };
                            if let Ok(fresh) = result {
                                if let Ok(json) = serde_json::to_vec(&fresh) {
                                    st.disk_cache
                                        .put(
                                            &key,
                                            &json,
                                            CacheTier::UserContent,
                                            &["fav-playlists", &format!("user:{}", user_id)],
                                        )
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
    let data = client
        .get_favorite_playlists(user_id, offset, limit)
        .await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&data) {
        state
            .disk_cache
            .put(
                &cache_key,
                &json,
                CacheTier::UserContent,
                &["fav-playlists", &format!("user:{}", user_id)],
            )
            .await
            .ok();
    }
    Ok(data)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_favorite_albums(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    user_id: u64,
    offset: u32,
    limit: u32,
    order: String,
    order_direction: String,
) -> Result<crate::tidal_api::PaginatedResponse<TidalAlbumDetail>, SoneError> {
    log::debug!(
        "[get_favorite_albums]: user_id={}, offset={}, limit={}, order={}, dir={}",
        user_id,
        offset,
        limit,
        order,
        order_direction
    );

    let cache_key = format!("fav-albums:{}:{}:{}:{}:{}", user_id, offset, limit, order, order_direction);
    match state
        .disk_cache
        .get(&cache_key, CacheTier::UserContent)
        .await
    {
        CacheResult::Fresh(bytes) => {
            if let Ok(data) = serde_json::from_slice(&bytes) {
                return Ok(data);
            }
        }
        CacheResult::Stale(bytes) => {
            if let Ok(data) = serde_json::from_slice::<
                crate::tidal_api::PaginatedResponse<TidalAlbumDetail>,
            >(&bytes)
            {
                if state.disk_cache.mark_in_flight(&cache_key).await {
                    if state.disk_cache.should_retry_refresh(&cache_key, 300).await {
                        state.disk_cache.mark_refresh_attempt(&cache_key).await;
                        let handle = app_handle.clone();
                        let key = cache_key.clone();
                        let order_bg = order.clone();
                        let dir_bg = order_direction.clone();
                        tokio::spawn(async move {
                            let st = handle.state::<AppState>();
                            let result = {
                                let mut client = st.tidal_client.lock().await;
                                client.get_favorite_albums(user_id, offset, limit, &order_bg, &dir_bg).await
                            };
                            if let Ok(fresh) = result {
                                if let Ok(json) = serde_json::to_vec(&fresh) {
                                    st.disk_cache
                                        .put(
                                            &key,
                                            &json,
                                            CacheTier::UserContent,
                                            &["fav-albums", &format!("user:{}", user_id)],
                                        )
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
    let data = client.get_favorite_albums(user_id, offset, limit, &order, &order_direction).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&data) {
        state
            .disk_cache
            .put(
                &cache_key,
                &json,
                CacheTier::UserContent,
                &["fav-albums", &format!("user:{}", user_id)],
            )
            .await
            .ok();
    }
    Ok(data)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn create_playlist(
    state: State<'_, AppState>,
    user_id: u64,
    title: String,
    description: String,
) -> Result<TidalPlaylist, SoneError> {
    log::debug!("[create_playlist]: user_id={}, title={}", user_id, title);
    let client = state.tidal_client.lock().await;
    let playlist = client
        .create_playlist(user_id, &title, &description)
        .await?;
    drop(client);
    // Invalidate user playlists cache
    state
        .disk_cache
        .invalidate_tag(&format!("user:{}", user_id))
        .await;
    Ok(playlist)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn add_track_to_playlist(
    state: State<'_, AppState>,
    playlist_id: String,
    track_id: u64,
) -> Result<(), SoneError> {
    log::debug!(
        "[add_track_to_playlist]: playlist_id={}, track_id={}",
        playlist_id,
        track_id
    );
    let client = state.tidal_client.lock().await;
    client.add_track_to_playlist(&playlist_id, track_id).await?;
    drop(client);
    state
        .disk_cache
        .invalidate_tag(&format!("playlist:{}", playlist_id))
        .await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn remove_track_from_playlist(
    state: State<'_, AppState>,
    playlist_id: String,
    index: u32,
) -> Result<(), SoneError> {
    log::debug!(
        "[remove_track_from_playlist]: playlist_id={}, index={}",
        playlist_id,
        index
    );
    let client = state.tidal_client.lock().await;
    client
        .remove_track_from_playlist(&playlist_id, index)
        .await?;
    drop(client);
    state
        .disk_cache
        .invalidate_tag(&format!("playlist:{}", playlist_id))
        .await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn delete_playlist(
    state: State<'_, AppState>,
    user_id: u64,
    playlist_id: String,
) -> Result<(), SoneError> {
    log::debug!(
        "[delete_playlist]: user_id={}, playlist_id={}",
        user_id,
        playlist_id
    );
    let client = state.tidal_client.lock().await;
    client.delete_playlist(&playlist_id).await?;
    drop(client);
    state
        .disk_cache
        .invalidate_tag(&format!("user:{}", user_id))
        .await;
    state
        .disk_cache
        .invalidate_tag(&format!("playlist:{}", playlist_id))
        .await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_favorite_tracks(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    user_id: u64,
    offset: u32,
    limit: u32,
) -> Result<PaginatedTracks, SoneError> {
    log::debug!(
        "[get_favorite_tracks]: user_id={}, offset={}, limit={}",
        user_id,
        offset,
        limit
    );

    let cache_key = format!("fav-tracks:{}:{}:{}", user_id, offset, limit);
    match state
        .disk_cache
        .get(&cache_key, CacheTier::UserContent)
        .await
    {
        CacheResult::Fresh(bytes) => {
            if let Ok(tracks) = serde_json::from_slice(&bytes) {
                return Ok(tracks);
            }
        }
        CacheResult::Stale(bytes) => {
            if let Ok(tracks) = serde_json::from_slice::<PaginatedTracks>(&bytes) {
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
                                client.get_favorite_tracks(user_id, offset, limit).await
                            };
                            if let Ok(fresh) = result {
                                if let Ok(json) = serde_json::to_vec(&fresh) {
                                    st.disk_cache
                                        .put(
                                            &key,
                                            &json,
                                            CacheTier::UserContent,
                                            &["fav-tracks", &format!("user:{}", user_id)],
                                        )
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
    let tracks = client.get_favorite_tracks(user_id, offset, limit).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&tracks) {
        state
            .disk_cache
            .put(
                &cache_key,
                &json,
                CacheTier::UserContent,
                &["fav-tracks", &format!("user:{}", user_id)],
            )
            .await
            .ok();
    }
    Ok(tracks)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_favorite_track_ids(
    state: State<'_, AppState>,
    user_id: u64,
) -> Result<Vec<u64>, SoneError> {
    log::debug!("[get_favorite_track_ids]: user_id={}", user_id);
    let client = state.tidal_client.lock().await;
    client.get_favorite_track_ids(user_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn is_track_favorited(
    state: State<'_, AppState>,
    user_id: u64,
    track_id: u64,
) -> Result<bool, SoneError> {
    log::debug!(
        "[is_track_favorited]: user_id={}, track_id={}",
        user_id,
        track_id
    );
    let client = state.tidal_client.lock().await;
    client.is_track_favorited(user_id, track_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn add_favorite_track(
    state: State<'_, AppState>,
    user_id: u64,
    track_id: u64,
) -> Result<(), SoneError> {
    log::debug!(
        "[add_favorite_track]: user_id={}, track_id={}",
        user_id,
        track_id
    );
    let client = state.tidal_client.lock().await;
    client.add_favorite_track(user_id, track_id).await?;
    drop(client);
    state.disk_cache.invalidate_tag("fav-tracks").await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn remove_favorite_track(
    state: State<'_, AppState>,
    user_id: u64,
    track_id: u64,
) -> Result<(), SoneError> {
    log::debug!(
        "[remove_favorite_track]: user_id={}, track_id={}",
        user_id,
        track_id
    );
    let client = state.tidal_client.lock().await;
    client.remove_favorite_track(user_id, track_id).await?;
    drop(client);
    state.disk_cache.invalidate_tag("fav-tracks").await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_favorite_album_ids(
    state: State<'_, AppState>,
    user_id: u64,
) -> Result<Vec<u64>, SoneError> {
    log::debug!("[get_favorite_album_ids]: user_id={}", user_id);
    let client = state.tidal_client.lock().await;
    client.get_favorite_album_ids(user_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn is_album_favorited(
    state: State<'_, AppState>,
    user_id: u64,
    album_id: u64,
) -> Result<bool, SoneError> {
    log::debug!(
        "[is_album_favorited]: user_id={}, album_id={}",
        user_id,
        album_id
    );
    let client = state.tidal_client.lock().await;
    client.is_album_favorited(user_id, album_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn add_favorite_album(
    state: State<'_, AppState>,
    user_id: u64,
    album_id: u64,
) -> Result<(), SoneError> {
    log::debug!(
        "[add_favorite_album]: user_id={}, album_id={}",
        user_id,
        album_id
    );
    let client = state.tidal_client.lock().await;
    client.add_favorite_album(user_id, album_id).await?;
    drop(client);
    state.disk_cache.invalidate_tag("fav-albums").await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn remove_favorite_album(
    state: State<'_, AppState>,
    user_id: u64,
    album_id: u64,
) -> Result<(), SoneError> {
    log::debug!(
        "[remove_favorite_album]: user_id={}, album_id={}",
        user_id,
        album_id
    );
    let client = state.tidal_client.lock().await;
    client.remove_favorite_album(user_id, album_id).await?;
    drop(client);
    state.disk_cache.invalidate_tag("fav-albums").await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_favorite_playlist_uuids(
    state: State<'_, AppState>,
    user_id: u64,
) -> Result<Vec<String>, SoneError> {
    log::debug!("[get_favorite_playlist_uuids]: user_id={}", user_id);
    let client = state.tidal_client.lock().await;
    client.get_favorite_playlist_uuids(user_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn add_favorite_playlist(
    state: State<'_, AppState>,
    user_id: u64,
    playlist_uuid: String,
) -> Result<(), SoneError> {
    log::debug!(
        "[add_favorite_playlist]: user_id={}, playlist_uuid={}",
        user_id,
        playlist_uuid
    );
    let client = state.tidal_client.lock().await;
    client
        .add_favorite_playlist(user_id, &playlist_uuid)
        .await?;
    drop(client);
    state.disk_cache.invalidate_tag("fav-playlists").await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn remove_favorite_playlist(
    state: State<'_, AppState>,
    user_id: u64,
    playlist_uuid: String,
) -> Result<(), SoneError> {
    log::debug!(
        "[remove_favorite_playlist]: user_id={}, playlist_uuid={}",
        user_id,
        playlist_uuid
    );
    let client = state.tidal_client.lock().await;
    client
        .remove_favorite_playlist(user_id, &playlist_uuid)
        .await?;
    drop(client);
    state.disk_cache.invalidate_tag("fav-playlists").await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_favorite_artist_ids(
    state: State<'_, AppState>,
    user_id: u64,
) -> Result<Vec<u64>, SoneError> {
    log::debug!("[get_favorite_artist_ids]: user_id={}", user_id);
    let client = state.tidal_client.lock().await;
    client.get_favorite_artist_ids(user_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn add_favorite_artist(
    state: State<'_, AppState>,
    user_id: u64,
    artist_id: u64,
) -> Result<(), SoneError> {
    log::debug!(
        "[add_favorite_artist]: user_id={}, artist_id={}",
        user_id,
        artist_id
    );
    let client = state.tidal_client.lock().await;
    client.add_favorite_artist(user_id, artist_id).await?;
    drop(client);
    state.disk_cache.invalidate_tag("fav-artists").await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn remove_favorite_artist(
    state: State<'_, AppState>,
    user_id: u64,
    artist_id: u64,
) -> Result<(), SoneError> {
    log::debug!(
        "[remove_favorite_artist]: user_id={}, artist_id={}",
        user_id,
        artist_id
    );
    let client = state.tidal_client.lock().await;
    client.remove_favorite_artist(user_id, artist_id).await?;
    drop(client);
    state.disk_cache.invalidate_tag("fav-artists").await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_all_favorite_ids(
    state: State<'_, AppState>,
    user_id: u64,
) -> Result<AllFavoriteIds, SoneError> {
    log::debug!("[get_all_favorite_ids]: user_id={}", user_id);
    let client = state.tidal_client.lock().await;
    client.get_all_favorite_ids(user_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn add_favorite_mix(state: State<'_, AppState>, mix_id: String) -> Result<(), SoneError> {
    log::debug!("[add_favorite_mix]: mix_id={}", mix_id);
    let client = state.tidal_client.lock().await;
    client.add_favorite_mix(&mix_id).await?;
    drop(client);
    state.disk_cache.invalidate_tag("fav-mixes").await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn remove_favorite_mix(
    state: State<'_, AppState>,
    mix_id: String,
) -> Result<(), SoneError> {
    log::debug!("[remove_favorite_mix]: mix_id={}", mix_id);
    let client = state.tidal_client.lock().await;
    client.remove_favorite_mix(&mix_id).await?;
    drop(client);
    state.disk_cache.invalidate_tag("fav-mixes").await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_favorite_mix_ids(state: State<'_, AppState>) -> Result<Vec<String>, SoneError> {
    log::debug!("[get_favorite_mix_ids]");
    let mut client = state.tidal_client.lock().await;
    client.get_favorite_mix_ids().await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_favorite_mixes(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    offset: u32,
    limit: u32,
    order: String,
    order_direction: String,
) -> Result<crate::tidal_api::PaginatedResponse<crate::tidal_api::TidalFavoriteMix>, SoneError> {
    log::debug!(
        "[get_favorite_mixes]: offset={}, limit={}, order={}, dir={}",
        offset,
        limit,
        order,
        order_direction
    );

    let cache_key = format!("fav-mixes:{}:{}:{}:{}", offset, limit, order, order_direction);
    match state
        .disk_cache
        .get(&cache_key, CacheTier::UserContent)
        .await
    {
        CacheResult::Fresh(bytes) => {
            if let Ok(data) = serde_json::from_slice(&bytes) {
                return Ok(data);
            }
        }
        CacheResult::Stale(bytes) => {
            if let Ok(data) = serde_json::from_slice::<
                crate::tidal_api::PaginatedResponse<crate::tidal_api::TidalFavoriteMix>,
            >(&bytes)
            {
                if state.disk_cache.mark_in_flight(&cache_key).await {
                    if state.disk_cache.should_retry_refresh(&cache_key, 300).await {
                        state.disk_cache.mark_refresh_attempt(&cache_key).await;
                        let handle = app_handle.clone();
                        let key = cache_key.clone();
                        let order_bg = order.clone();
                        let dir_bg = order_direction.clone();
                        tokio::spawn(async move {
                            let st = handle.state::<AppState>();
                            let result = {
                                let mut client = st.tidal_client.lock().await;
                                client.get_favorite_mixes(offset, limit, &order_bg, &dir_bg).await
                            };
                            if let Ok(fresh) = result {
                                if let Ok(json) = serde_json::to_vec(&fresh) {
                                    st.disk_cache
                                        .put(&key, &json, CacheTier::UserContent, &["fav-mixes"])
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
    let data = client.get_favorite_mixes(offset, limit, &order, &order_direction).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&data) {
        state
            .disk_cache
            .put(&cache_key, &json, CacheTier::UserContent, &["fav-mixes"])
            .await
            .ok();
    }
    Ok(data)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn add_tracks_to_playlist(
    state: State<'_, AppState>,
    playlist_id: String,
    track_ids: Vec<u64>,
) -> Result<(), SoneError> {
    log::debug!(
        "[add_tracks_to_playlist]: playlist_id={}, count={}",
        playlist_id,
        track_ids.len()
    );
    let client = state.tidal_client.lock().await;
    client
        .add_tracks_to_playlist(&playlist_id, &track_ids)
        .await?;
    drop(client);
    state
        .disk_cache
        .invalidate_tag(&format!("playlist:{}", playlist_id))
        .await;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_favorite_artists(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    user_id: u64,
    offset: u32,
    limit: u32,
    order: String,
    order_direction: String,
) -> Result<crate::tidal_api::PaginatedResponse<TidalArtistDetail>, SoneError> {
    log::debug!(
        "[get_favorite_artists]: user_id={}, offset={}, limit={}, order={}, dir={}",
        user_id,
        offset,
        limit,
        order,
        order_direction
    );

    let cache_key = format!("fav-artists:{}:{}:{}:{}:{}", user_id, offset, limit, order, order_direction);
    match state
        .disk_cache
        .get(&cache_key, CacheTier::UserContent)
        .await
    {
        CacheResult::Fresh(bytes) => {
            if let Ok(data) = serde_json::from_slice(&bytes) {
                return Ok(data);
            }
        }
        CacheResult::Stale(bytes) => {
            if let Ok(data) = serde_json::from_slice::<
                crate::tidal_api::PaginatedResponse<TidalArtistDetail>,
            >(&bytes)
            {
                if state.disk_cache.mark_in_flight(&cache_key).await {
                    if state.disk_cache.should_retry_refresh(&cache_key, 300).await {
                        state.disk_cache.mark_refresh_attempt(&cache_key).await;
                        let handle = app_handle.clone();
                        let key = cache_key.clone();
                        let order_bg = order.clone();
                        let dir_bg = order_direction.clone();
                        tokio::spawn(async move {
                            let st = handle.state::<AppState>();
                            let result = {
                                let mut client = st.tidal_client.lock().await;
                                client.get_favorite_artists(user_id, offset, limit, &order_bg, &dir_bg).await
                            };
                            if let Ok(fresh) = result {
                                if let Ok(json) = serde_json::to_vec(&fresh) {
                                    st.disk_cache
                                        .put(
                                            &key,
                                            &json,
                                            CacheTier::UserContent,
                                            &["fav-artists", &format!("user:{}", user_id)],
                                        )
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
    let data = client.get_favorite_artists(user_id, offset, limit, &order, &order_direction).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&data) {
        state
            .disk_cache
            .put(
                &cache_key,
                &json,
                CacheTier::UserContent,
                &["fav-artists", &format!("user:{}", user_id)],
            )
            .await
            .ok();
    }
    Ok(data)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_playlist_folders(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    folder_id: String,
    include_only: Option<String>,
    offset: u32,
    limit: u32,
    order: String,
    order_direction: String,
    cursor: Option<String>,
) -> Result<serde_json::Value, SoneError> {
    log::debug!(
        "[get_playlist_folders]: folder_id={}, offset={}, limit={}, cursor={:?}",
        folder_id,
        offset,
        limit,
        cursor
    );

    let cache_key = format!(
        "playlist-folders:{}:{}:{}:{}:{}:{:?}",
        folder_id, offset, limit, order, order_direction, cursor
    );

    match state
        .disk_cache
        .get(&cache_key, CacheTier::UserContent)
        .await
    {
        CacheResult::Fresh(bytes) => {
            if let Ok(val) = serde_json::from_slice(&bytes) {
                return Ok(val);
            }
        }
        CacheResult::Stale(bytes) => {
            if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if state.disk_cache.mark_in_flight(&cache_key).await {
                    if state
                        .disk_cache
                        .should_retry_refresh(&cache_key, 300)
                        .await
                    {
                        state.disk_cache.mark_refresh_attempt(&cache_key).await;
                        let handle = app_handle.clone();
                        let key = cache_key.clone();
                        let fi = folder_id.clone();
                        let io = include_only.clone();
                        let o = order.clone();
                        let od = order_direction.clone();
                        let c = cursor.clone();
                        tokio::spawn(async move {
                            let st = handle.state::<AppState>();
                            let result = {
                                let mut client = st.tidal_client.lock().await;
                                client
                                    .get_playlist_folders(
                                        &fi,
                                        io.as_deref().unwrap_or(""),
                                        offset,
                                        limit,
                                        &o,
                                        &od,
                                        c.as_deref().unwrap_or(""),
                                    )
                                    .await
                            };
                            match result {
                                Ok(fresh) => {
                                    if let Ok(bytes) = serde_json::to_vec(&fresh) {
                                        st.disk_cache
                                            .put(
                                                &key,
                                                &bytes,
                                                CacheTier::UserContent,
                                                &["folders", &format!("folder:{}", fi)],
                                            )
                                            .await
                                            .ok();
                                    }
                                }
                                Err(e) => {
                                    log::warn!(
                                        "[get_playlist_folders] bg refresh failed: {}",
                                        e
                                    );
                                }
                            }
                            st.disk_cache.clear_in_flight(&key).await;
                        });
                    } else {
                        state.disk_cache.clear_in_flight(&cache_key).await;
                    }
                }
                return Ok(val);
            }
        }
        CacheResult::Miss => {}
    }

    let data = {
        let mut client = state.tidal_client.lock().await;
        client
            .get_playlist_folders(
                &folder_id,
                include_only.as_deref().unwrap_or(""),
                offset,
                limit,
                &order,
                &order_direction,
                cursor.as_deref().unwrap_or(""),
            )
            .await?
    };

    if let Ok(bytes) = serde_json::to_vec(&data) {
        state
            .disk_cache
            .put(
                &cache_key,
                &bytes,
                CacheTier::UserContent,
                &["folders", &format!("folder:{}", folder_id)],
            )
            .await
            .ok();
    }

    Ok(data)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn create_playlist_folder(
    state: State<'_, AppState>,
    folder_id: String,
    name: String,
    trns: String,
) -> Result<serde_json::Value, SoneError> {
    log::debug!(
        "[create_playlist_folder]: folder_id={}, name={}, trns={}",
        folder_id,
        name,
        trns
    );
    let result = {
        let client = state.tidal_client.lock().await;
        client
            .create_playlist_folder(&folder_id, &name, &trns)
            .await
    };
    state.disk_cache.invalidate_tag("folders").await;
    result
}

#[tauri::command(rename_all = "camelCase")]
pub async fn rename_playlist_folder(
    state: State<'_, AppState>,
    folder_trn: String,
    name: String,
) -> Result<(), SoneError> {
    log::debug!(
        "[rename_playlist_folder]: folder_trn={}, name={}",
        folder_trn,
        name
    );
    let result = {
        let client = state.tidal_client.lock().await;
        client.rename_playlist_folder(&folder_trn, &name).await
    };
    state.disk_cache.invalidate_tag("folders").await;
    result
}

#[tauri::command(rename_all = "camelCase")]
pub async fn delete_playlist_folder(
    state: State<'_, AppState>,
    folder_trn: String,
) -> Result<(), SoneError> {
    log::debug!("[delete_playlist_folder]: folder_trn={}", folder_trn);
    let result = {
        let client = state.tidal_client.lock().await;
        client.delete_playlist_folder(&folder_trn).await
    };
    state.disk_cache.invalidate_tag("folders").await;
    result
}

#[tauri::command(rename_all = "camelCase")]
pub async fn move_playlist_to_folder(
    state: State<'_, AppState>,
    folder_id: String,
    playlist_trn: String,
) -> Result<(), SoneError> {
    log::debug!(
        "[move_playlist_to_folder]: folder_id={}, playlist_trn={}",
        folder_id,
        playlist_trn
    );
    let result = {
        let client = state.tidal_client.lock().await;
        client
            .move_playlist_to_folder(&folder_id, &playlist_trn)
            .await
    };
    state.disk_cache.invalidate_tag("folders").await;
    result
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_playlist_recommendations(
    state: State<'_, AppState>,
    playlist_id: String,
    offset: u32,
    limit: u32,
) -> Result<PaginatedTracks, SoneError> {
    let mut client = state.tidal_client.lock().await;
    client
        .get_playlist_recommendations(&playlist_id, offset, limit)
        .await
}
