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

/// Parse output of `pactl info`.
/// Returns None if Default Sink is missing.
pub fn parse_pactl_info(stdout: &str) -> Option<OsMixerInfo> {
    let mut server_raw = None;
    let mut default_sink = None;
    let mut spec = None;

    for line in stdout.lines() {
        if let Some(v) = line.strip_prefix("Server Name:").map(str::trim) {
            server_raw = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("Default Sink:").map(str::trim) {
            default_sink = Some(v.to_string());
        } else if let Some(v) = line.strip_prefix("Default Sample Specification:").map(str::trim) {
            spec = Some(v.to_string());
        }
    }

    let server = match server_raw.as_deref() {
        Some(s) if s.contains("PipeWire") => "PipeWire".to_string(),
        Some(s) if s.to_ascii_lowercase().contains("pulseaudio") => "PulseAudio".to_string(),
        Some(_) => "Unknown".to_string(),
        None => return None,
    };

    let default_sink_name = default_sink?;
    let (sink_format, sink_channels, sink_rate) = parse_sample_spec(&spec.unwrap_or_default());

    Some(OsMixerInfo {
        server,
        default_sink_name,
        sink_format,
        sink_rate,
        sink_channels,
    })
}

/// Parse "<format> <N>ch <rate>Hz" → (format, channels, rate).
/// Tolerant of missing/garbage parts.
fn parse_sample_spec(spec: &str) -> (String, u32, u32) {
    let mut format = String::new();
    let mut channels = 0;
    let mut rate = 0;
    for tok in spec.split_whitespace() {
        if let Some(c) = tok.strip_suffix("ch").and_then(|s| s.parse::<u32>().ok()) {
            channels = c;
        } else if let Some(r) = tok.strip_suffix("Hz").and_then(|s| s.parse::<u32>().ok()) {
            rate = r;
        } else if format.is_empty() {
            format = tok.to_string();
        }
    }
    (format, channels, rate)
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

    const PACTL_INFO_PIPEWIRE: &str = "\
Server String: /run/user/1000/pulse/native
Library Protocol Version: 35
Server Protocol Version: 35
Is Local: yes
Server Name: PulseAudio (on PipeWire 1.0.5)
Server Version: 15.0.0
Default Sample Specification: float32le 2ch 48000Hz
Default Channel Map: front-left,front-right
Default Sink: alsa_output.pci-0000_01_00.1.hdmi-stereo
Default Source: alsa_input.usb-foo.mono-fallback
Cookie: c4d7:c013
";

    const PACTL_INFO_PULSE: &str = "\
Server Name: pulseaudio
Default Sample Specification: s16le 2ch 44100Hz
Default Sink: alsa_output.usb-iFi-by-AMR-HD-USB-Audio.iec958-stereo
";

    #[test]
    fn detects_pipewire_server() {
        let info = parse_pactl_info(PACTL_INFO_PIPEWIRE).unwrap();
        assert_eq!(info.server, "PipeWire");
        assert_eq!(info.default_sink_name, "alsa_output.pci-0000_01_00.1.hdmi-stereo");
        assert_eq!(info.sink_format, "float32le");
        assert_eq!(info.sink_rate, 48000);
        assert_eq!(info.sink_channels, 2);
    }

    #[test]
    fn detects_pulseaudio_server() {
        let info = parse_pactl_info(PACTL_INFO_PULSE).unwrap();
        assert_eq!(info.server, "PulseAudio");
        assert_eq!(info.sink_rate, 44100);
    }

    #[test]
    fn parse_pactl_info_returns_none_when_no_sink() {
        let stripped = "Server Name: PulseAudio\nDefault Sample Specification: s16le 2ch 44100Hz\n";
        assert!(parse_pactl_info(stripped).is_none());
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
