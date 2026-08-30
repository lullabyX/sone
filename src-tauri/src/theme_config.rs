//! External theme configuration — `<config_sone_dir>/theme.json`.
//!
//! File shape:
//! ```json
//! {
//!     "version": 1,
//!     "preset": "custom",
//!     "custom": { "accent": "#3B82F6", "background": "#0E1118" }
//! }
//! ```

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Current schema version.
pub const THEME_FILE_VERSION: u32 = 1;

/// The `"preset"` meaning "use the `custom` colors".
pub const CUSTOM_PRESET: &str = "custom";

/// Canonical preset names. Must stay in sync with `PRESET_THEMES`
/// in `src/lib/theme.ts`(case-sensitive, order irrelevant).
pub const PRESET_NAMES: &[&str] = &[
    "Violet Night",
    "Cyberpunk",
    "Forest",
    "Ocean",
    "Midnight Cyan",
    "Sakura",
    "Rose",
    "Ember",
    "Copper",
    "Noir",
    "Daylight",
    "Snowfall",
    "Paper",
    "Meadow",
    "Blossom",
];

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct ThemeFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    pub preset: String,
    pub custom: ThemeCustom,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct ThemeCustom {
    pub accent: String,
    pub background: String,
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// Validate a hex color and normalize it to uppercase `#RRGGBB`.
fn normalize_hex(input: &str) -> Option<String> {
    let digits = input.trim().strip_prefix('#')?;
    let bytes: Vec<u8> = if digits.len() == 3 {
        digits.bytes().flat_map(|b| [b, b]).collect()
    } else if digits.len() == 6 {
        digits.bytes().collect()
    } else {
        return None;
    };
    let mut out = String::with_capacity(7);
    out.push('#');
    for b in bytes {
        if !b.is_ascii_hexdigit() {
            return None;
        }
        let c = (b as char).to_ascii_uppercase();
        out.push(c);
    }
    Some(out)
}

pub fn validate(raw: &ThemeFile) -> Result<ThemeFile, String> {
    if let Some(v) = raw.version {
        if v != THEME_FILE_VERSION {
            return Err(format!(
                "unknown theme file version {v} (expected {THEME_FILE_VERSION})"
            ));
        }
    }

    // Is preset known
    if raw.preset != CUSTOM_PRESET && !PRESET_NAMES.contains(&raw.preset.as_str()) {
        return Err(format!("unknown theme preset {:?}", raw.preset));
    }

    let accent = normalize_hex(&raw.custom.accent)
        .ok_or_else(|| format!("invalid accent color {:?}", raw.custom.accent))?;
    let background = normalize_hex(&raw.custom.background)
        .ok_or_else(|| format!("invalid background color {:?}", raw.custom.background))?;

    Ok(ThemeFile {
        version: Some(THEME_FILE_VERSION),
        preset: raw.preset.clone(),
        custom: ThemeCustom { accent, background },
    })
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

fn config_sone_dir() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .ok_or_else(|| "config directory is unresolvable".to_string())?
        .join("sone");
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create {dir:?}: {e}"))?;
    Ok(dir)
}

/// Read + validate the theme file.
///
/// - File absent            -> `Ok(None)`
/// - File present + valid   -> `Ok(Some(normalized))`
/// - File present + invalid -> `Err`
pub fn read_theme_file(path: &Path) -> Result<Option<ThemeFile>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("failed to read {path:?}: {e}"))?;
    let parsed: ThemeFile =
        serde_json::from_str(&raw).map_err(|e| format!("theme file is not valid JSON: {e}"))?;
    match validate(&parsed) {
        Ok(normalized) => Ok(Some(normalized)),
        Err(e) => {
            log::warn!("theme: ignoring invalid {path:?}: {e}");
            Err(e)
        }
    }
}

/// Validate and atomically write the theme file (`tmp-<pid>` -> fsync ->
/// rename), mode `0644`. So a crash can never leave a torn file.
pub fn write_theme_file(path: &Path, file: &ThemeFile) -> Result<(), String> {
    let normalized = validate(file)?;
    let json = serde_json::to_string_pretty(&normalized)
        .map_err(|e| format!("failed to serialize theme: {e}"))?;

    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|e| format!("failed to create {:?}: {e}", parent))?;

    let tmp = parent.join(format!(
        "{}.tmp-{}",
        path.file_name().ok_or("bad path")?.to_string_lossy(),
        std::process::id()
    ));

    let mut opts = fs::OpenOptions::new();
    opts.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o644);
    }
    // Write temp file, ensure data is written on disk.
    let mut f = opts
        .open(&tmp)
        .map_err(|e| format!("failed to open {tmp:?}: {e}"))?;
    f.write_all(json.as_bytes())
        .map_err(|e| format!("failed to write {tmp:?}: {e}"))?;
    f.flush()
        .map_err(|e| format!("failed to flush {tmp:?}: {e}"))?;
    f.sync_all()
        .map_err(|e| format!("failed to fsync {tmp:?}: {e}"))?;
    drop(f);

    // Rename to correct path, replaces original file if 'to' already exists.
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("failed to rename {tmp:?} → {path:?}: {e}")
    })?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn theme_file_get() -> Result<Option<ThemeFile>, String> {
    let dir = config_sone_dir()?;
    read_theme_file(&dir.join("theme.json"))
}

