//! ALSA device reservation (`org.freedesktop.ReserveDevice1`).
//!
//! PipeWire (via WirePlumber), PulseAudio and JACK coordinate who owns a sound
//! card through this D-Bus protocol. Exclusive mode used to open the PCM behind
//! the sound server's back: its node then failed with EBUSY, and WirePlumber
//! does not recreate a node that failed that way, so the card stayed missing
//! from the desktop until PipeWire/WirePlumber were restarted — even after SONE
//! had closed the device or exited.
//!
//! Holding the reservation instead makes WirePlumber release the card cleanly
//! and take it back as soon as the reservation is dropped. The bus also drops
//! the name if SONE exits or crashes, so the card is handed back either way.
//!
//! Reservation is best effort. With no session bus, no sound server holding the
//! card, or a sandbox that won't let us own the name (Flatpak without
//! `--own-name=org.freedesktop.ReserveDevice1.*`), `acquire` returns `None` and
//! the caller opens the device exactly as it did before.

use std::path::Path;
use std::time::Duration;

use zbus::blocking::{connection, Connection};
use zbus::fdo::{RequestNameFlags, RequestNameReply};

const INTERFACE: &str = "org.freedesktop.ReserveDevice1";

/// Our claim on the device. Above PulseAudio (0) and WirePlumber (-20), below
/// JACK (`i32::MAX`); it only matters to requesters that compare priorities,
/// since we refuse every release request while holding the card anyway.
const PRIORITY: i32 = 10;

/// How long the current owner gets to answer `RequestRelease`. Matches the
/// reference implementation (`reserve.c`).
const RELEASE_TIMEOUT: Duration = Duration::from_secs(5);

/// A held reservation. Dropping it hands the card back.
pub struct DeviceReservation {
    conn: Connection,
    name: String,
}

impl DeviceReservation {
    /// Reserve the card behind an ALSA device string (`hw:2,0`,
    /// `hw:CARD=Audio,DEV=0`, …), asking the current owner to release it.
    pub fn acquire(device: &str) -> Option<Self> {
        let card = card_index(device)?;
        match Self::try_acquire(card, device) {
            Ok(r) => {
                log::info!("[reserve] acquired {}", r.name);
                Some(r)
            }
            Err(e) => {
                log::warn!("[reserve] could not reserve Audio{card} for {device}: {e}");
                None
            }
        }
    }

    fn try_acquire(card: i32, device: &str) -> Result<Self, String> {
        let name = format!("{INTERFACE}.Audio{card}");
        let path = format!("/org/freedesktop/ReserveDevice1/Audio{card}");

        // Serve the object before owning the name, so a peer that sees the name
        // never finds it without the interface behind it. It must be registered
        // through the builder: zbus runs on tokio here (ksni enables the
        // feature), and `Connection::object_server()` would spawn its task
        // outside a runtime and panic on this non-tokio thread.
        let device_obj = ReservedDevice {
            device: device.to_string(),
        };
        let conn = connection::Builder::session()
            .and_then(|b| b.serve_at(path.as_str(), device_obj))
            .and_then(|b| b.method_timeout(RELEASE_TIMEOUT).build())
            .map_err(|e| format!("session bus: {e}"))?;

        // zbus reports the bus's EXISTS reply as `Error::NameTaken`.
        let taken = match conn
            .request_name_with_flags(name.as_str(), RequestNameFlags::DoNotQueue.into())
        {
            Ok(reply) => reply != RequestNameReply::PrimaryOwner,
            Err(zbus::Error::NameTaken) => true,
            Err(e) => return Err(format!("RequestName: {e}")),
        };
        if taken {
            // Someone holds the card — normally WirePlumber. Ask it to let go;
            // it closes the device before replying true.
            let released: bool = conn
                .call_method(
                    Some(name.as_str()),
                    path.as_str(),
                    Some(INTERFACE),
                    "RequestRelease",
                    &(PRIORITY,),
                )
                .and_then(|reply| reply.body().deserialize())
                .map_err(|e| format!("RequestRelease: {e}"))?;
            if !released {
                return Err("current owner refused to release the device".into());
            }
            match conn.request_name_with_flags(
                name.as_str(),
                RequestNameFlags::DoNotQueue | RequestNameFlags::ReplaceExisting,
            ) {
                Ok(RequestNameReply::PrimaryOwner) => {}
                Ok(_) | Err(zbus::Error::NameTaken) => {
                    return Err("still owned by another client after it agreed to release".into())
                }
                Err(e) => return Err(format!("RequestName: {e}")),
            }
        }

        Ok(Self { conn, name })
    }
}

