use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::crypto::Crypto;
use crate::SoneError;

use super::ScrobbleTrack;

const MAX_ENTRIES: usize = 500;
const MAX_ATTEMPTS: u32 = 10;

#[derive(Serialize, Deserialize, Clone)]
struct QueueEntry {
    provider: String,
    track: ScrobbleTrack,
    attempts: u32,
    last_attempt: Option<i64>,
    #[serde(default)]
    queued_at: i64,
}

pub struct ScrobbleQueue {
    entries: Mutex<Vec<QueueEntry>>,
    path: PathBuf,
    crypto: Arc<Crypto>,
}

impl ScrobbleQueue {
    pub fn new(path: &Path, crypto: Arc<Crypto>) -> Self {
        let queue_path = path.to_path_buf();
        let entries = match std::fs::read(&queue_path) {
            Ok(data) => match crypto.decrypt(&data) {
                Ok(plain) => match serde_json::from_slice::<Vec<QueueEntry>>(&plain) {
                    Ok(v) => {
                        log::info!("Loaded {} scrobble queue entries from disk", v.len());
                        v
                    }
                    Err(e) => {
                        log::warn!("Failed to deserialize scrobble queue: {e}");
                        Vec::new()
                    }
                },
                Err(e) => {
                    log::warn!("Failed to decrypt scrobble queue: {e}");
                    Vec::new()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => {
                log::warn!("Failed to read scrobble queue file: {e}");
                Vec::new()
            }
        };

        Self {
            entries: Mutex::new(entries),
            path: queue_path,
            crypto,
        }
    }

    pub async fn persist(&self) -> Result<(), SoneError> {
        let snapshot = self.entries.lock().await.clone();
        let json = serde_json::to_vec(&snapshot)?;
        let encrypted = self.crypto.encrypt(&json)?;
        let tmp_path = self.path.with_extension("bin.tmp");
        std::fs::write(&tmp_path, &encrypted)?;
        std::fs::rename(&tmp_path, &self.path)?;
        Ok(())
    }

    /// Drop all queued scrobbles and persist the now-empty queue. Used on
    /// logout to fully purge pending scrobbles.
    pub async fn clear(&self) {
        {
            let mut entries = self.entries.lock().await;
            entries.clear();
        }
        // Release the entries lock before persist() (which re-locks it).
        if let Err(e) = self.persist().await {
            log::warn!("Failed to persist cleared scrobble queue: {e}");
        }
    }

    pub async fn push(&self, provider: &str, track: ScrobbleTrack) {
        let mut entries = self.entries.lock().await;
        entries.push(QueueEntry {
            provider: provider.to_string(),
            track,
            attempts: 0,
            last_attempt: None,
            queued_at: crate::now_secs() as i64,
        });

        // Cap at MAX_ENTRIES, drop oldest
        if entries.len() > MAX_ENTRIES {
            let excess = entries.len() - MAX_ENTRIES;
            log::warn!("Scrobble queue exceeded {MAX_ENTRIES} entries, dropping {excess} oldest");
            entries.drain(..excess);
        }

        drop(entries);
        if let Err(e) = self.persist().await {
            log::warn!("Failed to persist scrobble queue after push: {e}");
        }
    }

    pub async fn flush(&self) {
        if let Err(e) = self.persist().await {
            log::warn!("Failed to persist scrobble queue on flush: {e}");
        }
    }

    pub async fn len(&self) -> usize {
        self.entries.lock().await.len()
    }

    /// Remove entries for disconnected providers and entries that have exceeded
    /// the maximum retry attempts.
    pub async fn cleanup(&self, connected_providers: &[String]) {
        let now = crate::now_secs() as i64;
        let max_age_secs = 14 * 86400; // 14 days
        let mut entries = self.entries.lock().await;
        let before = entries.len();
        entries.retain(|e| {
            if e.attempts >= MAX_ATTEMPTS {
                return false;
            }
            if e.queued_at > 0 && now - e.queued_at > max_age_secs {
                return false;
            }
            connected_providers.contains(&e.provider)
        });
        let removed = before - entries.len();
        if removed > 0 {
            log::info!("Cleaned up {removed} scrobble queue entries");
            drop(entries);
            if let Err(e) = self.persist().await {
                log::warn!("Failed to persist scrobble queue after cleanup: {e}");
            }
        }
    }

    /// Remove and return all entries for a given provider (with attempt counts).
    pub async fn take_for_provider(&self, provider: &str) -> Vec<(ScrobbleTrack, u32)> {
        let mut entries = self.entries.lock().await;
        let mut taken = Vec::new();
        let mut remaining = Vec::new();
        for entry in entries.drain(..) {
            if entry.provider == provider {
                taken.push((entry.track, entry.attempts));
            } else {
                remaining.push(entry);
            }
        }
        *entries = remaining;

        if !taken.is_empty() {
            drop(entries);
            if let Err(e) = self.persist().await {
                log::warn!("Failed to persist scrobble queue after take: {e}");
            }
        }

        taken
    }

    /// Re-add failed tracks with incremented attempt count.
    pub async fn requeue(&self, provider: &str, tracks: Vec<(ScrobbleTrack, u32)>) {
        if tracks.is_empty() {
            return;
        }
        let now = crate::now_secs() as i64;
        let mut entries = self.entries.lock().await;
        for (track, prev_attempts) in tracks {
            entries.push(QueueEntry {
                provider: provider.to_string(),
                track,
                attempts: prev_attempts + 1,
                last_attempt: Some(now),
                queued_at: now,
            });
        }

        // Cap at MAX_ENTRIES
        if entries.len() > MAX_ENTRIES {
            let excess = entries.len() - MAX_ENTRIES;
            log::warn!(
                "Scrobble queue exceeded {MAX_ENTRIES} entries after requeue, dropping {excess} oldest"
            );
            entries.drain(..excess);
        }

        drop(entries);
        if let Err(e) = self.persist().await {
            log::warn!("Failed to persist scrobble queue after requeue: {e}");
        }
    }
}
