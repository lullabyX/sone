use tauri::State;

use crate::cache::{CacheResult, CacheTier};
use crate::error::SoneError;
use crate::tidal_api::FeedResponse;
use crate::AppState;

/// Cache key prefix for the activity feed. Scoped per user, matching the
/// convention of every other user-scoped cache in this codebase
/// (`user-playlists:{id}`, `fav-albums:{id}`, …) — logging out does not purge
/// the disk cache, so an undiscriminated key would serve the previous
/// account's feed and unread count after an account switch.
const FEED_CACHE_TAG: &str = "feed";

fn feed_cache_key(user_id: u64) -> String {
    format!("feed:activities:{}", user_id)
}

/// Fetch the activity feed.
///
/// Uses a plain TTL cache rather than the stale-while-revalidate pattern in
/// `get_page_section`: a background refresh would race the optimistic badge
/// zeroing in `mark_feed_seen` and resurrect the unread dot. At a 15-minute
/// `UserContent` TTL on a handful of rows, SWR buys nothing.
#[tauri::command(rename_all = "camelCase")]
pub async fn get_feed(state: State<'_, AppState>, user_id: u64) -> Result<FeedResponse, SoneError> {
    log::debug!("[get_feed] user_id={}", user_id);

    let cache_key = feed_cache_key(user_id);
    if let CacheResult::Fresh(bytes) = state
        .disk_cache
        .get(&cache_key, CacheTier::UserContent)
        .await
    {
        if let Ok(feed) = serde_json::from_slice::<FeedResponse>(&bytes) {
            return Ok(feed);
        }
    }

    let mut client = state.tidal_client.lock().await;
    let feed = client.fetch_feed(user_id).await?;
    drop(client);

    if let Ok(json) = serde_json::to_vec(&feed) {
        state
            .disk_cache
            .put(&cache_key, &json, CacheTier::UserContent, &[FEED_CACHE_TAG])
            .await
            .ok();
    }

    Ok(feed)
}
