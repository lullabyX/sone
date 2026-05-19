//! Pipeline probe: gathers ground-truth info about the audio pipeline
//! from /proc/asound (kernel hw_params) and pactl (OS mixer state).
//! Called by the `refresh_signal_path` Tauri command and the modal's
//! 2 s heartbeat. Runs in the Tauri command handler thread — never on
//! the audio thread.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DacHwParams {
    pub card_index: u32,
    pub card_name: String,
    pub pcm_device: String,
    pub format: String,
    pub rate: u32,
    pub channels: u32,
    pub period_size: u32,
    pub buffer_size: u32,
    pub state: HwParamsState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum HwParamsState {
    Active,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsMixerInfo {
    pub server: String,
    pub default_sink_name: String,
    pub sink_format: String,
    pub sink_rate: u32,
    pub sink_channels: u32,
}

/// Pad-caps snapshot from an audio pipeline probe.
#[derive(Debug, Clone, PartialEq)]
pub struct PadCaps {
    pub format: String,
    pub rate: u32,
    pub channels: u32,
}

/// Parse the contents of /proc/asound/<card>/pcm*p/sub*/hw_params.
/// Returns Some(parsed) for both active and closed PCMs.
/// Returns None for completely malformed input.
pub fn parse_hw_params_file(contents: &str) -> Option<ParsedHwParams> {
    let trimmed = contents.trim();
    if trimmed.is_empty() {
        return None;
    }

    // A closed PCM contains just the word "closed" on a line.
    if trimmed.lines().any(|l| l.trim() == "closed") {
        return Some(ParsedHwParams {
            format: String::new(),
            rate: 0,
            channels: 0,
            period_size: 0,
            buffer_size: 0,
            state: HwParamsState::Closed,
        });
    }

    let mut format = None;
    let mut rate = None;
    let mut channels = None;
    let mut period_size = None;
    let mut buffer_size = None;

    for line in trimmed.lines() {
        let (k, v) = match line.split_once(':') {
            Some(pair) => pair,
            None => continue,
        };
        let v = v.trim();
        match k.trim() {
            "format" => format = Some(v.to_string()),
            "channels" => channels = v.parse().ok(),
            "rate" => {
                // "96000 (96000/1)" → take leading integer
                let head = v.split_whitespace().next().unwrap_or("");
                rate = head.parse().ok();
            }
            "period_size" => period_size = v.parse().ok(),
            "buffer_size" => buffer_size = v.parse().ok(),
            _ => {}
        }
    }

    // Need at least format and rate to call it valid.
    let (format, rate) = (format?, rate?);
    Some(ParsedHwParams {
        format,
        rate,
        channels: channels.unwrap_or(0),
        period_size: period_size.unwrap_or(0),
        buffer_size: buffer_size.unwrap_or(0),
        state: HwParamsState::Active,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACTIVE_HW_PARAMS: &str = "\
access: RW_INTERLEAVED
format: S24_LE
subformat: STD
channels: 2
rate: 96000 (96000/1)
period_size: 480
buffer_size: 1920
";

    const ACTIVE_HW_PARAMS_S16: &str = "\
access: RW_INTERLEAVED
format: S16_LE
subformat: STD
channels: 2
rate: 44100 (44100/1)
period_size: 2205
buffer_size: 22050
";

    const CLOSED: &str = "closed\n";

    #[test]
    fn parses_active_hw_params() {
        let p = parse_hw_params_file(ACTIVE_HW_PARAMS).expect("active params should parse");
        assert_eq!(p.format, "S24_LE");
        assert_eq!(p.rate, 96000);
        assert_eq!(p.channels, 2);
        assert_eq!(p.period_size, 480);
        assert_eq!(p.buffer_size, 1920);
        assert_eq!(p.state, HwParamsState::Active);
    }

    #[test]
    fn parses_s16_44k() {
        let p = parse_hw_params_file(ACTIVE_HW_PARAMS_S16).unwrap();
        assert_eq!(p.format, "S16_LE");
        assert_eq!(p.rate, 44100);
    }

    #[test]
    fn parses_closed_state() {
        let p = parse_hw_params_file(CLOSED).expect("closed file should parse");
        assert_eq!(p.state, HwParamsState::Closed);
        assert_eq!(p.format, "");
        assert_eq!(p.rate, 0);
    }

    #[test]
    fn returns_none_on_malformed() {
        assert!(parse_hw_params_file("not a hw_params file\nfoo: bar").is_none());
        assert!(parse_hw_params_file("").is_none());
    }
}

/// Parsed snapshot of /proc/asound/<card>/pcm0p/sub0/hw_params content.
/// Caller wraps this in DacHwParams with card metadata.
#[derive(Debug, PartialEq)]
pub struct ParsedHwParams {
    pub format: String,
    pub rate: u32,
    pub channels: u32,
    pub period_size: u32,
    pub buffer_size: u32,
    pub state: HwParamsState,
}
