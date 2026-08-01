//! Pre-Tauri logger setup. Runs before AppState exists so it cannot
//! depend on anything in `lib.rs::Settings` beyond a tiny plaintext probe.

use std::path::Path;

/// Read the logging toggle from the plaintext sidecar file at
/// `~/.config/sone/logging.toggle`. The file must contain literally
/// `"true"` or `"false"` (trailing whitespace/newlines are trimmed).
///
/// Defaults to `true` on any failure (missing file, unreadable, or
/// any content other than the literal string `"false"`). This runs
/// before Tauri starts and before `AppState` exists, so it intentionally
/// reads only this small sidecar — **not** the encrypted `Settings` struct.
pub fn read_logging_preference(path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return true;
    };
    match text.trim() {
        "false" => false,
        _ => true,
    }
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
/// Default spec `tauri_app_lib=debug,info`: SONE's crate at `debug`,
/// deps at `info`. `RUST_LOG` overrides it. Falls back to stderr-only
/// on any file-system error.
pub fn init_logging(log_dir: PathBuf, file_enabled: bool) -> LoggerHandle {
    let base = Logger::try_with_env_or_str("tauri_app_lib=debug,info")
        .expect("flexi_logger spec parsing should never fail for a static spec");

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
            Criterion::Size(5_000_000),       // 5 MB
            Naming::Numbers,
            Cleanup::KeepLogFiles(9),         // 9 rotated + 1 active = ~50 MB max
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
            Logger::try_with_env_or_str("tauri_app_lib=debug,info")
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

    fn tmp_toggle(contents: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(contents.as_bytes()).unwrap();
        f
    }

    #[test]
    fn probe_returns_true_when_file_missing() {
        let path = std::path::PathBuf::from("/nonexistent/sone-logging.toggle");
        assert!(read_logging_preference(&path));
    }

    #[test]
    fn probe_returns_true_when_contents_garbage() {
        let f = tmp_toggle("not valid stuff");
        assert!(read_logging_preference(f.path()));
    }

    #[test]
    fn probe_returns_false_when_explicitly_disabled() {
        let f = tmp_toggle("false");
        assert!(!read_logging_preference(f.path()));
    }

    #[test]
    fn probe_returns_true_when_explicitly_enabled() {
        let f = tmp_toggle("true");
        assert!(read_logging_preference(f.path()));
    }

    #[test]
    fn probe_returns_false_when_explicitly_disabled_with_trailing_newline() {
        let f = tmp_toggle("false\n");
        assert!(!read_logging_preference(f.path()));
    }

    #[test]
    fn probe_returns_true_when_contents_empty() {
        let f = tmp_toggle("");
        assert!(read_logging_preference(f.path()));
    }
}
