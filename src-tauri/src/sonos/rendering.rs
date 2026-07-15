//! Group volume/mute via GroupRenderingControl — one logical volume for the
//! whole group, which is what an output picker semantically controls.
//! Target the group coordinator.

use crate::error::SoneError;
use crate::sonos::soap::{instance_arg, soap_action, GROUP_RENDERING_CONTROL};

/// 0–100.
pub async fn set_group_volume(
    client: &reqwest::Client,
    ip: &str,
    volume: u8,
) -> Result<(), SoneError> {
    soap_action(
        client,
        ip,
        &GROUP_RENDERING_CONTROL,
        "SetGroupVolume",
        &[
            instance_arg(),
            ("DesiredVolume", volume.min(100).to_string()),
        ],
    )
    .await?;
    Ok(())
}

pub async fn get_group_volume(client: &reqwest::Client, ip: &str) -> Result<u8, SoneError> {
    let response = soap_action(
        client,
        ip,
        &GROUP_RENDERING_CONTROL,
        "GetGroupVolume",
        &[instance_arg()],
    )
    .await?;
    response
        .get("CurrentVolume")
        .and_then(|v| v.trim().parse().ok())
        .ok_or_else(|| SoneError::SonosProtocol("GetGroupVolume: no CurrentVolume".into()))
}

pub async fn set_group_mute(
    client: &reqwest::Client,
    ip: &str,
    muted: bool,
) -> Result<(), SoneError> {
    soap_action(
        client,
        ip,
        &GROUP_RENDERING_CONTROL,
        "SetGroupMute",
        &[instance_arg(), ("DesiredMute", u8::from(muted).to_string())],
    )
    .await?;
    Ok(())
}

pub async fn get_group_mute(client: &reqwest::Client, ip: &str) -> Result<bool, SoneError> {
    let response = soap_action(
        client,
        ip,
        &GROUP_RENDERING_CONTROL,
        "GetGroupMute",
        &[instance_arg()],
    )
    .await?;
    Ok(response.get("CurrentMute").map(String::as_str) == Some("1"))
}
