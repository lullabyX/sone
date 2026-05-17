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

use flexi_logger::{Cleanup, Criterion, Duplicate, FileSpec, Logger, LoggerHandle, Naming, WriteMode};
use std::path::PathBuf;

/// Initialize the global logger. Must be called exactly once at startup,
/// before any `log::*!` macros are invoked.
///
/// - `file_enabled = true`  → writes to `<log_dir>/sone_rCURRENT.log` (rotated)
///                            AND duplicates output to stderr.
/// - `file_enabled = false` → stderr only (current behavior pre-toggle).
///
/// Returns a `LoggerHandle`. The caller MUST keep this alive for the
/// process lifetime — dropping it stops the background log writer.
///
/// `RUST_LOG` still overrides the default `info` level when present.
/// On any file-system error (cannot create dir, cannot open file),
/// falls back to stderr-only and emits one `eprintln!` warning.
pub fn init_logging(log_dir: PathBuf, file_enabled: bool) -> LoggerHandle {
    let base = Logger::try_with_env_or_str("info")
        .expect("flexi_logger spec parsing should never fail for 'info'");

    if !file_enabled {
        return base
            .log_to_stderr()
            .write_mode(WriteMode::BufferAndFlush)
            .start()
            .expect("stderr logger should always start");
    }

    if let Err(e) = std::fs::create_dir_all(&log_dir) {
        eprintln!(
            "sone: could not create log directory {} ({}), falling back to stderr-only logging",
            log_dir.display(),
            e
        );
        return base
            .log_to_stderr()
            .write_mode(WriteMode::BufferAndFlush)
            .start()
            .expect("stderr logger should always start");
    }

    match base
        .log_to_file(FileSpec::default().directory(&log_dir).basename("sone"))
        .duplicate_to_stderr(Duplicate::All)
        .rotate(
            Criterion::Size(2_000_000),       // 2 MB
            Naming::Numbers,
            Cleanup::KeepLogFiles(5),         // 5 rotated + 1 active = ~12 MB max
        )
        .format_for_files(flexi_logger::detailed_format)
        .write_mode(WriteMode::BufferAndFlush)
        .start()
    {
        Ok(handle) => handle,
        Err(e) => {
            eprintln!(
                "sone: file logger init failed ({}), falling back to stderr-only logging",
                e
            );
            Logger::try_with_env_or_str("info")
                .unwrap()
                .log_to_stderr()
                .write_mode(WriteMode::BufferAndFlush)
                .start()
                .expect("stderr fallback should always start")
        }
    }
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
