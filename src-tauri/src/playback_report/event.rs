use serde_json::{json, Value};

/// Map SONE's quality tiers to the TIDAL event enum (LOW/HIGH/LOSSLESS/HI_RES_LOSSLESS).
/// Avoids `HI_RES` (web/iOS-only; Android omits it) — fold it into HI_RES_LOSSLESS.
pub fn map_quality(q: &str) -> &'static str {
    match q {
        "LOW" => "LOW",
        "HIGH" => "HIGH",
        "LOSSLESS" => "LOSSLESS",
        "HI_RES" | "HI_RES_LOSSLESS" => "HI_RES_LOSSLESS",
        _ => "LOSSLESS",
    }
}

/// Build the PlayLog `playback_session` payload. Timestamps are epoch ms;
/// asset positions are seconds (float). Product ids are strings.
#[allow(clippy::too_many_arguments)]
pub fn build_playback_session_payload(
    session_id: &str,
    product_id: &str,
    quality: &str,
    source_type: Option<&str>,
    source_id: Option<&str>,
    start_ms: i64,
    start_pos: f64,
    end_ms: i64,
    end_pos: f64,
) -> Value {
    json!({
        "playbackSessionId": session_id,
        "startTimestamp": start_ms,
        "startAssetPosition": start_pos,
        "isPostPaywall": true,
        "productType": "TRACK",
        "requestedProductId": product_id,
        "actualProductId": product_id,
        "actualAssetPresentation": "FULL",
        "actualAudioMode": "STEREO",
        "actualQuality": map_quality(quality),
        "sourceType": source_type,
        "sourceId": source_id,
        "actions": [
            { "actionType": "PLAYBACK_START", "timestamp": start_ms, "assetPosition": start_pos },
            { "actionType": "PLAYBACK_STOP",  "timestamp": end_ms,   "assetPosition": end_pos },
        ],
        "endTimestamp": end_ms,
        "endAssetPosition": end_pos,
    })
}

/// The MessageBody envelope: `{group, name, payload, ts, uuid, version}` (stringified).
pub fn build_message_body(name: &str, payload: &Value, ts_ms: i64, uuid: &str) -> String {
    json!({
        "group": "play_log",
        "name": name,
        "payload": payload,
        "version": 2,
        "ts": ts_ms,
        "uuid": uuid,
    })
    .to_string()
}

/// The per-event `Headers` map (stringified). `authorization` is the BARE token (no Bearer).
pub fn build_headers_json(client_id: &str, bare_token: &str, ts_ms: i64) -> String {
    json!({
        "app-name": "TIDAL_ANDROID",
        "app-version": "2.92.0",
        "client-id": client_id,
        "consent-category": "NECESSARY",
        "os-name": "ANDROID",
        "requested-sent-timestamp": ts_ms,
        "authorization": bare_token,
    })
    .to_string()
}

/// Build the SQS SendMessageBatch form pairs for a single event (1-based, no Action/Version).
pub fn build_event_batch_form(
    id: &str,
    name: &str,
    message_body: &str,
    headers_json: &str,
) -> Vec<(String, String)> {
    let e = "SendMessageBatchRequestEntry.1";
    vec![
        (format!("{e}.Id"), id.to_string()),
        (format!("{e}.MessageBody"), message_body.to_string()),
        (format!("{e}.MessageAttribute.1.Name"), "Name".to_string()),
        (format!("{e}.MessageAttribute.1.Value.StringValue"), name.to_string()),
        (format!("{e}.MessageAttribute.1.Value.DataType"), "String".to_string()),
        (format!("{e}.MessageAttribute.2.Name"), "Headers".to_string()),
        (format!("{e}.MessageAttribute.2.Value.StringValue"), headers_json.to_string()),
        (format!("{e}.MessageAttribute.2.Value.DataType"), "String".to_string()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn payload_has_correct_units_and_types() {
        let p = build_playback_session_payload(
            "sess-1", "12345", "LOSSLESS",
            Some("ALBUM"), Some("999"),
            1_000_000, 0.0, 1_195_000, 195.0,
        );
        assert_eq!(p["playbackSessionId"], "sess-1");
        assert_eq!(p["productType"], "TRACK");
        assert_eq!(p["requestedProductId"], "12345");
        assert_eq!(p["actualProductId"], "12345");
        assert_eq!(p["isPostPaywall"], true);
        assert_eq!(p["actualAssetPresentation"], "FULL");
        assert_eq!(p["actualAudioMode"], "STEREO");
        assert_eq!(p["actualQuality"], "LOSSLESS");
        assert_eq!(p["sourceType"], "ALBUM");
        assert_eq!(p["sourceId"], "999");
        assert_eq!(p["startTimestamp"], 1_000_000i64);
        assert_eq!(p["startAssetPosition"], 0.0);
        assert_eq!(p["endTimestamp"], 1_195_000i64);
        assert_eq!(p["endAssetPosition"], 195.0);
        let actions = p["actions"].as_array().unwrap();
        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0]["actionType"], "PLAYBACK_START");
        assert_eq!(actions[0]["assetPosition"], 0.0);
        assert_eq!(actions[1]["actionType"], "PLAYBACK_STOP");
        assert_eq!(actions[1]["assetPosition"], 195.0);
    }

    #[test]
    fn quality_maps_to_valid_enum() {
        assert_eq!(map_quality("HI_RES_LOSSLESS"), "HI_RES_LOSSLESS");
        assert_eq!(map_quality("HI_RES"), "HI_RES_LOSSLESS");
        assert_eq!(map_quality("LOSSLESS"), "LOSSLESS");
        assert_eq!(map_quality("HIGH"), "HIGH");
        assert_eq!(map_quality("LOW"), "LOW");
        assert_eq!(map_quality("garbage"), "LOSSLESS");
    }

    #[test]
    fn sqs_form_has_one_based_entry_and_two_attributes() {
        let pairs = build_event_batch_form("evt-id", "playback_session", "{\"body\":1}", "{\"h\":2}");
        let map: std::collections::HashMap<_, _> = pairs.iter().cloned().collect();
        assert_eq!(map["SendMessageBatchRequestEntry.1.Id"], "evt-id");
        assert_eq!(map["SendMessageBatchRequestEntry.1.MessageBody"], "{\"body\":1}");
        assert_eq!(map["SendMessageBatchRequestEntry.1.MessageAttribute.1.Name"], "Name");
        assert_eq!(map["SendMessageBatchRequestEntry.1.MessageAttribute.1.Value.StringValue"], "playback_session");
        assert_eq!(map["SendMessageBatchRequestEntry.1.MessageAttribute.1.Value.DataType"], "String");
        assert_eq!(map["SendMessageBatchRequestEntry.1.MessageAttribute.2.Name"], "Headers");
        assert_eq!(map["SendMessageBatchRequestEntry.1.MessageAttribute.2.Value.StringValue"], "{\"h\":2}");
        assert_eq!(map["SendMessageBatchRequestEntry.1.MessageAttribute.2.Value.DataType"], "String");
        assert!(!map.contains_key("Action"));
        assert!(!map.contains_key("Version"));
    }

    #[test]
    fn message_body_envelope_shape() {
        let payload = json!({"playbackSessionId": "s"});
        let body = build_message_body("playback_session", &payload, 1234, "uuid-1");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["group"], "play_log");
        assert_eq!(v["name"], "playback_session");
        assert_eq!(v["version"], 2);
        assert_eq!(v["ts"], 1234i64);
        assert_eq!(v["uuid"], "uuid-1");
        assert_eq!(v["payload"]["playbackSessionId"], "s");
    }
}
