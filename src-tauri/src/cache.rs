use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

use crate::crypto::Crypto;
use crate::now_secs;

// ---------------------------------------------------------------------------
// CacheTier
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CacheTier {
    /// Playlists, liked tracks, favorites.  TTL: 15 min.
    UserContent,
    /// Artist bios, top charts, home page.  TTL: 4 hours.
    Dynamic,
    /// Album tracklists, credits.           TTL: 7 days.
    StaticMeta,
    /// Album art, avatars.                  TTL: 30 days.
    Image,
}

impl CacheTier {
    pub fn ttl(&self) -> Duration {
        match self {
            CacheTier::UserContent => Duration::from_secs(15 * 60),
            CacheTier::Dynamic => Duration::from_secs(4 * 60 * 60),
            CacheTier::StaticMeta => Duration::from_secs(7 * 24 * 60 * 60),
            CacheTier::Image => Duration::from_secs(30 * 24 * 60 * 60),
        }
    }

    /// How long past TTL we still serve stale data while refreshing.
    pub fn swr_grace(&self) -> Duration {
        match self {
            CacheTier::UserContent => Duration::from_secs(60 * 60),
            CacheTier::Dynamic => Duration::from_secs(24 * 60 * 60),
            CacheTier::StaticMeta => Duration::from_secs(30 * 24 * 60 * 60),
            CacheTier::Image => Duration::from_secs(90 * 24 * 60 * 60),
        }
    }

    fn subdir(&self) -> &'static str {
        match self {
            CacheTier::UserContent => "user",
            CacheTier::Dynamic => "dynamic",
            CacheTier::StaticMeta => "static",
            CacheTier::Image => "images",
        }
    }
}

const ALL_TIERS: [CacheTier; 4] = [
    CacheTier::UserContent,
    CacheTier::Dynamic,
    CacheTier::StaticMeta,
    CacheTier::Image,
];

// ---------------------------------------------------------------------------
// Cache statistics (public API)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub total_entries: usize,
    pub total_disk_mb: f64,
    pub max_disk_mb: f64,
    pub usage_percent: f64,
    pub by_tier: HashMap<String, TierStats>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TierStats {
    pub count: usize,
    pub size_mb: f64,
}

// ---------------------------------------------------------------------------
// CacheResult
// ---------------------------------------------------------------------------

pub enum CacheResult {
    /// Data is within TTL — no refresh needed.
    Fresh(Vec<u8>),
    /// Data is past TTL but within SWR grace — caller should return this AND
    /// trigger a background refresh.
    Stale(Vec<u8>),
    /// Not found or expired beyond SWR grace.
    Miss,
}

// ---------------------------------------------------------------------------
// On-disk metadata per entry
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
struct EntryMeta {
    schema_version: u8,
    tags: Vec<String>,
    tier: CacheTier,
    created_at: u64,
    size: u64,
}

// ---------------------------------------------------------------------------
// In-memory index entry
// ---------------------------------------------------------------------------

struct IndexEntry {
    tier: CacheTier,
    #[allow(dead_code)] // kept for index rebuild from metadata files
    tags: Vec<String>,
    created_at: u64,
    size: u64,
    last_access: u64,
    last_refresh_attempt: Option<u64>,
}

// ---------------------------------------------------------------------------
// Inner state (behind RwLock)
// ---------------------------------------------------------------------------

struct DiskCacheInner {
    /// hash → index entry
    index: HashMap<String, IndexEntry>,
    /// tag → set of hashes
    tag_index: HashMap<String, Vec<String>>,
    /// Monotonic counter for LRU ordering.
    access_counter: u64,
    /// Total bytes of all `.dat` files on disk.
    total_disk_usage: u64,
    /// Keys currently being refreshed (prevents duplicate SWR spawns).
    in_flight: HashSet<String>,
}

impl DiskCacheInner {
    fn new() -> Self {
        Self {
            index: HashMap::new(),
            tag_index: HashMap::new(),
            access_counter: 0,
            total_disk_usage: 0,
            in_flight: HashSet::new(),
        }
    }

    fn add_to_tag_index(&mut self, hash: &str, tags: &[String]) {
        for tag in tags {
            self.tag_index
                .entry(tag.clone())
                .or_default()
                .push(hash.to_string());
        }
    }

    fn remove_from_tag_index(&mut self, hash: &str) {
        // Remove hash from every tag list, clean up empty lists.
        self.tag_index.retain(|_, hashes| {
            hashes.retain(|h| h != hash);
            !hashes.is_empty()
        });
    }

