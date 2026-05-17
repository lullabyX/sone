//! Pre-Tauri logger setup. Runs before AppState exists so it cannot
//! depend on anything in `lib.rs::Settings` beyond a tiny JSON probe.

use std::path::Path;

/// Read just the `enable_logging` flag from a `settings.json` file.
/// Defaults to `true` on any failure (missing file, parse error, missing
/// key). This runs before Tauri starts, so it intentionally does not
/// depend on the full `Settings` deserializer.
pub fn read_logging_preference(settings_path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(settings_path) else {
        return true;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return true;
    };
    value
        .get("enable_logging")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp_settings(contents: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(contents.as_bytes()).unwrap();
        f
    }

    #[test]
    fn probe_returns_true_when_file_missing() {
        let path = std::path::PathBuf::from("/nonexistent/sone-settings.json");
        assert!(read_logging_preference(&path));
    }

    #[test]
    fn probe_returns_true_when_json_is_malformed() {
        let f = tmp_settings("{not valid json");
        assert!(read_logging_preference(f.path()));
    }

    #[test]
    fn probe_returns_true_when_key_missing() {
        let f = tmp_settings(r#"{"volume": 1.0}"#);
        assert!(read_logging_preference(f.path()));
    }

    #[test]
    fn probe_returns_false_when_explicitly_disabled() {
        let f = tmp_settings(r#"{"enable_logging": false}"#);
        assert!(!read_logging_preference(f.path()));
    }

    #[test]
    fn probe_returns_true_when_explicitly_enabled() {
        let f = tmp_settings(r#"{"enable_logging": true}"#);
        assert!(read_logging_preference(f.path()));
    }
}
