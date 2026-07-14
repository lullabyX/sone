//! Linked music-service account discovery via `GET /status/accounts`.
//! We only care whether the household has a TIDAL account and its serial.

use crate::error::SoneError;
use crate::sonos::didl::TIDAL_SERVICE_TYPE;
use crate::sonos::soap::SONOS_PORT;
use crate::sonos::xmlutil::elements_attrs;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TidalAccount {
    /// Account `SerialNum` — the `sn=` value for `x-sonos-http` URIs.
    pub serial: String,
}

/// Whether the household has a linked TIDAL account, as far as the legacy
/// `/status/accounts` endpoint can tell.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum TidalLinkStatus {
    Linked(TidalAccount),
    NotLinked,
    /// Modern S2 firmware returns an empty `<ZPSupportInfo/>` here (accounts
    /// moved to Sonos's authenticated cloud/local APIs). Linkage is then only
    /// observable by attempting a service-token enqueue.
    Unknown,
}

/// Parse the `/status/accounts` document for a live, non-deleted TIDAL account.
pub fn parse_accounts(xml: &str) -> Result<TidalLinkStatus, SoneError> {
    let accounts = elements_attrs(xml, "Account")?;
    // No <Accounts> container at all → firmware no longer exposes the list.
    if accounts.is_empty() && elements_attrs(xml, "Accounts")?.is_empty() {
        return Ok(TidalLinkStatus::Unknown);
    }
    let tidal_type = TIDAL_SERVICE_TYPE.to_string();
    for account in accounts {
        if account.get("Type") == Some(&tidal_type)
            && account.get("Deleted").map(String::as_str) != Some("1")
        {
            return Ok(TidalLinkStatus::Linked(TidalAccount {
                serial: account.get("SerialNum").cloned().unwrap_or_default(),
            }));
        }
    }
    Ok(TidalLinkStatus::NotLinked)
}

/// Query any player in the household for its linked TIDAL account.
pub async fn get_tidal_account(
    client: &reqwest::Client,
    ip: &str,
) -> Result<TidalLinkStatus, SoneError> {
    let url = format!("http://{ip}:{SONOS_PORT}/status/accounts");
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
    parse_accounts(&xml)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_live_tidal_account() {
        let xml = r#"<ZPSupportInfo><Accounts LastUpdateDevice="RINCON_AAA" Version="8" NextSerialNum="4">
            <Account Type="2311" SerialNum="1" Deleted="0"><UN>spotify-user</UN><MD>1</MD></Account>
            <Account Type="44551" SerialNum="3" Deleted="0"><UN>tidal-user</UN><MD>1</MD><NN>TIDAL</NN></Account>
        </Accounts></ZPSupportInfo>"#;
        match parse_accounts(xml).unwrap() {
            TidalLinkStatus::Linked(acct) => assert_eq!(acct.serial, "3"),
            other => panic!("expected Linked, got {other:?}"),
        }
    }

    #[test]
    fn ignores_deleted_and_distinguishes_unknown() {
        let deleted = r#"<ZPSupportInfo><Accounts><Account Type="44551" SerialNum="2" Deleted="1"/></Accounts></ZPSupportInfo>"#;
        assert!(matches!(
            parse_accounts(deleted).unwrap(),
            TidalLinkStatus::NotLinked
        ));
        let none = r#"<ZPSupportInfo><Accounts><Account Type="2311" SerialNum="1" Deleted="0"/></Accounts></ZPSupportInfo>"#;
        assert!(matches!(
            parse_accounts(none).unwrap(),
            TidalLinkStatus::NotLinked
        ));
        // Modern firmware: empty support info → unknown, not "not linked".
        assert!(matches!(
            parse_accounts("<ZPSupportInfo></ZPSupportInfo>").unwrap(),
            TidalLinkStatus::Unknown
        ));
        // Accounts element present but empty → genuinely no linked services.
        assert!(matches!(
            parse_accounts("<ZPSupportInfo><Accounts/></ZPSupportInfo>").unwrap(),
            TidalLinkStatus::NotLinked
        ));
    }
}
