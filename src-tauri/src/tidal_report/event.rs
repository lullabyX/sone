//! `playback_session` event construction.

use base64::Engine;
use serde_json::{json, Value};

pub const EC_URL: &str = "https://ec.tidal.com/api/event-batch";
const APP_NAME: &str = "SONE";
const OS_NAME: &str = "linux";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Max events per SQS SendMessageBatch.
pub const MAX_BATCH: usize = 10;

/// Container the play was started from — the primary Recently-Played attribution.
#[derive(Clone, Copy)]
pub enum SourceType {
    Album,
    Playlist,
    Artist,
    Mix,
}

impl SourceType {
    /// Map SONE's frontend source strings to the TIDAL enum. Unknown → None.
    pub fn from_sone(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "album" => Some(SourceType::Album),
            "playlist" => Some(SourceType::Playlist),
            "artist" => Some(SourceType::Artist),
            "mix" => Some(SourceType::Mix),
            _ => None,
        }
    }
    pub(crate) fn as_tidal(self) -> &'static str {
        match self {
            SourceType::Album => "ALBUM",
            SourceType::Playlist => "PLAYLIST",
            SourceType::Artist => "ARTIST",
            SourceType::Mix => "MIX",
        }
    }
}

/// JWT claims needed to attribute an event to the account.
#[derive(Default, Clone)]
pub struct Claims {
    pub uid: Option<u64>,
    pub cid: Option<u64>,
    pub sid: Option<String>,
}

/// Decode the middle JWT segment (base64url). No signature verification.
pub fn parse_claims(access_token: &str) -> Claims {
    let Some(seg) = access_token.split('.').nth(1) else {
        return Claims::default();
    };
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(seg)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(seg));
    let Ok(bytes) = decoded else {
        return Claims::default();
    };
    let Ok(v) = serde_json::from_slice::<Value>(&bytes) else {
        return Claims::default();
    };
    let as_u64 = |k: &str| match v.get(k) {
        Some(Value::Number(n)) => n.as_u64(),
        Some(Value::String(s)) => s.parse().ok(),
        _ => None,
    };
    Claims {
        uid: as_u64("uid"),
        cid: as_u64("cid"),
        sid: v.get("sid").and_then(|x| x.as_str()).map(String::from),
    }
}

/// The facts needed to build one `playback_session` event.
pub struct SessionEvent {
    pub session_id: String,
    pub requested_product_id: u64,
    pub actual_product_id: String,
    pub quality: String,
    pub audio_mode: String,
    pub presentation: String,
    pub source: Option<(SourceType, String)>,
    pub start_ts_ms: i64,
    pub end_ts_ms: i64,
    pub end_asset_pos: f64,
}

/// Build the MessageBody JSON (mobile shape) for one event.
pub fn build_body(ev: &SessionEvent, claims: &Claims) -> String {
    let (source_type, source_id) = match &ev.source {
        Some((t, id)) => (t.as_tidal().to_string(), id.clone()),
        // Empty strings, never null — null fails server validation.
        None => (String::new(), String::new()),
    };

    let payload = json!({
        "playbackSessionId": ev.session_id,
        "isPostPaywall": true,
        "productType": "TRACK",
        "requestedProductId": ev.requested_product_id.to_string(),
        "actualProductId": ev.actual_product_id,
        "actualAssetPresentation": ev.presentation,
        "actualAudioMode": ev.audio_mode,
        "actualQuality": ev.quality,
        "sourceType": source_type,
        "sourceId": source_id,
        "startTimestamp": ev.start_ts_ms,
        "endTimestamp": ev.end_ts_ms,
        "startAssetPosition": 0.0,
        "endAssetPosition": ev.end_asset_pos,
        "actions": [
            { "actionType": "PLAYBACK_START", "assetPosition": 0.0, "timestamp": ev.start_ts_ms },
            { "actionType": "PLAYBACK_STOP", "assetPosition": ev.end_asset_pos, "timestamp": ev.end_ts_ms },
        ],
    });

    let body = json!({
        "group": "play_log",
        "name": "playback_session",
        "version": 2,
        "ts": ev.end_ts_ms,
        "uuid": uuid::Uuid::new_v4().to_string(),
        // client.token is the `cid` claim as a string (per TIDAL's Android SDK).
        "user": {
            "id": claims.uid,
            "clientId": claims.cid,
            "sessionId": claims.sid,
        },
        "client": {
            "token": claims.cid.map(|c| c.to_string()).unwrap_or_default(),
            "deviceType": "androidAuto",
            "version": APP_VERSION,
            "platform": "android",
        },
        "payload": payload,
    });
    body.to_string()
}

