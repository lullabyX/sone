//! Sonos control: lets SONE act as a controller for Sonos speakers, with the
//! speaker streaming natively (and bit-perfectly) from TIDAL via the
//! household's linked account. See the SMAPI notes in `didl.rs` — SONE only
//! ever sends control commands and TIDAL track IDs; audio and TIDAL
//! credentials never pass through this machine.

pub mod accounts;
pub mod avtransport;
pub mod didl;
pub mod discovery;
pub mod mirror;
pub mod rendering;
pub mod session;
pub mod soap;
pub mod topology;
mod xmlutil;

pub use accounts::{get_tidal_account, TidalAccount, TidalLinkStatus};
pub use avtransport::{PositionInfo, TransportState};
pub use discovery::SonosDevice;
pub use soap::lan_client;
pub use topology::{get_zone_groups, ZoneGroup};

use std::time::Duration;

use crate::error::SoneError;

/// Everything Sonos-related held in `AppState`.
pub struct SonosState {
    /// Dedicated no-proxy client for LAN control traffic.
    pub client: reqwest::Client,
    /// Result of the last discovery sweep (what the picker shows and what
    /// `sonos_connect` resolves group UUIDs against).
    pub groups: std::sync::Mutex<Vec<SonosGroupInfo>>,
    /// Active cast session, if any. The tokio Mutex is held across
    /// connect/disconnect to serialize session swaps (mcp_handle pattern).
    pub session: tokio::sync::Mutex<Option<session::SessionHandle>>,
    /// Mirrored queue tail. The lock ALSO serializes every queue-mutating
    /// SOAP sequence (play_track's clear+enqueue, sync_tail's diff+apply) so
    /// concurrent edits can never interleave on the speaker. Shared with the
    /// session watcher, which consumes entries as the speaker advances.
    pub mirror: std::sync::Arc<tokio::sync::Mutex<mirror::MirrorState>>,
}

impl SonosState {
    pub fn new() -> Self {
        Self {
            client: lan_client(),
            groups: std::sync::Mutex::new(Vec::new()),
            session: tokio::sync::Mutex::new(None),
            mirror: std::sync::Arc::new(tokio::sync::Mutex::new(mirror::MirrorState::default())),
        }
    }
}

impl Default for SonosState {
    fn default() -> Self {
        Self::new()
    }
}

/// A zone group annotated with the household's TIDAL link status — the shape
/// the output picker renders.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SonosGroupInfo {
    #[serde(flatten)]
    pub group: ZoneGroup,
    /// `true`/`false` when the legacy accounts endpoint answered; `null` on
    /// modern firmware where linkage is only observable by trying to enqueue.
    pub tidal_linked: Option<bool>,
    pub tidal_serial: Option<String>,
}

/// Full discovery sweep: SSDP (plus any manual IPs) → topology → TIDAL
/// account check. Any single reachable player yields the whole household's
/// topology, so manual IPs rescue multicast-hostile networks entirely.
pub async fn discover_groups(
    client: &reqwest::Client,
    manual_ips: &[String],
    wait: Duration,
) -> Result<Vec<SonosGroupInfo>, SoneError> {
    let mut candidate_ips = discovery::ssdp_search(wait).await.unwrap_or_else(|e| {
        log::warn!("Sonos SSDP search failed ({e}); falling back to manual IPs");
        Vec::new()
    });
    for ip in manual_ips {
        if !candidate_ips.contains(ip) {
            candidate_ips.push(ip.clone());
        }
    }
    // Multicast responses are firewalled on many desktops; sweep the local
    // /24 for the control port before declaring the household unreachable.
    if candidate_ips.is_empty() {
        candidate_ips = discovery::subnet_sweep().await;
        if !candidate_ips.is_empty() {
            log::info!("Sonos found via subnet sweep: {candidate_ips:?}");
        }
    }

    // First responsive player gives us the household topology + accounts.
    for ip in &candidate_ips {
        // Sweep candidates are just "port 1400 open" — anything from a
        // printer to a NAS can qualify. Only a real Sonos serves the device
        // description; filter before bothering it with SOAP.
        if let Err(e) = discovery::probe_ip(client, ip).await {
            log::debug!("Skipping {ip}: not a Sonos player ({e})");
            continue;
        }
        match get_zone_groups(client, ip).await {
            Ok(groups) => {
                let tidal = get_tidal_account(client, ip).await.unwrap_or_else(|e| {
                    log::warn!("Sonos account check failed on {ip}: {e}");
                    TidalLinkStatus::Unknown
                });
                let (linked, serial) = match tidal {
                    TidalLinkStatus::Linked(acct) => (Some(true), Some(acct.serial)),
                    TidalLinkStatus::NotLinked => (Some(false), None),
                    TidalLinkStatus::Unknown => (None, None),
                };
                let mut infos: Vec<SonosGroupInfo> = groups
                    .into_iter()
                    .map(|group| SonosGroupInfo {
                        group,
                        tidal_linked: linked,
                        tidal_serial: serial.clone(),
                    })
                    .collect();
                infos.sort_by(|a, b| a.group.name.cmp(&b.group.name));
                return Ok(infos);
            }
            Err(e) => log::warn!("Sonos topology query failed on {ip}: {e}"),
        }
    }
    Ok(Vec::new())
}
