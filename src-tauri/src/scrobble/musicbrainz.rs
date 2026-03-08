use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

const MB_API_BASE: &str = "https://musicbrainz.org/ws/2";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const MIN_REQUEST_INTERVAL: Duration = Duration::from_millis(1100);

pub struct MusicBrainzLookup {
    client: std::sync::Mutex<reqwest::Client>,
    cache: Mutex<HashMap<String, Option<String>>>,
    cache_path: PathBuf,
    last_request: Mutex<Instant>,
    dirty: AtomicBool,
}

impl MusicBrainzLookup {
    pub fn new(config_dir: &std::path::Path, http_client: reqwest::Client) -> Self {
        let cache_path = config_dir.join("mbid_cache.json");
        let cache = Self::load_cache(&cache_path);

        Self {
            client: std::sync::Mutex::new(http_client),
            cache: Mutex::new(cache),
            cache_path,
            last_request: Mutex::new(Instant::now() - MIN_REQUEST_INTERVAL),
            dirty: AtomicBool::new(false),
        }
    }

    /// Replace the internal HTTP client (e.g. when proxy settings change).
    pub fn set_http_client(&self, client: reqwest::Client) {
        *self.client.lock().unwrap() = client;
    }

    /// Look up a recording MBID from an ISRC code.
    /// Uses title + artist to filter ambiguous results.
    /// Returns None on cache miss with no network result, or on error.
    pub async fn lookup_isrc(
        &self,
        isrc: &str,
        track_name: &str,
        artist_name: &str,
    ) -> Option<String> {
        // Check cache first
        {
            let cache = self.cache.lock().await;
            if let Some(cached) = cache.get(isrc) {
                return cached.clone();
            }
        }

        // Rate limit
        {
            let mut last = self.last_request.lock().await;
            let elapsed = last.elapsed();
            if elapsed < MIN_REQUEST_INTERVAL {
                tokio::time::sleep(MIN_REQUEST_INTERVAL - elapsed).await;
            }
            *last = Instant::now();
        }

        let result = self.fetch_mbid(isrc, track_name, artist_name).await;

        match result {
            Ok(mbid) => {
                let mut cache = self.cache.lock().await;
                cache.insert(isrc.to_string(), mbid.clone());
                self.dirty.store(true, Ordering::Relaxed);
                mbid
            }
            Err(e) => {
                // Don't cache network errors — allow retry next time
                log::debug!("MusicBrainz ISRC lookup failed for {isrc}: {e}");
                None
            }
        }
    }

    /// Persist the cache to disk if dirty. Call periodically or on shutdown.
    pub async fn persist(&self) {
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return;
        }

        let cache = self.cache.lock().await;
        let json = match serde_json::to_vec_pretty(&*cache) {
            Ok(j) => j,
            Err(e) => {
                log::warn!("Failed to serialize MBID cache: {e}");
                return;
            }
        };
        drop(cache);

        // Atomic write: tmp then rename
        let tmp = self.cache_path.with_extension("tmp");
        if let Err(e) = std::fs::write(&tmp, &json) {
            log::warn!("Failed to write MBID cache tmp: {e}");
            return;
        }
        if let Err(e) = std::fs::rename(&tmp, &self.cache_path) {
            log::warn!("Failed to rename MBID cache: {e}");
        }
    }

    // -----------------------------------------------------------------------
    // Private
    // -----------------------------------------------------------------------

    fn load_cache(path: &PathBuf) -> HashMap<String, Option<String>> {
        match std::fs::read(path) {
            Ok(data) => serde_json::from_slice(&data).unwrap_or_default(),
            Err(_) => HashMap::new(),
        }
    }

    async fn fetch_mbid(
        &self,
        isrc: &str,
        track_name: &str,
        artist_name: &str,
    ) -> Result<Option<String>, String> {
        let url = format!("{MB_API_BASE}/isrc/{isrc}?fmt=json");

        let user_agent = format!("SONE/{APP_VERSION} (https://github.com/lullabyX/sone)");
        let client = self.client.lock().unwrap().clone();
        let resp = client
            .get(&url)
            .header(reqwest::header::USER_AGENT, &user_agent)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;

        let status = resp.status();
        if status.as_u16() == 404 {
            // ISRC not found in MusicBrainz — cache as None
            return Ok(None);
        }
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("parse failed: {e}"))?;

        let recordings = body
            .get("recordings")
            .and_then(|r| r.as_array())
            .cloned()
            .unwrap_or_default();

        if recordings.is_empty() {
            return Ok(None);
        }

        // Filter by case-insensitive title match
        let track_lower = track_name.to_lowercase();
        let artist_lower = artist_name.to_lowercase();

        let title_matched: Vec<&serde_json::Value> = recordings
            .iter()
            .filter(|r| {
                r.get("title")
                    .and_then(|t| t.as_str())
                    .map(|t| t.to_lowercase() == track_lower)
                    .unwrap_or(false)
            })
            .collect();

        // Try title + artist match first
        let best = title_matched.iter().find(|r| {
            r.get("artist-credit")
                .and_then(|ac| ac.as_array())
                .map(|credits| {
                    credits.iter().any(|c| {
                        c.get("name")
                            .or_else(|| c.get("artist").and_then(|a| a.get("name")))
                            .and_then(|n| n.as_str())
                            .map(|n| n.to_lowercase() == artist_lower)
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
        });

        if let Some(recording) = best {
            return Ok(recording
                .get("id")
                .and_then(|id| id.as_str())
                .map(|s| s.to_string()));
        }

        // Fall back to first title match
        if let Some(recording) = title_matched.first() {
            return Ok(recording
                .get("id")
                .and_then(|id| id.as_str())
                .map(|s| s.to_string()));
        }

        // Last resort: take first only if there's exactly one recording
        if recordings.len() == 1 {
            return Ok(recordings[0]
                .get("id")
                .and_then(|id| id.as_str())
                .map(|s| s.to_string()));
        }

        // Multiple ambiguous results — return None
        Ok(None)
    }
}
