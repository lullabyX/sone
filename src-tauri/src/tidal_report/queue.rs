//! Encrypted, disk-persisted outbox for play-report events that failed to send
//! (offline / transient errors). Stores only the frozen MessageBody — the
//! Headers attribute carries the access token and is rebuilt at send time.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::crypto::Crypto;
use crate::SoneError;

const MAX_ENTRIES: usize = 500;
const MAX_ATTEMPTS: u32 = 10;
const MAX_AGE_SECS: i64 = 14 * 86400;

#[derive(Serialize, Deserialize, Clone)]
struct QueueEntry {
    body: String,
    attempts: u32,
    queued_at: i64,
}

pub struct ReportQueue {
    entries: Mutex<Vec<QueueEntry>>,
    path: PathBuf,
    crypto: Arc<Crypto>,
}

impl ReportQueue {
    pub fn new(path: &Path, crypto: Arc<Crypto>) -> Self {
        let entries = match std::fs::read(path) {
            Ok(data) => crypto
                .decrypt(&data)
                .ok()
                .and_then(|plain| serde_json::from_slice::<Vec<QueueEntry>>(&plain).ok())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        if !entries.is_empty() {
            log::info!("Loaded {} tidal-report queue entries", entries.len());
        }
        Self {
            entries: Mutex::new(entries),
            path: path.to_path_buf(),
            crypto,
        }
    }

    async fn persist(&self) {
        let snapshot = self.entries.lock().await.clone();
        let write = || -> Result<(), SoneError> {
            let json = serde_json::to_vec(&snapshot)?;
            let encrypted = self.crypto.encrypt(&json)?;
            let tmp = self.path.with_extension("bin.tmp");
            std::fs::write(&tmp, &encrypted)?;
            std::fs::rename(&tmp, &self.path)?;
            Ok(())
        };
        if let Err(e) = write() {
            log::warn!("Failed to persist tidal-report queue: {e}");
        }
    }

    pub async fn len(&self) -> usize {
        self.entries.lock().await.len()
    }

    /// Remove and return up to `max` non-expired entries (with attempt counts),
    /// dropping any that exceeded the age/attempt caps.
    pub async fn take_batch(&self, max: usize) -> Vec<(String, u32)> {
        let now = crate::now_secs() as i64;
        let mut entries = self.entries.lock().await;
        entries.retain(|e| e.attempts < MAX_ATTEMPTS && now - e.queued_at <= MAX_AGE_SECS);
        let take = max.min(entries.len());
        let taken: Vec<_> = entries
            .drain(..take)
            .map(|e| (e.body, e.attempts))
            .collect();
        drop(entries);
        if !taken.is_empty() {
            self.persist().await;
        }
        taken
    }

    /// Re-add failed entries with incremented attempt counts.
    pub async fn requeue(&self, items: Vec<(String, u32)>) {
        if items.is_empty() {
            return;
        }
        let now = crate::now_secs() as i64;
        {
            let mut entries = self.entries.lock().await;
            for (body, attempts) in items {
                if attempts + 1 >= MAX_ATTEMPTS {
                    continue;
                }
                entries.push(QueueEntry {
                    body,
                    attempts: attempts + 1,
                    queued_at: now,
                });
            }
            if entries.len() > MAX_ENTRIES {
                let excess = entries.len() - MAX_ENTRIES;
                entries.drain(..excess);
            }
        }
        self.persist().await;
    }

    pub async fn clear(&self) {
        self.entries.lock().await.clear();
        self.persist().await;
    }

    pub async fn flush(&self) {
        self.persist().await;
    }
}
