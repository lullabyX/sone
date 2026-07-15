//! Household topology: which rooms exist, how they're grouped, and which
//! player coordinates each group. All transport/queue commands must target
//! the group coordinator.

use crate::error::SoneError;
use crate::sonos::soap::{soap_action, ZONE_GROUP_TOPOLOGY};
use crate::sonos::xmlutil::elements_attrs;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneMember {
    pub uuid: String,
    pub ip: String,
    pub name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneGroup {
    pub coordinator_uuid: String,
    pub coordinator_ip: String,
    /// Coordinator's room name (display name for the group).
    pub name: String,
    /// All visible rooms in the group, coordinator included.
    pub members: Vec<ZoneMember>,
}

fn ip_from_location(location: &str) -> Option<String> {
    // e.g. http://192.168.1.23:1400/xml/device_description.xml
    let rest = location.strip_prefix("http://")?;
    let host = rest.split(['/', ':']).next()?;
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

/// Parse the `ZoneGroupState` XML (already unescaped by the SOAP layer).
pub fn parse_zone_group_state(xml: &str) -> Result<Vec<ZoneGroup>, SoneError> {
    // The document nests members inside their group, but attribute-level
    // extraction per group is enough: split on group boundaries first.
    let mut groups = Vec::new();
    for group_chunk in split_groups(xml) {
        let group_attrs = elements_attrs(&group_chunk, "ZoneGroup")?
            .into_iter()
            .next()
            .unwrap_or_default();
        let coordinator_uuid = group_attrs.get("Coordinator").cloned().unwrap_or_default();

        let mut members = Vec::new();
        let mut coordinator_ip = String::new();
        for m in elements_attrs(&group_chunk, "ZoneGroupMember")? {
            // Invisible members are bridges/bonded surrounds/sub units.
            if m.get("Invisible").map(String::as_str) == Some("1") {
                continue;
            }
            let uuid = m.get("UUID").cloned().unwrap_or_default();
            let ip = m
                .get("Location")
                .and_then(|l| ip_from_location(l))
                .unwrap_or_default();
            if uuid == coordinator_uuid {
                coordinator_ip = ip.clone();
            }
            members.push(ZoneMember {
                uuid,
                ip,
                name: m.get("ZoneName").cloned().unwrap_or_default(),
            });
        }
        if members.is_empty() {
            continue; // group of only invisible devices (e.g. a Boost)
        }
        // Coordinator can itself be invisible in exotic setups; fall back to
        // the first visible member so commands still have a target.
        if coordinator_ip.is_empty() {
            coordinator_ip = members[0].ip.clone();
        }
        let name = members
            .iter()
            .find(|m| m.uuid == coordinator_uuid)
            .map(|m| m.name.clone())
            .unwrap_or_else(|| members[0].name.clone());
        groups.push(ZoneGroup {
            coordinator_uuid,
            coordinator_ip,
            name,
            members,
        });
    }
    Ok(groups)
}

/// Split the ZoneGroupState document into one string per `<ZoneGroup>...</ZoneGroup>`.
fn split_groups(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<ZoneGroup ") {
        let after = &rest[start..];
        let end = match after.find("</ZoneGroup>") {
            Some(e) => e + "</ZoneGroup>".len(),
            None => break,
        };
        out.push(after[..end].to_string());
        rest = &after[end..];
    }
    out
}

/// Ask any player in the system for the full group topology.
pub async fn get_zone_groups(
    client: &reqwest::Client,
    ip: &str,
) -> Result<Vec<ZoneGroup>, SoneError> {
    let response = soap_action(client, ip, &ZONE_GROUP_TOPOLOGY, "GetZoneGroupState", &[]).await?;
    let state = response.get("ZoneGroupState").ok_or_else(|| {
        SoneError::SonosProtocol("GetZoneGroupState: no state in response".into())
    })?;
    parse_zone_group_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"<ZoneGroupState><ZoneGroups>
      <ZoneGroup Coordinator="RINCON_AAA01400" ID="RINCON_AAA01400:123">
        <ZoneGroupMember UUID="RINCON_AAA01400" Location="http://192.168.1.10:1400/xml/device_description.xml" ZoneName="Living Room" Configuration="1"/>
        <ZoneGroupMember UUID="RINCON_BBB01400" Location="http://192.168.1.11:1400/xml/device_description.xml" ZoneName="Kitchen" Configuration="1"/>
      </ZoneGroup>
      <ZoneGroup Coordinator="RINCON_CCC01400" ID="RINCON_CCC01400:77">
        <ZoneGroupMember UUID="RINCON_CCC01400" Location="http://192.168.1.12:1400/xml/device_description.xml" ZoneName="Bedroom" Configuration="1"/>
        <ZoneGroupMember UUID="RINCON_DDD01400" Location="http://192.168.1.13:1400/xml/device_description.xml" ZoneName="Bridge" Invisible="1"/>
      </ZoneGroup>
    </ZoneGroups></ZoneGroupState>"#;

    #[test]
    fn parses_groups_coordinators_and_members() {
        let groups = parse_zone_group_state(FIXTURE).unwrap();
        assert_eq!(groups.len(), 2);

        let lr = &groups[0];
        assert_eq!(lr.coordinator_uuid, "RINCON_AAA01400");
        assert_eq!(lr.coordinator_ip, "192.168.1.10");
        assert_eq!(lr.name, "Living Room");
        assert_eq!(lr.members.len(), 2);
        assert_eq!(lr.members[1].name, "Kitchen");

        let br = &groups[1];
        assert_eq!(br.members.len(), 1, "invisible member must be dropped");
        assert_eq!(br.coordinator_ip, "192.168.1.12");
    }

    #[test]
    fn ip_extraction() {
        assert_eq!(
            ip_from_location("http://192.168.1.23:1400/xml/device_description.xml"),
            Some("192.168.1.23".to_string())
        );
        assert_eq!(ip_from_location("garbage"), None);
    }
}