impl Drop for DeviceReservation {
    fn drop(&mut self) {
        match self.conn.release_name(self.name.as_str()) {
            Ok(_) => log::info!("[reserve] released {}", self.name),
            Err(e) => log::warn!("[reserve] release {}: {e}", self.name),
        }
    }
}

/// The object a reservation owner exports, so others can ask for the card.
struct ReservedDevice {
    device: String,
}

#[zbus::interface(name = "org.freedesktop.ReserveDevice1")]
impl ReservedDevice {
    /// Playback holds the card until the user stops it or leaves exclusive
    /// mode; we don't yield it mid-track.
    fn request_release(&self, priority: i32) -> bool {
        log::info!(
            "[reserve] refusing release request (priority {priority}) for {}",
            self.device
        );
        false
    }

    #[zbus(property)]
    fn priority(&self) -> i32 {
        PRIORITY
    }

    #[zbus(property)]
    fn application_name(&self) -> String {
        "SONE".to_string()
    }

    #[zbus(property)]
    fn application_device_name(&self) -> String {
        self.device.clone()
    }
}

/// ALSA card index for a device string. Card ids resolve through their
/// `/proc/asound/<id> -> cardN` symlink, which needs no access to the device.
fn card_index(device: &str) -> Option<i32> {
    let spec = card_spec(device)?;
    if let Ok(index) = spec.parse() {
        return Some(index);
    }
    let target = std::fs::read_link(Path::new("/proc/asound").join(spec))
        .map_err(|e| log::debug!("[reserve] no ALSA card for {device}: {e}"))
        .ok()?;
    target.to_str()?.strip_prefix("card")?.parse().ok()
}

/// The card part of `<plugin>:<card>[,<dev>]` or `<plugin>:CARD=<id>[,DEV=<n>]`.
fn card_spec(device: &str) -> Option<&str> {
    let body = device.split_once(':')?.1;
    let body = body.strip_prefix("CARD=").unwrap_or(body);
    let spec = &body[..body.find(',').unwrap_or(body.len())];
    (!spec.is_empty()).then_some(spec)
}

#[cfg(test)]
mod tests {
    use super::{card_index, card_spec};

    #[test]
    fn card_spec_handles_index_and_id_forms() {
        assert_eq!(card_spec("hw:2,0"), Some("2"));
        assert_eq!(card_spec("hw:2"), Some("2"));
        assert_eq!(card_spec("plughw:1,3"), Some("1"));
        assert_eq!(card_spec("hw:CARD=Audio,DEV=0"), Some("Audio"));
        assert_eq!(card_spec("hw:CARD=Audio"), Some("Audio"));
    }

    #[test]
    fn card_spec_rejects_devices_without_a_card() {
        assert_eq!(card_spec("default"), None);
        assert_eq!(card_spec("hw:"), None);
        assert_eq!(card_spec("hw:CARD=,DEV=0"), None);
    }

    #[test]
    fn card_index_takes_numeric_cards_as_is_and_rejects_unknown_ids() {
        assert_eq!(card_index("hw:3,0"), Some(3));
        assert_eq!(card_index("hw:CARD=NoSuchSoneTestCard,DEV=0"), None);
        assert_eq!(card_index("default"), None);
    }
}
