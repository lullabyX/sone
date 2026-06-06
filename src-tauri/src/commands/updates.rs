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
