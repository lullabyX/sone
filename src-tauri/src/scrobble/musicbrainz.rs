use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

const MB_API_BASE: &str = "https://musicbrainz.org/ws/2";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const MIN_REQUEST_INTERVAL: Duration = Duration::from_millis(1100);

/// Result of an ISRC lookup: the recording MBID plus the artist MBIDs from the
/// matched recording's artist credit (populated only on an artist-corroborated
/// match — see `fetch_mbid`).
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct MbidLookup {
    #[serde(default)]
    pub recording_mbid: Option<String>,
    #[serde(default)]
    pub artist_mbids: Vec<String>,
}

/// Accepts BOTH the legacy cache shape (`String` / `null`) and the new struct so
/// the existing `mbid_cache.json` is not wiped on upgrade. `#[serde(default)]` on
/// `MbidLookup`'s fields is what lets an empty/partial `{}` object parse instead
/// of failing the whole map.
#[derive(Deserialize)]
#[serde(untagged)]
enum CachedValue {
    New(MbidLookup),
    Old(Option<String>),
}

impl From<CachedValue> for MbidLookup {
    fn from(v: CachedValue) -> Self {
        match v {
            CachedValue::New(m) => m,
            CachedValue::Old(recording_mbid) => MbidLookup {
                recording_mbid,
                artist_mbids: Vec::new(),
            },
        }
    }
}

