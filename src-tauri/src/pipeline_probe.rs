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
    /// Linear amplitude multiplier the OS mixer applies before the kernel
    /// write. Derived from the per-channel dB value in `pactl list sinks`
    /// (10^(dB/20)) — endian-of-scale agnostic, unlike the percentage which
    /// depends on the cubic/linear setting. 1.0 = unity. 0.0 = mute.
    pub sink_volume: f32,
    pub sink_muted: bool,
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
        sink_volume: 1.0,
        sink_muted: false,
    })
}

/// Parse the per-sink Mute and Volume lines for a target sink from
/// `pactl list sinks` output. Returns (linear_amplitude_multiplier, muted).
///
/// Volume line format (PipeWire/Pulse):
///   Volume: front-left: 39322 /  60% / -13.31 dB,   front-right: 39322 / ...
/// We use the dB value (10^(dB/20)) because the "%" depends on the
/// cubic/linear scaling the server is configured with — dB is authoritative.
/// We use the channel with the largest |dB| from 0 as the representative,
/// so any unbalanced cut surfaces honestly.
///
/// `Base Volume:` lines are skipped (they describe the sink's reference
/// 0 dB, not the current setting).
pub fn sink_volume_and_mute(stdout: &str, target_sink_name: &str) -> (f32, bool) {
    let mut in_target = false;
    let mut volume: f32 = 1.0;
    let mut muted = false;

    for line in stdout.lines() {
        let trimmed = line.trim_start();
        if let Some(name) = trimmed.strip_prefix("Name:") {
            in_target = name.trim() == target_sink_name;
            continue;
        }
        if !in_target {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("Mute:") {
            muted = rest.trim().eq_ignore_ascii_case("yes");
        } else if let Some(rest) = trimmed.strip_prefix("Volume:") {
            // Skip "Base Volume:" — strip_prefix("Volume:") only matches when
            // the prefix is exactly "Volume:", but `Base Volume:` is reached
            // only via the outer trimmed line "Base Volume:" which starts
            // with "Base", so strip_prefix("Volume:") returns None for it.
            let mut max_abs_db: f32 = 0.0;
            let mut chosen_db: f32 = 0.0;
            for part in rest.split(',') {
                // Find " dB" anchor; the dB number is just before it.
                let Some(db_end) = part.rfind(" dB") else { continue };
                let before_db = &part[..db_end];
                let Some(last_slash) = before_db.rfind('/') else { continue };
                let db_str = before_db[last_slash + 1..].trim();
                let Ok(db) = db_str.parse::<f32>() else { continue };
                if db.abs() > max_abs_db {
                    max_abs_db = db.abs();
                    chosen_db = db;
                }
            }
            if max_abs_db > 0.0 {
                volume = 10f32.powf(chosen_db / 20.0);
            }
        }
    }

    (volume, muted)
}

/// Find the Sample Specification (format/channels/rate) for a sink with
/// the given Name in `pactl list sinks` output.
pub fn sink_sample_spec(stdout: &str, target_sink_name: &str) -> Option<(String, u32, u32)> {
    let mut in_target = false;
    for line in stdout.lines() {
        let trimmed = line.trim_start();
        if let Some(name) = trimmed.strip_prefix("Name:") {
            in_target = name.trim() == target_sink_name;
        } else if in_target {
            if let Some(rest) = trimmed.strip_prefix("Sample Specification:") {
                let (fmt, ch, rate) = parse_sample_spec(rest.trim());
                if !fmt.is_empty() && rate > 0 {
                    return Some((fmt, ch, rate));
                }
            }
        }
    }
    None
}

/// Scan `pactl list sinks` output for a sink with the given Name, and return
/// its `alsa.id` property — which maps to /proc/asound/<id>/.
pub fn sink_alsa_id(stdout: &str, target_sink_name: &str) -> Option<String> {
    let mut in_target = false;
    for line in stdout.lines() {
        let trimmed = line.trim_start();
        if let Some(name) = trimmed.strip_prefix("Name:") {
            in_target = name.trim() == target_sink_name;
        } else if in_target {
            if let Some(rest) = trimmed.strip_prefix("alsa.id =") {
                // Format: alsa.id = "Audio"
                return Some(rest.trim().trim_matches('"').to_string());
            }
        }
    }
    None
}

/// Discover the /proc/asound directory name (e.g. "Audio") for the card
/// currently being driven by SONE. Pure function; takes a resolver closure
/// for sink-name → alsa.id lookup so the function is testable without
/// shell-outs.
pub fn discover_active_card_with_resolver(
    backend: Option<&str>,
    exclusive_device: Option<&str>,
    mixer: Option<&OsMixerInfo>,
    sink_resolver: &dyn Fn(&str) -> Option<String>,
) -> Option<String> {
    match backend {
        Some("DirectAlsa") => exclusive_device.and_then(parse_alsa_card_from_device),
        Some("Normal") => {
            let mixer = mixer?;
            sink_resolver(&mixer.default_sink_name)
        }
        _ => None,
    }
}

/// Convenience wrapper that takes no resolver — used by callers that don't
/// have list-sinks output yet (returns None for Normal mode).
pub fn discover_active_card(
    backend: Option<&str>,
    exclusive_device: Option<&str>,
    mixer: Option<&OsMixerInfo>,
) -> Option<String> {
    discover_active_card_with_resolver(backend, exclusive_device, mixer, &|_| None)
}

/// Extract the card name from an ALSA device string. Handles both:
///   - hw:CARD=Audio,DEV=0   (named, GStreamer's preferred form)
///   - hw:5,0                (numeric, GStreamer fallback when api.alsa.path absent)
///   - plughw:* variants of either
/// Returns the card's /proc/asound/<name> directory entry name.
pub fn parse_alsa_card_from_device(device: &str) -> Option<String> {
    let body = device
        .strip_prefix("plughw:")
        .or_else(|| device.strip_prefix("hw:"))?;

    if let Some(rest) = body.strip_prefix("CARD=") {
        let end = rest.find(',').unwrap_or(rest.len());
        return Some(rest[..end].to_string());
    }

    // Numeric form: parse leading integer and resolve via /proc/asound/cards.
    let end = body.find(',').unwrap_or(body.len());
    let card_idx: u32 = body[..end].parse().ok()?;
    card_index_to_name(card_idx)
}

/// Look up the bracket name (e.g. "Audio") for card index N in
/// /proc/asound/cards. Returns None on parse failure or missing card.
fn card_index_to_name(idx: u32) -> Option<String> {
    let cards = std::fs::read_to_string("/proc/asound/cards").ok()?;
    for line in cards.lines() {
        // Format: "  N [Name           ]: Driver - Long name"
        let trimmed = line.trim_start();
        let space_pos = trimmed.find(' ')?;
        let num_str = &trimmed[..space_pos];
        if num_str.parse::<u32>().ok() != Some(idx) {
            continue;
        }
        let after_num = trimmed[space_pos..].trim_start();
        let after_bracket = after_num.strip_prefix('[')?;
        let close = after_bracket.find(']')?;
        return Some(after_bracket[..close].trim().to_string());
    }
    None
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

use std::process::Command;
use std::sync::Arc;

pub struct PipelineProbe {
    signal_path: Arc<crate::signal_path::SignalPathTracker>,
    audio_player: Arc<crate::audio::AudioPlayer>,
}

impl PipelineProbe {
    pub fn new(
        signal_path: Arc<crate::signal_path::SignalPathTracker>,
        audio_player: Arc<crate::audio::AudioPlayer>,
    ) -> Self {
        Self { signal_path, audio_player }
    }

    /// One-shot refresh: probe all sources, push into tracker. Cheap to call.
    /// Runs in the Tauri command handler thread; performs file reads and one
    /// shell-out to pactl. Never blocks on audio thread.
    pub fn refresh(&self) {
        // 1. Pad caps cells (mutex reads, very fast).
        self.signal_path.set_decoded_caps(self.audio_player.snapshot_decoded_caps());
        self.signal_path.set_output_caps(self.audio_player.snapshot_output_caps());

        // 2. OS mixer via pactl. Best-effort; None on failure.
        let mixer = query_os_mixer();
        self.signal_path.set_os_mixer(mixer.clone());

        // 3. Discover the active card and read its hw_params.
        let backend = self.signal_path.snapshot().backend;
        let exclusive_device = self.audio_player.exclusive_device();
        let card = if let Some(b) = backend.as_deref() {
            if b == "Normal" {
                // Need sink → alsa.id mapping from `pactl list sinks`.
                let list_stdout = run_pactl(&["list", "sinks"]);
                let resolver = |sink: &str| {
                    list_stdout.as_deref().and_then(|out| sink_alsa_id(out, sink))
                };
                discover_active_card_with_resolver(Some(b), exclusive_device.as_deref(), mixer.as_ref(), &resolver)
            } else {
                discover_active_card(Some(b), exclusive_device.as_deref(), mixer.as_ref())
            }
        } else {
            None
        };

        let dac = card.as_deref().and_then(read_hw_params);
        self.signal_path.set_dac(dac);
    }
}

/// Read /proc/asound/<card>/pcm0p/sub0/hw_params and return a populated
/// DacHwParams. Tries multiple PCM subdevices if pcm0p/sub0 is closed,
/// to handle hardware with non-default PCM indices.
pub fn read_hw_params(card_name: &str) -> Option<DacHwParams> {
    let base = format!("/proc/asound/{card_name}");
    let card_index = read_card_index(card_name).unwrap_or(0);

    // Probe a small grid of pcm/sub combinations (covers ~all hardware).
    for pcm in 0..4u32 {
        for sub in 0..2u32 {
            let path = format!("{base}/pcm{pcm}p/sub{sub}/hw_params");
            let Ok(contents) = std::fs::read_to_string(&path) else { continue };
            let parsed = parse_hw_params_file(&contents)?;
            if parsed.state == HwParamsState::Closed && (pcm != 0 || sub != 0) {
                continue; // try the next subdevice
            }
            return Some(DacHwParams {
                card_index,
                card_name: read_card_longname(card_name).unwrap_or_else(|| card_name.to_string()),
                pcm_device: format!("hw:CARD={card_name},DEV={pcm}"),
                format: parsed.format,
                rate: parsed.rate,
                channels: parsed.channels,
                period_size: parsed.period_size,
                buffer_size: parsed.buffer_size,
                state: parsed.state,
            });
        }
    }
    None
}

fn read_card_index(card_name: &str) -> Option<u32> {
    let id_path = format!("/proc/asound/{card_name}/id");
    // /proc/asound/<name> is sometimes a symlink to /proc/asound/cardN — read the link.
    let link = std::fs::read_link(format!("/proc/asound/{card_name}")).ok()?;
    let s = link.to_string_lossy();
    s.strip_prefix("card").and_then(|n| n.parse().ok()).or_else(|| {
        // Fallback: read the id file (contains the same name; index unknown).
        let _ = std::fs::read_to_string(id_path);
        None
    })
}

fn read_card_longname(card_name: &str) -> Option<String> {
    // /proc/asound/cards lists "  N [Name           ]: Driver - Long name"
    let cards = std::fs::read_to_string("/proc/asound/cards").ok()?;
    for line in cards.lines() {
        if let Some(bracket) = line.find('[') {
            let after = &line[bracket + 1..];
            if let Some(close) = after.find(']') {
                let id = after[..close].trim();
                if id == card_name {
                    // Next line in the pair is the long name; but the format
                    // varies. Cheapest: just return the line after the colon.
                    if let Some(colon) = line.find(": ") {
                        return Some(line[colon + 2..].trim().to_string());
                    }
                }
            }
        }
    }
    None
}

pub fn query_os_mixer() -> Option<OsMixerInfo> {
    let info_out = run_pactl(&["info"])?;
    let mut mixer = parse_pactl_info(&info_out)?;

    // Override the global default spec with the actual default sink's spec,
    // and read its current Mute/Volume so we can surface OS-layer scaling.
    if let Some(list_out) = run_pactl(&["list", "sinks"]) {
        if let Some((fmt, ch, rate)) = sink_sample_spec(&list_out, &mixer.default_sink_name) {
            mixer.sink_format = fmt;
            mixer.sink_channels = ch;
            mixer.sink_rate = rate;
        }
        let (vol, muted) = sink_volume_and_mute(&list_out, &mixer.default_sink_name);
        mixer.sink_volume = vol;
        mixer.sink_muted = muted;
    }
    Some(mixer)
}

fn run_pactl(args: &[&str]) -> Option<String> {
    // Force C locale on the child so any future pactl release that decides to
    // localize field labels ("Mute:", "Volume:", "Sample Specification:",
    // "Default Sink:") doesn't break our parsers. The env mutation is scoped
    // to this child process only — does not affect SONE or any other app.
    let out = Command::new("pactl")
        .env("LC_ALL", "C")
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
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

    const PACTL_LIST_SINKS: &str = "\
Sink #59
\tState: SUSPENDED
\tName: alsa_output.usb-iFi.iec958-stereo
\tDescription: iFi HD USB Audio
\tDriver: PipeWire
\tSample Specification: s24le 2ch 96000Hz
\tProperties:
\t\talsa.card = \"5\"
\t\talsa.card_name = \"iFi (by AMR) HD USB Audio\"
\t\talsa.id = \"Audio\"

Sink #60
\tState: RUNNING
\tName: alsa_output.pci-0000_01_00.1.hdmi-stereo
\tSample Specification: float32le 2ch 48000Hz
\tProperties:
\t\talsa.card = \"0\"
\t\talsa.card_name = \"HDA NVidia\"
\t\talsa.id = \"NVidia\"
";

    #[test]
    fn finds_sink_sample_spec() {
        let spec = sink_sample_spec(PACTL_LIST_SINKS, "alsa_output.usb-iFi.iec958-stereo");
        assert_eq!(spec, Some(("s24le".to_string(), 2, 96000)));
    }

    #[test]
    fn finds_hdmi_sink_sample_spec() {
        let spec = sink_sample_spec(PACTL_LIST_SINKS, "alsa_output.pci-0000_01_00.1.hdmi-stereo");
        assert_eq!(spec, Some(("float32le".to_string(), 2, 48000)));
    }

    #[test]
    fn returns_none_for_unknown_sink_spec() {
        assert!(sink_sample_spec(PACTL_LIST_SINKS, "alsa_output.unknown").is_none());
    }

    #[test]
    fn finds_sink_alsa_id_by_name() {
        let id = sink_alsa_id(PACTL_LIST_SINKS, "alsa_output.usb-iFi.iec958-stereo");
        assert_eq!(id.as_deref(), Some("Audio"));
    }

    #[test]
    fn finds_hdmi_sink_alsa_id() {
        let id = sink_alsa_id(PACTL_LIST_SINKS, "alsa_output.pci-0000_01_00.1.hdmi-stereo");
        assert_eq!(id.as_deref(), Some("NVidia"));
    }

    #[test]
    fn returns_none_for_unknown_sink() {
        assert!(sink_alsa_id(PACTL_LIST_SINKS, "alsa_output.unknown").is_none());
    }

    #[test]
    fn discover_directalsa_uses_exclusive_device() {
        let card = discover_active_card(
            Some("DirectAlsa"),
            Some("hw:CARD=Audio,DEV=0"),
            None,
        );
        assert_eq!(card.as_deref(), Some("Audio"));
    }

    #[test]
    fn parse_alsa_card_handles_named_form() {
        assert_eq!(parse_alsa_card_from_device("hw:CARD=Audio,DEV=0").as_deref(), Some("Audio"));
        assert_eq!(parse_alsa_card_from_device("plughw:CARD=Audio,DEV=0").as_deref(), Some("Audio"));
        assert_eq!(parse_alsa_card_from_device("hw:CARD=Audio").as_deref(), Some("Audio"));
    }

    #[test]
    fn parse_alsa_card_rejects_garbage() {
        assert!(parse_alsa_card_from_device("default").is_none());
        assert!(parse_alsa_card_from_device("hw:").is_none());
        assert!(parse_alsa_card_from_device("not an alsa device").is_none());
    }

    #[test]
    fn discover_normal_uses_os_mixer_alsa_id() {
        let info = OsMixerInfo {
            server: "PipeWire".into(),
            default_sink_name: "alsa_output.usb-iFi.iec958-stereo".into(),
            sink_format: "s24le".into(),
            sink_rate: 96000,
            sink_channels: 2,
            sink_volume: 1.0,
            sink_muted: false,
        };
        // alsa.id resolution requires the list-sinks stdout — simulated via caller:
        let resolver = |sink: &str| {
            if sink == "alsa_output.usb-iFi.iec958-stereo" { Some("Audio".into()) } else { None }
        };
        let card = discover_active_card_with_resolver(Some("Normal"), None, Some(&info), &resolver);
        assert_eq!(card.as_deref(), Some("Audio"));
    }

    #[test]
    fn discover_returns_none_when_no_backend() {
        assert!(discover_active_card(None, None, None).is_none());
    }

    const PACTL_LIST_SINKS_WITH_VOLUME: &str = "\
Sink #2
\tState: RUNNING
\tName: alsa_output.usb-iFi.iec958-stereo
\tSample Specification: s24le 2ch 96000Hz
\tMute: no
\tVolume: front-left: 39322 /  60% / -13.31 dB,   front-right: 39322 /  60% / -13.31 dB
\t        balance 0.00
\tBase Volume: 65536 / 100% / 0.00 dB
\tProperties:
\t\talsa.card = \"5\"

Sink #3
\tState: SUSPENDED
\tName: alsa_output.muted-test
\tSample Specification: s16le 2ch 48000Hz
\tMute: yes
\tVolume: front-left: 65536 /  100% / 0.00 dB,   front-right: 65536 /  100% / 0.00 dB
\t        balance 0.00
\tBase Volume: 65536 / 100% / 0.00 dB

Sink #4
\tState: RUNNING
\tName: alsa_output.unity
\tSample Specification: s32le 2ch 48000Hz
\tMute: no
\tVolume: front-left: 65536 /  100% / 0.00 dB,   front-right: 65536 /  100% / 0.00 dB
\t        balance 0.00
\tBase Volume: 65536 / 100% / 0.00 dB
";

    #[test]
    fn parses_attenuated_sink_volume() {
        let (vol, muted) = sink_volume_and_mute(
            PACTL_LIST_SINKS_WITH_VOLUME,
            "alsa_output.usb-iFi.iec958-stereo",
        );
        // -13.31 dB → ~0.2158 multiplier
        assert!((vol - 0.2158).abs() < 0.001, "vol={vol}");
        assert!(!muted);
    }

    #[test]
    fn parses_muted_sink() {
        let (_vol, muted) =
            sink_volume_and_mute(PACTL_LIST_SINKS_WITH_VOLUME, "alsa_output.muted-test");
        assert!(muted);
    }

    #[test]
    fn parses_unity_sink_volume() {
        let (vol, muted) =
            sink_volume_and_mute(PACTL_LIST_SINKS_WITH_VOLUME, "alsa_output.unity");
        assert!((vol - 1.0).abs() < 1e-6, "vol={vol}");
        assert!(!muted);
    }

    #[test]
    fn returns_defaults_for_unknown_sink_volume() {
        let (vol, muted) =
            sink_volume_and_mute(PACTL_LIST_SINKS_WITH_VOLUME, "alsa_output.unknown");
        assert!((vol - 1.0).abs() < 1e-6);
        assert!(!muted);
    }

    #[test]
    fn ignores_base_volume_line() {
        // The "Base Volume" line is also "Base Volume: 65536 / 100% / 0.00 dB"
        // — if the parser accidentally matched it, the attenuated sink above
        // would still come back at 0 dB. That's covered by the attenuated
        // test, but pin the negative case explicitly:
        let only_base = "\
Sink #99
\tName: alsa_output.only-base
\tBase Volume: 65536 / 100% / 0.00 dB
";
        let (vol, muted) = sink_volume_and_mute(only_base, "alsa_output.only-base");
        // No Volume: line ever matched → default 1.0
        assert!((vol - 1.0).abs() < 1e-6);
        assert!(!muted);
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