    fn remove_entry(&mut self, hash: &str) -> Option<IndexEntry> {
        if let Some(entry) = self.index.remove(hash) {
            self.total_disk_usage = self.total_disk_usage.saturating_sub(entry.size);
            self.remove_from_tag_index(hash);
            Some(entry)
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------------------
// DiskCache
// ---------------------------------------------------------------------------

const MAX_DISK_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GB
const EVICT_TARGET: u64 = MAX_DISK_BYTES * 9 / 10; // 1.8 GB
const CURRENT_SCHEMA_VERSION: u8 = 3;

pub struct DiskCache {
    base_dir: PathBuf,
    inner: RwLock<DiskCacheInner>,
    crypto: Arc<Crypto>,
}

impl DiskCache {
    /// Create cache and rebuild the in-memory index by scanning disk.
    /// The actual storage lives under `cache_dir/v{CURRENT_SCHEMA_VERSION}/`.
    pub fn new(cache_dir: &Path, crypto: Arc<Crypto>) -> Self {
        let base_dir = cache_dir.join(format!("v{CURRENT_SCHEMA_VERSION}"));

        // Delete old version folders.
        if let Ok(entries) = fs::read_dir(cache_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let name = match path.file_name().and_then(|n| n.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                if name.starts_with('v') && name != format!("v{CURRENT_SCHEMA_VERSION}") {
                    log::info!("[DiskCache] removing old cache folder: {name}");
                    fs::remove_dir_all(&path).ok();
                }
            }
        }

        // Ensure tier subdirs exist.
        for tier in &ALL_TIERS {
            fs::create_dir_all(base_dir.join(tier.subdir())).ok();
        }

        let mut inner = DiskCacheInner::new();
        let now = now_secs();

        // Scan each tier subdir for .meta files and rebuild the index.
        for tier in &ALL_TIERS {
            let dir = base_dir.join(tier.subdir());
            let entries = match fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };

            for entry in entries.flatten() {
                let path = entry.path();
                let name = match path.file_name().and_then(|n| n.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };

                // Only process .meta files
                if !name.ends_with(".meta") {
                    continue;
                }
                let hash = name.trim_end_matches(".meta").to_string();
                let dat_path = dir.join(format!("{}.dat", hash));

                // Read and parse meta
                let meta: EntryMeta = match fs::read_to_string(&path)
                    .ok()
                    .and_then(|s| serde_json::from_str(&s).ok())
                {
                    Some(m) => m,
                    None => {
                        // Corrupt meta — delete both files.
                        fs::remove_file(&path).ok();
                        fs::remove_file(&dat_path).ok();
                        continue;
                    }
                };

                // Check schema version — delete if mismatch.
                if meta.schema_version != CURRENT_SCHEMA_VERSION {
                    log::debug!(
                        "[DiskCache] schema mismatch: {} (expected {}), deleting {}",
                        meta.schema_version,
                        CURRENT_SCHEMA_VERSION,
                        hash
                    );
                    fs::remove_file(&path).ok();
                    fs::remove_file(&dat_path).ok();
                    continue;
                }

                // Check if entry is beyond TTL + SWR grace (fully expired).
                let max_age = meta.tier.ttl().as_secs() + meta.tier.swr_grace().as_secs();
                let age = now.saturating_sub(meta.created_at);
                if age > max_age {
                    fs::remove_file(&path).ok();
                    fs::remove_file(&dat_path).ok();
                    continue;
                }

                // Verify dat file exists
                if !dat_path.exists() {
                    fs::remove_file(&path).ok();
                    continue;
                }

                inner.access_counter += 1;
                inner.total_disk_usage += meta.size;
                inner.add_to_tag_index(&hash, &meta.tags);
                inner.index.insert(
                    hash,
                    IndexEntry {
                        tier: meta.tier,
                        tags: meta.tags,
                        created_at: meta.created_at,
                        size: meta.size,
                        last_access: inner.access_counter,
                        last_refresh_attempt: None,
                    },
                );
            }
        }

        log::info!(
            "[DiskCache] rebuilt index: {} entries, {:.1} MB on disk",
            inner.index.len(),
            inner.total_disk_usage as f64 / (1024.0 * 1024.0)
        );

        Self {
            base_dir,
            inner: RwLock::new(inner),
            crypto,
        }
    }

    /// Look up a cache entry. Returns Fresh / Stale / Miss.
    pub async fn get(&self, key: &str, tier: CacheTier) -> CacheResult {
        let hash = hash_key(key);

        // Read-lock: check index.
        let (created_at, exists) = {
            let inner = self.inner.read().await;
            match inner.index.get(&hash) {
                Some(entry) => (entry.created_at, true),
                None => (0, false),
            }
        };

        if !exists {
            log::debug!("[DiskCache] MISS: {} (tier={:?})", key, tier);
            return CacheResult::Miss;
        }

        // Read data from disk (outside lock) and decrypt.
        let dat_path = self
            .base_dir
            .join(tier.subdir())
            .join(format!("{}.dat", hash));
        let data = match fs::read(&dat_path) {
            Ok(raw) => match self.crypto.decrypt(&raw) {
                Ok(plain) => plain,
                Err(e) => {
                    // Decryption failed (key changed?) — treat as miss, remove corrupt entry.
                    log::warn!("[DiskCache] decrypt failed for {}: {e}", &hash[..12]);
                    self.remove_files(&hash, tier);
                    let mut inner = self.inner.write().await;
                    inner.remove_entry(&hash);
                    return CacheResult::Miss;
                }
            },
            Err(_) => {
                // File gone but index has it — clean up.
                let mut inner = self.inner.write().await;
                inner.remove_entry(&hash);
                return CacheResult::Miss;
            }
        };

        // Update LRU access counter.
        {
            let mut inner = self.inner.write().await;
            inner.access_counter += 1;
            let counter = inner.access_counter;
            if let Some(entry) = inner.index.get_mut(&hash) {
                entry.last_access = counter;
            }
        }

        let age = now_secs().saturating_sub(created_at);
        let ttl = tier.ttl().as_secs();
        let grace = tier.swr_grace().as_secs();

        if age < ttl {
            log::debug!(
                "[DiskCache] HIT (fresh): {} (tier={:?}, age={}s)",
                key,
                tier,
                age
            );
            CacheResult::Fresh(data)
        } else if age < ttl + grace {
            log::debug!(
                "[DiskCache] HIT (stale): {} (tier={:?}, age={}s, refresh needed)",
                key,
                tier,
                age
            );
            CacheResult::Stale(data)
        } else {
            log::debug!(
                "[DiskCache] MISS (expired): {} (tier={:?}, age={}s)",
                key,
                tier,
                age
            );
            // Beyond grace — treat as miss and clean up.
            self.remove_files(&hash, tier);
            let mut inner = self.inner.write().await;
            inner.remove_entry(&hash);
            CacheResult::Miss
        }
    }

    /// Write data to cache. Triggers LRU eviction if over 2 GB.
    pub async fn put(
        &self,
        key: &str,
        data: &[u8],
        tier: CacheTier,
        tags: &[&str],
    ) -> Result<(), std::io::Error> {
        let hash = hash_key(key);
        let size = data.len() as u64;
        let tag_strings: Vec<String> = tags.iter().map(|s| s.to_string()).collect();

        let dir = self.base_dir.join(tier.subdir());
        let dat_path = dir.join(format!("{}.dat", hash));
        let meta_path = dir.join(format!("{}.meta", hash));

        // Encrypt and write data file.
        let encrypted = self
            .crypto
            .encrypt(data)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        fs::write(&dat_path, &encrypted)?;
        let meta = EntryMeta {
            schema_version: CURRENT_SCHEMA_VERSION,
            tags: tag_strings.clone(),
            tier,
            created_at: now_secs(),
            size,
        };
        fs::write(&meta_path, serde_json::to_string(&meta).unwrap_or_default())?;

        // Update index.
        {
            let mut inner = self.inner.write().await;

            // Remove old entry if overwriting.
            if let Some(old) = inner.index.remove(&hash) {
                inner.total_disk_usage = inner.total_disk_usage.saturating_sub(old.size);
                inner.remove_from_tag_index(&hash);
            }

            inner.access_counter += 1;
            let counter = inner.access_counter;
            inner.total_disk_usage += size;
            inner.add_to_tag_index(&hash, &tag_strings);
            inner.index.insert(
                hash,
                IndexEntry {
                    tier,
                    tags: tag_strings,
                    created_at: now_secs(),
                    size,
                    last_access: counter,
                    last_refresh_attempt: None,
                },
            );
        }

        // Evict if over limit.
        self.maybe_evict().await;

        Ok(())
    }

    /// Invalidate all entries matching a given tag.
    pub async fn invalidate_tag(&self, tag: &str) {
        let hashes: Vec<String> = {
            let inner = self.inner.read().await;
            inner.tag_index.get(tag).cloned().unwrap_or_default()
        };

        if hashes.is_empty() {
            return;
        }

        let mut inner = self.inner.write().await;
        for hash in &hashes {
            if let Some(entry) = inner.index.get(hash) {
                let tier = entry.tier;
                self.remove_files(hash, tier);
            }
            inner.remove_entry(hash);
        }
    }

    /// Invalidate a single entry by its plaintext key.
    pub async fn invalidate_key(&self, key: &str) {
        let hash = hash_key(key);
        let mut inner = self.inner.write().await;
        if let Some(entry) = inner.index.get(&hash) {
            let tier = entry.tier;
            self.remove_files(&hash, tier);
        }
        inner.remove_entry(&hash);
    }

    /// Clear the entire cache (e.g. on logout).
    pub async fn clear(&self) {
        let mut inner = self.inner.write().await;
        inner.index.clear();
        inner.tag_index.clear();
        inner.total_disk_usage = 0;
        inner.access_counter = 0;
        inner.in_flight.clear();
        drop(inner);

        // Delete all files in tier subdirs.
        for tier in &ALL_TIERS {
            let dir = self.base_dir.join(tier.subdir());
            if let Ok(entries) = fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    fs::remove_file(entry.path()).ok();
                }
            }
        }
    }