pub struct MusicBrainzLookup {
    client: std::sync::Mutex<reqwest::Client>,
    cache: Mutex<HashMap<String, MbidLookup>>,
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
    /// Returns an empty/default `MbidLookup` (recording_mbid `None`, artist_mbids
    /// empty) on cache miss with no result, or on error.
    pub async fn lookup_isrc(&self, isrc: &str, track_name: &str, artist_name: &str) -> MbidLookup {
        {
            let cache = self.cache.lock().await;
            if let Some(cached) = cache.get(isrc) {
                return cached.clone();
            }
        }

        {
            let mut last = self.last_request.lock().await;
            let elapsed = last.elapsed();
            if elapsed < MIN_REQUEST_INTERVAL {
                tokio::time::sleep(MIN_REQUEST_INTERVAL - elapsed).await;
            }
            *last = Instant::now();
        }

        match self.fetch_mbid(isrc, track_name, artist_name).await {
            Ok(lookup) => {
                let mut cache = self.cache.lock().await;
                cache.insert(isrc.to_string(), lookup.clone());
                self.dirty.store(true, Ordering::Relaxed);
                lookup
            }
            Err(e) => {
                log::debug!("MusicBrainz ISRC lookup failed for {isrc}: {e}");
                MbidLookup::default()
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

    fn load_cache(path: &PathBuf) -> HashMap<String, MbidLookup> {
        match std::fs::read(path) {
            Ok(data) => {
                let raw: HashMap<String, CachedValue> =
                    serde_json::from_slice(&data).unwrap_or_default();
                raw.into_iter().map(|(k, v)| (k, v.into())).collect()
            }
            Err(_) => HashMap::new(),
        }
    }

    async fn fetch_mbid(
        &self,
        isrc: &str,
        track_name: &str,
        artist_name: &str,
    ) -> Result<MbidLookup, String> {
        let url = isrc_lookup_url(isrc);
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
            return Ok(MbidLookup::default());
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
            return Ok(MbidLookup::default());
        }

        Ok(select_lookup(
            &recordings,
            &track_name.to_lowercase(),
            &artist_name.to_lowercase(),
        ))
    }
}

/// Choose the best lookup result from candidate recordings. The trust gate lives
/// here: artist MBIDs are returned ONLY for an artist-corroborated match; every
/// fallback returns a recording MBID (when available) with empty artist MBIDs.
/// Build the MusicBrainz ISRC lookup URL. `inc=artist-credits` is REQUIRED: without
/// it the response omits the artist-credit array, so `recording_matches_artist` can
/// never corroborate and `extract_artist_mbids` always returns empty.
fn isrc_lookup_url(isrc: &str) -> String {
    format!("{MB_API_BASE}/isrc/{isrc}?fmt=json&inc=artist-credits")
}

fn select_lookup(
    recordings: &[serde_json::Value],
    track_lower: &str,
    artist_lower: &str,
) -> MbidLookup {
    let title_matched: Vec<&serde_json::Value> = recordings
        .iter()
        .filter(|r| {
            r.get("title")
                .and_then(|t| t.as_str())
                .map(|t| t.to_lowercase() == track_lower)
                .unwrap_or(false)
        })
        .collect();

    // Artist-corroborated match: trust both recording_mbid AND artist_mbids.
    if let Some(recording) = title_matched
        .iter()
        .find(|r| recording_matches_artist(r, artist_lower))
    {
        return MbidLookup {
            recording_mbid: recording_id(recording),
            artist_mbids: extract_artist_mbids(recording),
        };
    }

    // Title-only fallback: recording_mbid only, NO artist_mbids (uncorroborated).
    if let Some(recording) = title_matched.first() {
        return MbidLookup {
            recording_mbid: recording_id(recording),
            artist_mbids: Vec::new(),
        };
    }

    // Single unambiguous recording: recording_mbid only.
    if recordings.len() == 1 {
        return MbidLookup {
            recording_mbid: recording_id(&recordings[0]),
            artist_mbids: Vec::new(),
        };
    }

    MbidLookup::default()
}

fn recording_id(recording: &serde_json::Value) -> Option<String> {
    recording
        .get("id")
        .and_then(|id| id.as_str())
        .map(|s| s.to_string())
}

fn recording_matches_artist(recording: &serde_json::Value, artist_lower: &str) -> bool {
    recording
        .get("artist-credit")
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
}

/// Collect artist MBIDs from a recording's artist-credit, in order, skipping
/// join-phrase-only entries that carry no `artist.id`.
fn extract_artist_mbids(recording: &serde_json::Value) -> Vec<String> {
    recording
        .get("artist-credit")
        .and_then(|ac| ac.as_array())
        .map(|credits| {
            credits
                .iter()
                .filter_map(|c| {
                    c.get("artist")
                        .and_then(|a| a.get("id"))
                        .and_then(|id| id.as_str())
                        .map(|s| s.to_string())
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn recording(id: &str, credits: serde_json::Value) -> serde_json::Value {
        json!({ "id": id, "title": "Song", "artist-credit": credits })
    }

    #[test]
    fn isrc_lookup_url_requests_artist_credits() {
        // Without inc=artist-credits the MB /isrc response omits artist-credit,
        // so recording_matches_artist always fails and artist_mbids is always
        // empty — the corroboration + artist_mbids features become inert.
        let url = isrc_lookup_url("USLS52081704");
        assert!(url.contains("/isrc/USLS52081704"), "url: {url}");
        assert!(url.contains("fmt=json"), "url: {url}");
        assert!(
            url.contains("inc=artist-credits"),
            "ISRC lookup must request artist-credits or corroboration/artist_mbids break: {url}"
        );
    }

    #[test]
    fn extracts_all_artist_mbids_in_order_skipping_joinphrases() {
        let rec = recording(
            "rec-1",
            json!([
                { "name": "A", "joinphrase": " feat. ", "artist": { "id": "mbid-a", "name": "A" } },
                { "name": "B", "artist": { "id": "mbid-b", "name": "B" } }
            ]),
        );
        assert_eq!(extract_artist_mbids(&rec), vec!["mbid-a", "mbid-b"]);
    }

    #[test]
    fn extract_artist_mbids_skips_credits_without_artist_id() {
        let rec = recording(
            "rec-1",
            json!([
                { "name": "A", "artist": { "name": "A" } },
                { "name": "B", "artist": { "id": "mbid-b", "name": "B" } }
            ]),
        );
        assert_eq!(extract_artist_mbids(&rec), vec!["mbid-b"]);
    }

    #[test]
    fn recording_matches_artist_checks_credit_names() {
        let rec = recording(
            "rec-1",
            json!([{ "name": "Daft Punk", "artist": { "id": "x", "name": "Daft Punk" } }]),
        );
        assert!(recording_matches_artist(&rec, "daft punk"));
        assert!(!recording_matches_artist(&rec, "someone else"));
    }

    #[test]
    fn cache_reads_old_string_and_null_and_new_struct() {
        let old = r#"{"isrc-1":"rec-abc","isrc-2":null}"#;
        let raw: std::collections::HashMap<String, CachedValue> =
            serde_json::from_str(old).unwrap();
        let migrated: std::collections::HashMap<String, MbidLookup> =
            raw.into_iter().map(|(k, v)| (k, v.into())).collect();
        assert_eq!(
            migrated["isrc-1"].recording_mbid.as_deref(),
            Some("rec-abc")
        );
        assert!(migrated["isrc-1"].artist_mbids.is_empty());
        assert_eq!(migrated["isrc-2"].recording_mbid, None);

        let new = r#"{"isrc-3":{"recording_mbid":"r","artist_mbids":["m1"]},"isrc-4":{}}"#;
        let raw: std::collections::HashMap<String, CachedValue> =
            serde_json::from_str(new).unwrap();
        let migrated: std::collections::HashMap<String, MbidLookup> =
            raw.into_iter().map(|(k, v)| (k, v.into())).collect();
        assert_eq!(migrated["isrc-3"].artist_mbids, vec!["m1"]);
        assert_eq!(migrated["isrc-4"].recording_mbid, None);
        assert!(migrated["isrc-4"].artist_mbids.is_empty());
    }

    #[test]
    fn select_lookup_corroborated_match_populates_artist_mbids() {
        let recs = vec![recording(
            "rec-good",
            json!([{ "name": "Daft Punk", "artist": { "id": "mbid-dp", "name": "Daft Punk" } }]),
        )];
        let r = select_lookup(&recs, "song", "daft punk");
        assert_eq!(r.recording_mbid.as_deref(), Some("rec-good"));
        assert_eq!(r.artist_mbids, vec!["mbid-dp"]);
    }

    #[test]
    fn select_lookup_title_only_fallback_has_no_artist_mbids() {
        // Title matches, but artist does NOT — must NOT assert artist identity.
        let recs = vec![
            recording(
                "rec-a",
                json!([{ "name": "Wrong", "artist": { "id": "mbid-x", "name": "Wrong" } }]),
            ),
            recording(
                "rec-b",
                json!([{ "name": "AlsoWrong", "artist": { "id": "mbid-y", "name": "AlsoWrong" } }]),
            ),
        ];
        let r = select_lookup(&recs, "song", "the real artist");
        assert_eq!(r.recording_mbid.as_deref(), Some("rec-a"));
        assert!(r.artist_mbids.is_empty());
    }

    #[test]
    fn select_lookup_single_recording_fallback_has_no_artist_mbids() {
        // Title does NOT match and artist does NOT match, but exactly one recording.
        let recs = vec![recording(
            "rec-solo",
            json!([{ "name": "Wrong", "artist": { "id": "mbid-z", "name": "Wrong" } }]),
        )];
        let r = select_lookup(&recs, "different title", "different artist");
        assert_eq!(r.recording_mbid.as_deref(), Some("rec-solo"));
        assert!(r.artist_mbids.is_empty());
    }

    #[test]
    fn select_lookup_ambiguous_returns_empty() {
        // Multiple recordings, no title match, no artist match → nothing trustworthy.
        let recs = vec![
            recording(
                "rec-a",
                json!([{ "name": "X", "artist": { "id": "1", "name": "X" } }]),
            ),
            recording(
                "rec-b",
                json!([{ "name": "Y", "artist": { "id": "2", "name": "Y" } }]),
            ),
        ];
        let r = select_lookup(&recs, "no match", "no match");
        assert_eq!(r.recording_mbid, None);
        assert!(r.artist_mbids.is_empty());
    }
}
