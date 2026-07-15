//! TIDAL → Sonos URI and DIDL-Lite construction, following SoCo's
//! `ShareLinkPlugin` (hardware-validated) with noson's `x-sonos-http` form
//! as fallback. Only track IDs are sent; the speaker resolves the media URL
//! itself via SMAPI `getMediaURI` and the Sonos system's linked account.

use crate::sonos::xmlutil::xml_escape;

/// TIDAL's Sonos music-service account "Type" (the `SA_RINCON` magic number).
pub const TIDAL_SERVICE_TYPE: u32 = 44551;

/// TIDAL's Sonos service id (`sid`), empirically `TYPE >> 8`.
pub const TIDAL_SID: u32 = TIDAL_SERVICE_TYPE >> 8;

/// `flags` value observed in Sonos-app captures of TIDAL track URIs.
/// Opaque playability bitfield; only used in the `SonosHttp` fallback form.
pub const TIDAL_TRACK_FLAGS: u32 = 24616;

/// How to construct the `EnqueuedURI` for a TIDAL track.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrackUriStyle {
    /// SoCo sharelink form: the bare encoded item id (`track%2f<id>`).
    /// Works when the Sonos system resolves its (single) linked TIDAL account
    /// from the `<desc>` token alone. Default.
    Bare,
    /// noson / Sonos-app form with explicit service + account serial:
    /// `x-sonos-http:track%2f<id>.flac?sid=174&flags=24616&sn=<serial>`.
    /// Retry with this (serial from `/status/accounts`) if `Bare` faults.
    SonosHttp { account_serial: String },
}

/// Display metadata for the Sonos queue entry. The speaker replaces most of
/// it from SMAPI once it resolves the track, so plain-text fields are enough.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct TrackMeta {
    pub title: String,
    pub artist: String,
    pub album: String,
}

fn encoded_track(track_id: u64) -> String {
    format!("track%2f{track_id}")
}

/// DIDL item id: SoCo's track object-id key + the encoded item.
pub fn track_item_id(track_id: u64) -> String {
    format!("00032020{}", encoded_track(track_id))
}

pub fn track_enqueue_uri(track_id: u64, style: &TrackUriStyle) -> String {
    match style {
        TrackUriStyle::Bare => encoded_track(track_id),
        TrackUriStyle::SonosHttp { account_serial } => format!(
            "x-sonos-http:{}.flac?sid={TIDAL_SID}&flags={TIDAL_TRACK_FLAGS}&sn={}",
            encoded_track(track_id),
            account_serial
        ),
    }
}

/// DIDL-Lite metadata for a TIDAL track queue entry. The `<desc>` token
/// routes the speaker to its linked TIDAL account.
pub fn track_didl(track_id: u64, meta: &TrackMeta) -> String {
    format!(
        "<DIDL-Lite xmlns:dc=\"http://purl.org/dc/elements/1.1/\" \
         xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\" \
         xmlns:r=\"urn:schemas-rinconnetworks-com:metadata-1-0/\" \
         xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\">\
         <item id=\"{id}\" parentID=\"-1\" restricted=\"true\">\
         <dc:title>{title}</dc:title>\
         <dc:creator>{artist}</dc:creator>\
         <upnp:album>{album}</upnp:album>\
         <upnp:class>object.item.audioItem.musicTrack</upnp:class>\
         <desc id=\"cdudn\" nameSpace=\"urn:schemas-rinconnetworks-com:metadata-1-0/\">\
         SA_RINCON{svc}_X_#Svc{svc}-0-Token</desc>\
         </item></DIDL-Lite>",
        id = track_item_id(track_id),
        title = xml_escape(&meta.title),
        artist = xml_escape(&meta.artist),
        album = xml_escape(&meta.album),
        svc = TIDAL_SERVICE_TYPE,
    )
}

/// URI that switches a coordinator's transport to its own native queue.
pub fn queue_uri(coordinator_uuid: &str) -> String {
    format!("x-rincon-queue:{coordinator_uuid}#0")
}

/// Parse a TIDAL track id back out of a Sonos queue/transport URI, in either
/// of the two enqueued forms (`track%2f<id>` bare or `x-sonos-http:...`).
/// Returns `None` for foreign URIs (radio, other services, line-in, ...).
pub fn parse_track_uri(uri: &str) -> Option<u64> {
    let lower = uri.to_ascii_lowercase();
    let (idx, needle_len) = lower
        .find("track%2f")
        .map(|i| (i, "track%2f".len()))
        .or_else(|| lower.find("track/").map(|i| (i, "track/".len())))?;
    let digits: String = uri[idx + needle_len..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> TrackMeta {
        TrackMeta {
            title: "Song & Dance".to_string(),
            artist: "A <Band>".to_string(),
            album: "\"Quotes\"".to_string(),
        }
    }

    #[test]
    fn bare_uri_matches_soco_sharelink() {
        assert_eq!(
            track_enqueue_uri(157273957, &TrackUriStyle::Bare),
            "track%2f157273957"
        );
        assert_eq!(track_item_id(157273957), "00032020track%2f157273957");
    }

    #[test]
    fn sonos_http_uri_matches_app_capture_shape() {
        let style = TrackUriStyle::SonosHttp {
            account_serial: "3".to_string(),
        };
        assert_eq!(
            track_enqueue_uri(12345, &style),
            "x-sonos-http:track%2f12345.flac?sid=174&flags=24616&sn=3"
        );
    }

    #[test]
    fn didl_contains_token_and_escaped_fields() {
        let didl = track_didl(42, &meta());
        assert!(
            didl.contains("<item id=\"00032020track%2f42\" parentID=\"-1\" restricted=\"true\">")
        );
        assert!(didl.contains("SA_RINCON44551_X_#Svc44551-0-Token"));
        assert!(didl.contains("<dc:title>Song &amp; Dance</dc:title>"));
        assert!(didl.contains("<dc:creator>A &lt;Band&gt;</dc:creator>"));
        assert!(didl.contains("<upnp:album>&quot;Quotes&quot;</upnp:album>"));
        assert!(didl.contains("object.item.audioItem.musicTrack"));
    }

    #[test]
    fn queue_uri_format() {
        assert_eq!(
            queue_uri("RINCON_949F3EC2E15801400"),
            "x-rincon-queue:RINCON_949F3EC2E15801400#0"
        );
    }

    #[test]
    fn parse_track_uri_both_styles_and_foreign() {
        assert_eq!(parse_track_uri("track%2f157273957"), Some(157273957));
        assert_eq!(
            parse_track_uri("x-sonos-http:track%2f12345.flac?sid=174&flags=24616&sn=3"),
            Some(12345)
        );
        // Speakers sometimes report the decoded form.
        assert_eq!(
            parse_track_uri("x-sonos-http:track/98765.flac?sid=174"),
            Some(98765)
        );
        assert_eq!(parse_track_uri("x-sonosapi-stream:s12345?sid=254"), None);
        assert_eq!(parse_track_uri("x-rincon-queue:RINCON_1#0"), None);
    }
}
