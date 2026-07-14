//! Sonos player discovery: SSDP M-SEARCH multicast plus a unicast probe for
//! manually-configured IPs (VLANs / sandboxes where multicast is filtered).

use std::collections::BTreeSet;
use std::net::Ipv4Addr;
use std::time::Duration;

use tokio::net::UdpSocket;
use tokio::time::timeout;

use crate::error::SoneError;
use crate::sonos::soap::SONOS_PORT;
use crate::sonos::xmlutil::first_text;

const SSDP_ADDR: (Ipv4Addr, u16) = (Ipv4Addr::new(239, 255, 255, 250), 1900);
const SSDP_ST: &str = "urn:schemas-upnp-org:device:ZonePlayer:1";

/// A single Sonos player (one box; grouping lives in `topology`).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SonosDevice {
    pub ip: String,
    /// Player UUID, e.g. `RINCON_949F3EC2E15801400` (no `uuid:` prefix).
    pub uuid: String,
    pub room_name: String,
    pub model_name: String,
}

/// Broadcast an SSDP M-SEARCH for ZonePlayers and collect responder IPs
/// until `wait` elapses. Returns a deduplicated set of IPs; callers follow
/// up with [`probe_ip`] for details.
pub async fn ssdp_search(wait: Duration) -> Result<Vec<String>, SoneError> {
    let socket = UdpSocket::bind(("0.0.0.0", 0)).await?;
    socket.set_multicast_ttl_v4(2).ok();

    let msearch = format!(
        "M-SEARCH * HTTP/1.1\r\n\
         HOST: {}:{}\r\n\
         MAN: \"ssdp:discover\"\r\n\
         MX: 2\r\n\
         ST: {SSDP_ST}\r\n\r\n",
        SSDP_ADDR.0, SSDP_ADDR.1
    );
    // Retransmit a couple of times — SSDP is lossy UDP.
    for _ in 0..3 {
        socket
            .send_to(msearch.as_bytes(), SSDP_ADDR)
            .await
            .map_err(|e| SoneError::SonosUnreachable(format!("SSDP send: {e}")))?;
    }

    let mut ips = BTreeSet::new();
    let mut buf = [0u8; 2048];
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match timeout(remaining, socket.recv_from(&mut buf)).await {
            Ok(Ok((n, from))) => {
                let response = String::from_utf8_lossy(&buf[..n]);
                // Only accept ZonePlayer responses; other UPnP gear answers
                // ssdp:all searches but should never answer ours. Be strict.
                if response.to_ascii_lowercase().contains("zoneplayer") {
                    ips.insert(from.ip().to_string());
                }
            }
            Ok(Err(e)) => {
                log::warn!("SSDP recv error: {e}");
                break;
            }
            Err(_) => break, // window elapsed
        }
    }
    Ok(ips.into_iter().collect())
}

/// The IPv4 address of the default-route interface. The UDP "connect" sends
/// no packets — it only asks the kernel which source address it would pick.
fn primary_ipv4() -> Option<Ipv4Addr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("1.1.1.1:80").ok()?;
    match socket.local_addr().ok()? {
        std::net::SocketAddr::V4(addr) => Some(*addr.ip()),
        _ => None,
    }
}

/// Multicast-free fallback: sweep the local /24 for hosts with the Sonos
/// control port open. Firewalls commonly filter multicast responses (SSDP
/// and mDNS alike) while plain unicast TCP works fine — observed in the
/// wild on desktop Linux. ~1s wall clock (64-way parallel, 300ms timeout).
pub async fn subnet_sweep() -> Vec<String> {
    let Some(local) = primary_ipv4() else {
        return Vec::new();
    };
    let [a, b, c, _] = local.octets();
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(64));
    let mut handles = Vec::with_capacity(254);
    for d in 1..=254u8 {
        let ip = Ipv4Addr::new(a, b, c, d);
        if ip == local {
            continue;
        }
        let semaphore = semaphore.clone();
        handles.push(tokio::spawn(async move {
            let _permit = semaphore.acquire().await.ok()?;
            let attempt = tokio::net::TcpStream::connect((ip, SONOS_PORT));
            match timeout(Duration::from_millis(300), attempt).await {
                Ok(Ok(_)) => Some(ip.to_string()),
                _ => None,
            }
        }));
    }
    let mut ips = Vec::new();
    for handle in handles {
        if let Ok(Some(ip)) = handle.await {
            ips.push(ip);
        }
    }
    ips
}

/// Fetch and parse a player's device description. Works over plain unicast
/// HTTP, so it doubles as the "add by IP" path when multicast is blocked.
pub async fn probe_ip(client: &reqwest::Client, ip: &str) -> Result<SonosDevice, SoneError> {
    let url = format!("http://{ip}:{SONOS_PORT}/xml/device_description.xml");
    let xml = client
        .get(&url)
        .send()
        .await
        .map_err(|e| SoneError::SonosUnreachable(format!("{ip}: {e}")))?
        .error_for_status()
        .map_err(|e| SoneError::SonosUnreachable(format!("{ip}: {e}")))?
        .text()
        .await
        .map_err(|e| SoneError::SonosUnreachable(format!("{ip}: {e}")))?;

    let udn = first_text(&xml, "UDN")?
        .ok_or_else(|| SoneError::SonosProtocol(format!("{ip}: no UDN in description")))?;
    let uuid = udn.trim().trim_start_matches("uuid:").to_string();
    let room_name = first_text(&xml, "roomName")?.unwrap_or_default();
    let model_name = first_text(&xml, "modelName")?.unwrap_or_default();
    Ok(SonosDevice {
        ip: ip.to_string(),
        uuid,
        room_name,
        model_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_description_parses() {
        // Trimmed shape of a real device_description.xml.
        let xml = r#"<?xml version="1.0" encoding="utf-8" ?>
        <root xmlns="urn:schemas-upnp-org:device-1-0">
          <device>
            <deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType>
            <friendlyName>192.168.1.23 - Sonos Era 100</friendlyName>
            <modelName>Sonos Era 100</modelName>
            <UDN>uuid:RINCON_949F3EC2E15801400</UDN>
            <roomName>Living Room</roomName>
          </device>
        </root>"#;
        assert_eq!(
            first_text(xml, "UDN")
                .unwrap()
                .unwrap()
                .trim_start_matches("uuid:"),
            "RINCON_949F3EC2E15801400"
        );
        assert_eq!(first_text(xml, "roomName").unwrap().unwrap(), "Living Room");
    }
}
