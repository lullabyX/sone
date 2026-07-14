//! Typed wrappers over the AVTransport actions we use. All calls must
//! target the group coordinator's IP (see `topology`).

use std::collections::BTreeMap;

use crate::error::SoneError;
use crate::sonos::soap::{format_hms, parse_hms, soap_action, AV_TRANSPORT};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TransportState {
    Playing,
    PausedPlayback,
    Stopped,
    Transitioning,
    Other,
}

impl TransportState {
    pub fn from_sonos(s: &str) -> Self {
        match s {
            "PLAYING" => Self::Playing,
            "PAUSED_PLAYBACK" => Self::PausedPlayback,
            "STOPPED" => Self::Stopped,
            "TRANSITIONING" => Self::Transitioning,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionInfo {
    /// 1-based queue position; 0 when nothing is loaded.
    pub track_nr: u32,
    pub position_secs: Option<f64>,
    pub duration_secs: Option<f64>,
    pub track_uri: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddToQueueResult {
    pub first_track_nr: u32,
    pub num_added: u32,
    pub queue_length: u32,
}

const INSTANCE: (&str, &str) = ("InstanceID", "0");

fn instance_arg() -> (&'static str, String) {
    (INSTANCE.0, INSTANCE.1.to_string())
}

async fn simple(client: &reqwest::Client, ip: &str, action: &str) -> Result<(), SoneError> {
    soap_action(client, ip, &AV_TRANSPORT, action, &[instance_arg()]).await?;
    Ok(())
}

pub async fn set_av_transport_uri(
    client: &reqwest::Client,
    ip: &str,
    uri: &str,
    metadata: &str,
) -> Result<(), SoneError> {
    soap_action(
        client,
        ip,
        &AV_TRANSPORT,
        "SetAVTransportURI",
        &[
            instance_arg(),
            ("CurrentURI", uri.to_string()),
            ("CurrentURIMetaData", metadata.to_string()),
        ],
    )
    .await?;
    Ok(())
}

pub async fn add_uri_to_queue(
    client: &reqwest::Client,
    ip: &str,
    uri: &str,
    metadata: &str,
    desired_first_track: u32,
    enqueue_as_next: bool,
) -> Result<AddToQueueResult, SoneError> {
    let response = soap_action(
        client,
        ip,
        &AV_TRANSPORT,
        "AddURIToQueue",
        &[
            instance_arg(),
            ("EnqueuedURI", uri.to_string()),
            ("EnqueuedURIMetaData", metadata.to_string()),
            (
                "DesiredFirstTrackNumberEnqueued",
                desired_first_track.to_string(),
            ),
            ("EnqueueAsNext", u32::from(enqueue_as_next).to_string()),
        ],
    )
    .await?;
    let get = |key: &str| -> u32 {
        response
            .get(key)
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0)
    };
    Ok(AddToQueueResult {
        first_track_nr: get("FirstTrackNumberEnqueued"),
        num_added: get("NumTracksAdded"),
        queue_length: get("NewQueueLength"),
    })
}

pub async fn remove_all_tracks_from_queue(
    client: &reqwest::Client,
    ip: &str,
) -> Result<(), SoneError> {
    simple(client, ip, "RemoveAllTracksFromQueue").await
}

/// Remove a single queue entry by its 1-based position.
pub async fn remove_track_from_queue(
    client: &reqwest::Client,
    ip: &str,
    track_nr: u32,
) -> Result<(), SoneError> {
    soap_action(
        client,
        ip,
        &AV_TRANSPORT,
        "RemoveTrackFromQueue",
        &[
            instance_arg(),
            ("ObjectID", format!("Q:0/{track_nr}")),
            ("UpdateID", "0".to_string()),
        ],
    )
    .await?;
    Ok(())
}

pub async fn play(client: &reqwest::Client, ip: &str) -> Result<(), SoneError> {
    soap_action(
        client,
        ip,
        &AV_TRANSPORT,
        "Play",
        &[instance_arg(), ("Speed", "1".to_string())],
    )
    .await?;
    Ok(())
}

pub async fn pause(client: &reqwest::Client, ip: &str) -> Result<(), SoneError> {
    simple(client, ip, "Pause").await
}

pub async fn stop(client: &reqwest::Client, ip: &str) -> Result<(), SoneError> {
    simple(client, ip, "Stop").await
}

pub async fn next(client: &reqwest::Client, ip: &str) -> Result<(), SoneError> {
    simple(client, ip, "Next").await
}

pub async fn previous(client: &reqwest::Client, ip: &str) -> Result<(), SoneError> {
    simple(client, ip, "Previous").await
}

pub async fn seek_rel_time(
    client: &reqwest::Client,
    ip: &str,
    position_secs: f64,
) -> Result<(), SoneError> {
    soap_action(
        client,
        ip,
        &AV_TRANSPORT,
        "Seek",
        &[
            instance_arg(),
            ("Unit", "REL_TIME".to_string()),
            ("Target", format_hms(position_secs)),
        ],
    )
    .await?;
    Ok(())
}

pub async fn seek_track_nr(
    client: &reqwest::Client,
    ip: &str,
    track_nr: u32,
) -> Result<(), SoneError> {
    soap_action(
        client,
        ip,
        &AV_TRANSPORT,
        "Seek",
        &[
            instance_arg(),
            ("Unit", "TRACK_NR".to_string()),
            ("Target", track_nr.to_string()),
        ],
    )
    .await?;
    Ok(())
}

/// `NORMAL`, `REPEAT_ALL`, `REPEAT_ONE`, `SHUFFLE`, `SHUFFLE_NOREPEAT`, ...
/// SONE always sets `NORMAL`: play order is pre-materialized on our side.
pub async fn set_play_mode(
    client: &reqwest::Client,
    ip: &str,
    mode: &str,
) -> Result<(), SoneError> {
    soap_action(
        client,
        ip,
        &AV_TRANSPORT,
        "SetPlayMode",
        &[instance_arg(), ("NewPlayMode", mode.to_string())],
    )
    .await?;
    Ok(())
}

pub async fn get_transport_state(
    client: &reqwest::Client,
    ip: &str,
) -> Result<TransportState, SoneError> {
    let response = soap_action(
        client,
        ip,
        &AV_TRANSPORT,
        "GetTransportInfo",
        &[instance_arg()],
    )
    .await?;
    Ok(TransportState::from_sonos(
        response
            .get("CurrentTransportState")
            .map(String::as_str)
            .unwrap_or(""),
    ))
}

pub fn position_from_response(response: &BTreeMap<String, String>) -> PositionInfo {
    PositionInfo {
        track_nr: response
            .get("Track")
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0),
        position_secs: response.get("RelTime").and_then(|v| parse_hms(v)),
        duration_secs: response.get("TrackDuration").and_then(|v| parse_hms(v)),
        track_uri: response.get("TrackURI").cloned().unwrap_or_default(),
    }
}

pub async fn get_position_info(
    client: &reqwest::Client,
    ip: &str,
) -> Result<PositionInfo, SoneError> {
    let response = soap_action(
        client,
        ip,
        &AV_TRANSPORT,
        "GetPositionInfo",
        &[instance_arg()],
    )
    .await?;
    Ok(position_from_response(&response))
}

#[derive(Debug, Clone)]
pub struct MediaInfo {
    /// The AVTransport URI currently loaded (e.g. `x-rincon-queue:RINCON_x#0`,
    /// a radio stream, or empty). Used to detect external takeover.
    pub current_uri: String,
    /// Number of entries in the loaded queue.
    pub nr_tracks: u32,
}

pub async fn get_media_info(client: &reqwest::Client, ip: &str) -> Result<MediaInfo, SoneError> {
    let response =
        soap_action(client, ip, &AV_TRANSPORT, "GetMediaInfo", &[instance_arg()]).await?;
    Ok(MediaInfo {
        current_uri: response.get("CurrentURI").cloned().unwrap_or_default(),
        nr_tracks: response
            .get("NrTracks")
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0),
    })
}

pub async fn get_media_uri(client: &reqwest::Client, ip: &str) -> Result<String, SoneError> {
    Ok(get_media_info(client, ip).await?.current_uri)
}

/// Remove `count` queue entries starting at 1-based `starting_index`.
pub async fn remove_track_range_from_queue(
    client: &reqwest::Client,
    ip: &str,
    starting_index: u32,
    count: u32,
) -> Result<(), SoneError> {
    soap_action(
        client,
        ip,
        &AV_TRANSPORT,
        "RemoveTrackRangeFromQueue",
        &[
            instance_arg(),
            ("UpdateID", "0".to_string()),
            ("StartingIndex", starting_index.to_string()),
            ("NumberOfTracks", count.to_string()),
        ],
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_state_mapping() {
        assert_eq!(
            TransportState::from_sonos("PLAYING"),
            TransportState::Playing
        );
        assert_eq!(
            TransportState::from_sonos("PAUSED_PLAYBACK"),
            TransportState::PausedPlayback
        );
        assert_eq!(
            TransportState::from_sonos("STOPPED"),
            TransportState::Stopped
        );
        assert_eq!(
            TransportState::from_sonos("NO_MEDIA_PRESENT"),
            TransportState::Other
        );
    }

    #[test]
    fn position_parses_hms_and_track() {
        let mut r = BTreeMap::new();
        r.insert("Track".to_string(), "4".to_string());
        r.insert("RelTime".to_string(), "0:01:07".to_string());
        r.insert("TrackDuration".to_string(), "0:03:21".to_string());
        r.insert(
            "TrackURI".to_string(),
            "x-sonos-http:track%2f42.flac".to_string(),
        );
        let p = position_from_response(&r);
        assert_eq!(p.track_nr, 4);
        assert_eq!(p.position_secs, Some(67.0));
        assert_eq!(p.duration_secs, Some(201.0));

        r.insert("RelTime".to_string(), "NOT_IMPLEMENTED".to_string());
        assert_eq!(position_from_response(&r).position_secs, None);
    }
}
