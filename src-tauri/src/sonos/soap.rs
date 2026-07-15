//! Minimal UPnP SOAP client for Sonos speakers (port 1400). The action set
//! is small and fixed, so envelopes are built by hand instead of pulling in
//! a UPnP stack. Reference: <https://sonos.svrooij.io/>.

use std::collections::BTreeMap;
use std::time::Duration;

use crate::error::SoneError;
use crate::sonos::xmlutil::{child_texts, first_text, xml_escape};

pub const SONOS_PORT: u16 = 1400;

/// One of the UPnP services a Sonos player exposes.
pub struct Service {
    /// Service name inside the URN, e.g. `AVTransport`.
    pub name: &'static str,
    /// HTTP control endpoint path.
    pub control_path: &'static str,
}

impl Service {
    pub fn urn(&self) -> String {
        format!("urn:schemas-upnp-org:service:{}:1", self.name)
    }
}

pub const AV_TRANSPORT: Service = Service {
    name: "AVTransport",
    control_path: "/MediaRenderer/AVTransport/Control",
};

pub const GROUP_RENDERING_CONTROL: Service = Service {
    name: "GroupRenderingControl",
    control_path: "/MediaRenderer/GroupRenderingControl/Control",
};

pub const ZONE_GROUP_TOPOLOGY: Service = Service {
    name: "ZoneGroupTopology",
    control_path: "/ZoneGroupTopology/Control",
};

/// `InstanceID=0` — the only transport instance Sonos exposes; every
/// AVTransport/GroupRenderingControl action takes it.
pub(crate) fn instance_arg() -> (&'static str, String) {
    ("InstanceID", "0".to_string())
}

/// Dedicated HTTP client for Sonos LAN traffic. Deliberately NOT the app's
/// central client: that one routes through the user's configured proxy,
/// which must never apply to `192.168.x.x:1400` control calls.
pub fn lan_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .expect("building plain reqwest client cannot fail")
}

fn build_envelope(service: &Service, action: &str, args: &[(&str, String)]) -> String {
    let mut body = String::new();
    for (k, v) in args {
        body.push_str(&format!("<{k}>{}</{k}>", xml_escape(v)));
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\
         <s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
         s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\
         <s:Body><u:{action} xmlns:u=\"{urn}\">{body}</u:{action}></s:Body></s:Envelope>",
        urn = service.urn(),
    )
}

/// Invoke a SOAP action on a speaker and return the response arguments
/// (direct children of `<u:{action}Response>`) as a name → text map.
pub async fn soap_action(
    client: &reqwest::Client,
    ip: &str,
    service: &Service,
    action: &str,
    args: &[(&str, String)],
) -> Result<BTreeMap<String, String>, SoneError> {
    let url = format!("http://{ip}:{SONOS_PORT}{}", service.control_path);
    let envelope = build_envelope(service, action, args);
    let response = client
        .post(&url)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header("SOAPACTION", format!("\"{}#{action}\"", service.urn()))
        .body(envelope)
        .send()
        .await
        .map_err(|e| SoneError::SonosUnreachable(format!("{ip}: {e}")))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| SoneError::SonosUnreachable(format!("{ip}: {e}")))?;

    if !status.is_success() {
        // UPnP faults come back as HTTP 500 with an <errorCode> in the body.
        if let Ok(Some(code)) = first_text(&text, "errorCode") {
            if let Ok(code) = code.trim().parse::<u32>() {
                return Err(SoneError::SonosUpnp {
                    code,
                    context: action.to_string(),
                });
            }
        }
        return Err(SoneError::SonosProtocol(format!(
            "{action} failed with HTTP {status}"
        )));
    }

    child_texts(&text, &format!("{action}Response"))
}

/// Parse Sonos `H:MM:SS` (or `NOT_IMPLEMENTED`) time strings into seconds.
pub fn parse_hms(s: &str) -> Option<f64> {
    let mut parts = s.split(':');
    let h: f64 = parts.next()?.trim().parse().ok()?;
    let m: f64 = parts.next()?.trim().parse().ok()?;
    let sec: f64 = parts.next()?.trim().parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(h * 3600.0 + m * 60.0 + sec)
}

/// Format seconds as the `H:MM:SS` string Sonos expects for REL_TIME seeks.
pub fn format_hms(secs: f64) -> String {
    let total = secs.max(0.0).round() as u64;
    format!(
        "{}:{:02}:{:02}",
        total / 3600,
        (total % 3600) / 60,
        total % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_is_wellformed_and_escaped() {
        let env = build_envelope(
            &AV_TRANSPORT,
            "SetAVTransportURI",
            &[
                ("InstanceID", "0".to_string()),
                ("CurrentURI", "x-rincon-queue:RINCON_1#0".to_string()),
                ("CurrentURIMetaData", "<DIDL-Lite a=\"b\"/>".to_string()),
            ],
        );
        assert!(env.starts_with("<?xml version=\"1.0\" encoding=\"utf-8\"?>"));
        assert!(env.contains(
            "<u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">"
        ));
        // Metadata must arrive XML-escaped inside the envelope.
        assert!(env.contains(
            "<CurrentURIMetaData>&lt;DIDL-Lite a=&quot;b&quot;/&gt;</CurrentURIMetaData>"
        ));
    }

    #[test]
    fn hms_roundtrip() {
        assert_eq!(parse_hms("0:03:21"), Some(201.0));
        assert_eq!(parse_hms("1:00:07"), Some(3607.0));
        assert_eq!(parse_hms("NOT_IMPLEMENTED"), None);
        assert_eq!(format_hms(201.0), "0:03:21");
        assert_eq!(format_hms(3607.4), "1:00:07");
        assert_eq!(format_hms(-5.0), "0:00:00");
    }
}
