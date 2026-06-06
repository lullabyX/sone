use crate::error::SoneError;
use semver::Version;
use serde::Serialize;

const GITHUB_LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/lullabyX/sone/releases/latest";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current: String,
    pub latest: String,
    pub url: String,
}

/// Parse a GitHub release tag (e.g. "v0.19.0" or "0.19.0") into a semver Version.
fn parse_release_tag(tag: &str) -> Option<Version> {
    Version::parse(tag.trim().trim_start_matches('v')).ok()
}

/// True only when both versions parse and `latest_tag` is strictly newer than `current`.
fn is_update_available(current: &str, latest_tag: &str) -> bool {
    match (Version::parse(current), parse_release_tag(latest_tag)) {
        (Ok(cur), Some(latest)) => latest > cur,
        _ => false,
    }
}

/// Check GitHub Releases for a newer version. Network/parse failures surface as
/// `SoneError`; the frontend treats any failure as "no update" (silent).
#[tauri::command]
pub async fn check_for_update() -> Result<UpdateInfo, SoneError> {
    let current = env!("CARGO_PKG_VERSION").to_string();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    let body: serde_json::Value = client
        .get(GITHUB_LATEST_RELEASE_URL)
        // GitHub rejects requests without a User-Agent.
        .header(reqwest::header::USER_AGENT, "SONE-update-checker")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let url = body
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    Ok(UpdateInfo {
        available: is_update_available(&current, tag),
        current,
        latest: tag.trim_start_matches('v').to_string(),
        url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tag_with_v_prefix() {
        assert_eq!(parse_release_tag("v0.19.0"), Version::parse("0.19.0").ok());
    }

    #[test]
    fn parses_tag_without_prefix() {
        assert_eq!(parse_release_tag("0.19.0"), Version::parse("0.19.0").ok());
    }

    #[test]
    fn rejects_garbage_tag() {
        assert!(parse_release_tag("nightly").is_none());
    }

    #[test]
    fn newer_release_is_available() {
        assert!(is_update_available("0.18.1", "v0.19.0"));
    }

    #[test]
    fn same_version_is_not_available() {
        assert!(!is_update_available("0.18.1", "v0.18.1"));
    }

    #[test]
    fn older_release_is_not_available() {
        assert!(!is_update_available("0.19.0", "v0.18.1"));
    }

    #[test]
    fn patch_bump_is_available() {
        assert!(is_update_available("0.18.1", "0.18.2"));
    }

    #[test]
    fn unparseable_inputs_are_not_available() {
        assert!(!is_update_available("0.18.1", "nightly"));
        assert!(!is_update_available("not-semver", "0.19.0"));
    }
}