/// The per-event `Headers` MessageAttribute (JSON string).
pub fn build_headers(oauth_client_id: &str, access_token: &str, now_ms: i64) -> String {
    json!({
        "client-id": oauth_client_id,
        "app-name": APP_NAME,
        "app-version": APP_VERSION,
        "os-name": OS_NAME,
        "consent-category": "NECESSARY",
        "requested-sent-timestamp": now_ms.to_string(),
        "authorization": access_token,
    })
    .to_string()
}

/// Encode events as an SQS `SendMessageBatch` form body. `events` is a slice of
/// (body_json, headers_json); at most `MAX_BATCH` per call.
pub fn sqs_form(events: &[(String, String)]) -> Vec<(String, String)> {
    let mut form = Vec::with_capacity(events.len() * 8);
    for (i, (body, headers)) in events.iter().enumerate() {
        let n = i + 1;
        let p = |suffix: &str| format!("SendMessageBatchRequestEntry.{n}.{suffix}");
        form.push((p("Id"), uuid::Uuid::new_v4().to_string()));
        form.push((p("MessageBody"), body.clone()));
        form.push((p("MessageAttribute.1.Name"), "Name".into()));
        form.push((
            p("MessageAttribute.1.Value.StringValue"),
            "playback_session".into(),
        ));
        form.push((p("MessageAttribute.1.Value.DataType"), "String".into()));
        form.push((p("MessageAttribute.2.Name"), "Headers".into()));
        form.push((p("MessageAttribute.2.Value.StringValue"), headers.clone()));
        form.push((p("MessageAttribute.2.Value.DataType"), "String".into()));
    }
    form
}

/// Outcome of a batch POST, from the HTTP status and SQS XML body.
pub enum SendOutcome {
    /// All events accepted.
    Accepted,
    /// Auth rejected — caller should refresh + retry once, then queue.
    AuthFailed,
    /// Transient (5xx/network) — requeue for a later drain.
    Retryable,
    /// Malformed events (SenderFault) — drop permanently, never requeue.
    SenderFault,
}