    /// Mark a key as in-flight (being refreshed). Returns `true` if it was
    /// not already in-flight (caller should proceed with refresh).
    pub async fn mark_in_flight(&self, key: &str) -> bool {
        let hash = hash_key(key);
        let mut inner = self.inner.write().await;
        inner.in_flight.insert(hash)
    }

    /// Remove in-flight marker after refresh completes.
    pub async fn clear_in_flight(&self, key: &str) {
        let hash = hash_key(key);
        let mut inner = self.inner.write().await;
        inner.in_flight.remove(&hash);
    }

    /// Check if enough time has passed since last refresh attempt.
    /// Returns true if we should retry (no recent attempt OR >min_interval elapsed).
    pub async fn should_retry_refresh(&self, key: &str, min_interval_secs: u64) -> bool {
        let hash = hash_key(key);
        let inner = self.inner.read().await;

        if let Some(entry) = inner.index.get(&hash) {
            if let Some(last_attempt) = entry.last_refresh_attempt {
                let elapsed = now_secs().saturating_sub(last_attempt);
                elapsed >= min_interval_secs
            } else {
                true // Never attempted
            }
        } else {
            true // Entry doesn't exist
        }
    }

    /// Mark that we're attempting a refresh (updates timestamp).
    pub async fn mark_refresh_attempt(&self, key: &str) {
        let hash = hash_key(key);
        let mut inner = self.inner.write().await;
        if let Some(entry) = inner.index.get_mut(&hash) {
            entry.last_refresh_attempt = Some(now_secs());
        }
    }