#[tauri::command]
pub fn theme_file_set(file: ThemeFile) -> Result<(), String> {
    let dir = config_sone_dir()?;
    write_theme_file(&dir.join("theme.json"), &file)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn custom(accent: &str, background: &str) -> ThemeFile {
        ThemeFile {
            version: Some(1),
            preset: "custom".to_string(),
            custom: ThemeCustom {
                accent: accent.to_string(),
                background: background.to_string(),
            },
        }
    }

    #[test]
    fn validate_custom_ok() {
        let v = validate(&custom("#3b82f6", "#0E1118")).unwrap();
        assert_eq!(v.preset, "custom");
        assert_eq!(v.custom.accent, "#3B82F6");
        assert_eq!(v.custom.background, "#0E1118");
        assert_eq!(v.version, Some(1));
    }

    #[test]
    fn validate_rgb_expanded() {
        let v = validate(&custom("#fff", "#abc")).unwrap();
        assert_eq!(v.custom.accent, "#FFFFFF");
        assert_eq!(v.custom.background, "#AABBCC");
    }

    #[test]
    fn validate_named_preset_keeps_preset() {
        let f = ThemeFile {
            version: None, // absent version == 1
            preset: "Ocean".to_string(),
            // deliberately mismatched colors: preset is authoritative
            custom: ThemeCustom {
                accent: "#123456".to_string(),
                background: "#654321".to_string(),
            },
        };
        let v = validate(&f).unwrap();
        assert_eq!(v.preset, "Ocean");
        assert_eq!(v.version, Some(1));
    }

    #[test]
    fn validate_unknown_preset_rejected() {
        let f = ThemeFile {
            preset: "ocean".to_string(), // case-sensitive
            ..custom("#3B82F6", "#0E1118")
        };
        assert!(validate(&f).is_err());
        let f = ThemeFile {
            preset: "Solarized".to_string(),
            ..custom("#3B82F6", "#0E1118")
        };
        assert!(validate(&f).is_err());
    }

    #[test]
    fn validate_bad_hex_rejected() {
        assert!(validate(&custom("#GGG", "#0E1118")).is_err());
        assert!(validate(&custom("#3B82F", "#0E1118")).is_err());
        assert!(validate(&custom("3B82F6", "#0E1118")).is_err());
        assert!(validate(&custom("", "#0E1118")).is_err());
    }

    #[test]
    fn validate_unknown_version_rejected() {
        let f = ThemeFile {
            version: Some(2),
            ..custom("#3B82F6", "#0E1118")
        };
        assert!(validate(&f).is_err());
    }

    #[test]
    fn read_missing_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            read_theme_file(&dir.path().join("theme.json")).unwrap(),
            None
        );
    }

    #[test]
    fn read_invalid_file_errors() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("theme.json");
        // garbage bytes
        fs::write(&p, b"not json at all {{{").unwrap();
        assert!(read_theme_file(&p).is_err());
        // unknown version
        fs::write(
            &p,
            r###"{"version": 99, "preset": "custom", "custom": {"accent": "#3B82F6", "background": "#0E1118"}}"###,
        )
        .unwrap();
        assert!(read_theme_file(&p).is_err());
        // missing custom
        fs::write(&p, r#"{"preset": "custom"}"#).unwrap();
        assert!(read_theme_file(&p).is_err());
    }

    #[test]
    fn round_trip_and_no_temp_linger() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("theme.json");

        let file = ThemeFile {
            preset: "Ocean".to_string(),
            custom: ThemeCustom {
                accent: "#3b82f6".to_string(),
                background: "#0e1118".to_string(),
            },
            version: None,
        };
        write_theme_file(&p, &file).unwrap();

        let read = read_theme_file(&p).unwrap().unwrap();
        assert_eq!(read, validate(&file).unwrap());

        // Atomic temp file must not linger.
        let leftover: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(leftover.is_empty());
    }

    #[test]
    fn overwrite_replaces_content() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("theme.json");
        write_theme_file(&p, &custom("#111111", "#222222")).unwrap();
        write_theme_file(&p, &custom("#3B82F6", "#0E1118")).unwrap();
        let read = read_theme_file(&p).unwrap().unwrap();
        assert_eq!(read.custom.accent, "#3B82F6");
        assert_eq!(read.custom.background, "#0E1118");
    }

    #[cfg(unix)]
    #[test]
    fn file_mode_is_0644() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("theme.json");
        write_theme_file(&p, &custom("#3B82F6", "#0E1118")).unwrap();
        let mode = fs::metadata(&p).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o644);
    }
}