pub fn classify(status: reqwest::StatusCode, body: &str) -> SendOutcome {
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return SendOutcome::AuthFailed;
    }
    if status.is_server_error() {
        return SendOutcome::Retryable;
    }
    if !status.is_success() {
        // Other 4xx — treat as permanent to avoid retry storms.
        return SendOutcome::SenderFault;
    }
    if body.contains("<BatchResultErrorEntry") {
        SendOutcome::SenderFault
    } else {
        SendOutcome::Accepted
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn sample(source: Option<(SourceType, String)>) -> SessionEvent {
        SessionEvent {
            session_id: "sess-123".into(),
            requested_product_id: 42,
            actual_product_id: "42".into(),
            quality: "LOSSLESS".into(),
            audio_mode: "STEREO".into(),
            presentation: "FULL".into(),
            source,
            start_ts_ms: 1_000,
            end_ts_ms: 201_000,
            end_asset_pos: 200.0,
        }
    }

    fn claims() -> Claims {
        Claims {
            uid: Some(1),
            cid: Some(8017),
            sid: Some("sid-x".into()),
        }
    }

    // The mobile shape (user + client objects) is what surfaces in Recently
    // Played; guard against a regression to the web shape.
    #[test]
    fn body_is_mobile_shape() {
        let v: Value = serde_json::from_str(&build_body(&sample(None), &claims())).unwrap();
        assert_eq!(v["group"], "play_log");
        assert_eq!(v["name"], "playback_session");
        assert_eq!(v["version"], 2);
        assert!(v.get("user").is_some(), "user object required");
        assert!(v.get("client").is_some(), "client object required");
        // client.token is the cid claim as a string.
        assert_eq!(v["client"]["token"], "8017");
        assert_eq!(v["client"]["platform"], "android");
        assert_eq!(v["client"]["deviceType"], "androidAuto");
        assert_eq!(v["user"]["id"], 1);
        assert_eq!(v["client"]["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(v["payload"]["playbackSessionId"], "sess-123");
        assert_eq!(v["payload"]["actions"].as_array().unwrap().len(), 2);
    }

    // Report as SONE-on-Linux, not the TIDAL app (verified to surface the same).
    #[test]
    fn headers_are_honest_identity() {
        let h: Value = serde_json::from_str(&build_headers("cid-x", "tok-y", 123)).unwrap();
        assert_eq!(h["app-name"], "SONE");
        assert_eq!(h["os-name"], "linux");
        assert_eq!(h["app-version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(h["client-id"], "cid-x");
        assert_eq!(h["authorization"], "tok-y");
        assert_eq!(h["consent-category"], "NECESSARY");
    }

    // Absent source must be "" (empty string), never null — null fails validation.
    #[test]
    fn absent_source_is_empty_string_not_null() {
        let v: Value = serde_json::from_str(&build_body(&sample(None), &claims())).unwrap();
        assert_eq!(v["payload"]["sourceType"], "");
        assert_eq!(v["payload"]["sourceId"], "");
    }

    #[test]
    fn container_source_is_mapped() {
        let ev = sample(Some((SourceType::Playlist, "pl-9".into())));
        let v: Value = serde_json::from_str(&build_body(&ev, &claims())).unwrap();
        assert_eq!(v["payload"]["sourceType"], "PLAYLIST");
        assert_eq!(v["payload"]["sourceId"], "pl-9");
    }

    #[test]
    fn source_type_from_sone_strings() {
        assert!(matches!(
            SourceType::from_sone("album"),
            Some(SourceType::Album)
        ));
        assert!(matches!(
            SourceType::from_sone("MIX"),
            Some(SourceType::Mix)
        ));
        assert!(SourceType::from_sone("radio").is_none());
    }

    #[test]
    fn classify_outcomes() {
        use reqwest::StatusCode;
        let ok = "<SendMessageBatchResponse><SendMessageBatchResultEntry><Id>x</Id></SendMessageBatchResultEntry></SendMessageBatchResponse>";
        assert!(matches!(
            classify(StatusCode::OK, ok),
            SendOutcome::Accepted
        ));
        assert!(matches!(
            classify(
                StatusCode::OK,
                "<BatchResultErrorEntry><SenderFault>true</SenderFault></BatchResultErrorEntry>"
            ),
            SendOutcome::SenderFault
        ));
        assert!(matches!(
            classify(StatusCode::UNAUTHORIZED, ""),
            SendOutcome::AuthFailed
        ));
        assert!(matches!(
            classify(StatusCode::INTERNAL_SERVER_ERROR, ""),
            SendOutcome::Retryable
        ));
        assert!(matches!(
            classify(StatusCode::BAD_REQUEST, ""),
            SendOutcome::SenderFault
        ));
    }

    #[test]
    fn parse_claims_reads_uid_cid_sid() {
        // {"uid":173234555,"cid":8017,"sid":"abc"} as base64url, unsigned JWT.
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"uid":173234555,"cid":8017,"sid":"abc"}"#);
        let token = format!("h.{payload}.s");
        let c = parse_claims(&token);
        assert_eq!(c.uid, Some(173234555));
        assert_eq!(c.cid, Some(8017));
        assert_eq!(c.sid.as_deref(), Some("abc"));
    }
}