    /// Get cache statistics for monitoring/debugging.
    pub async fn stats(&self) -> CacheStats {
        let inner = self.inner.read().await;

        let mut by_tier: HashMap<String, TierStats> = HashMap::new();
        for entry in inner.index.values() {
            let tier_name = format!("{:?}", entry.tier);
            let stats = by_tier.entry(tier_name).or_insert(TierStats {
                count: 0,
                size_mb: 0.0,
            });
            stats.count += 1;
            stats.size_mb += entry.size as f64 / (1024.0 * 1024.0);
        }

        let total_disk_mb = inner.total_disk_usage as f64 / (1024.0 * 1024.0);
        let max_disk_mb = MAX_DISK_BYTES as f64 / (1024.0 * 1024.0);

        CacheStats {
            total_entries: inner.index.len(),
            total_disk_mb,
            max_disk_mb,
            usage_percent: (total_disk_mb / max_disk_mb) * 100.0,
            by_tier,
        }
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    fn remove_files(&self, hash: &str, tier: CacheTier) {
        let dir = self.base_dir.join(tier.subdir());
        fs::remove_file(dir.join(format!("{}.dat", hash))).ok();
        fs::remove_file(dir.join(format!("{}.meta", hash))).ok();
    }

    async fn maybe_evict(&self) {
        let usage = {
            let inner = self.inner.read().await;
            inner.total_disk_usage
        };

        if usage <= MAX_DISK_BYTES {
            return;
        }

        log::info!(
            "[DiskCache] evicting: {:.1} MB > {:.1} MB limit",
            usage as f64 / (1024.0 * 1024.0),
            MAX_DISK_BYTES as f64 / (1024.0 * 1024.0)
        );

        let mut inner = self.inner.write().await;

        // Collect entries sorted by last_access ascending (oldest first).
        let mut entries: Vec<(String, u64, u64, CacheTier)> = inner
            .index
            .iter()
            .map(|(hash, e)| (hash.clone(), e.last_access, e.size, e.tier))
            .collect();
        entries.sort_by_key(|(_, access, _, _)| *access);

        for (hash, _, size, tier) in entries {
            if inner.total_disk_usage <= EVICT_TARGET {
                break;
            }
            self.remove_files(&hash, tier);
            inner.remove_entry(&hash);
            log::debug!(
                "[DiskCache] evicted {} ({} bytes, {:?})",
                &hash[..12],
                size,
                tier
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Key hashing
// ---------------------------------------------------------------------------

fn hash_key(key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    format!("{:x}", hasher.finalize())
}
