//! Pipeline probe: gathers ground-truth info about the audio pipeline
//! from /proc/asound (kernel hw_params) and pactl (OS mixer state and routing).
//! Called by the `refresh_signal_path` Tauri command and the modal's
//! 2 s heartbeat. Runs in the Tauri command handler thread — never on
//! the audio thread.

use serde::Serialize;
use std::collections::HashMap;

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
    /// Sink SONE's stream feeds.
    pub sink_name: String,
    /// Empty when unknown.
    pub sink_format: String,
    /// Rate the mixer runs at; None when it can't be determined.
    pub sink_rate: Option<u32>,
    pub sink_channels: u32,
    /// Linear amplitude multiplier the OS applies along the route (our
    /// stream, virtual sinks, the device) before the kernel write. 1.0 =
    /// unity. 0.0 = mute.
    pub sink_volume: f32,
    /// `sink_volume` on the cubic slider scale `pactl` and the GNOME/KDE
    /// volume widgets use. 100 = unity.
    pub sink_volume_percent: u32,
    pub sink_muted: bool,
    /// Virtual sinks between `sink_name` and the device, in order.
    pub virtual_route: Vec<VirtualHop>,
    /// Rate at the device; None when unknown.
    pub device_rate: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualHop {
    pub name: String,
    /// Rate this hop runs at; None when unknown.
    pub rate: Option<u32>,
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
        sink_name: default_sink_name.clone(),
        default_sink_name,
        sink_format,
        sink_rate: (sink_rate > 0).then_some(sink_rate),
        sink_channels,
        sink_volume: 1.0,
        sink_volume_percent: 100,
        sink_muted: false,
        virtual_route: Vec::new(),
        device_rate: None,
    })
}

/// Parse a block's `Mute:` and `Volume:` fields. Returns
/// (linear_amplitude_multiplier, slider_percent, muted).
///
/// Volume line format (PipeWire/Pulse):
///   Volume: front-left: 39322 /  60% / -13.31 dB,   front-right: 39322 / ...
///
/// We extract two numbers from the chosen channel:
///   - `dB` → linear amplitude (10^(dB/20)) used for alteration math
///   - `%`  → slider-scale percentage exactly as `pactl` printed it. This is
///     what the OS volume widget shows (cubic-mapped by default), so it's the
///     right number to surface in the UI even though the amplitude factor is
///     smaller (e.g. 25% slider = ~1.6% amplitude = -36 dB).
///
/// We pick the channel with the largest |dB| from 0 as the representative,
/// so any unbalanced cut surfaces honestly. `Base Volume:` lines are skipped.
pub fn object_volume(obj: &PactlObject) -> (f32, u32, bool) {
    let muted = obj.field("Mute").is_some_and(|m| m.eq_ignore_ascii_case("yes"));
    let mut volume: f32 = 1.0;
    let mut percent: u32 = 100;

    if let Some(rest) = obj.field("Volume") {
        let mut max_abs_db: f32 = 0.0;
        let mut chosen_db: f32 = 0.0;
        let mut chosen_percent: Option<u32> = None;
        for part in rest.split(',') {
            // Anchor on " dB" at the end of the channel segment.
            let Some(db_end) = part.rfind(" dB") else { continue };
            let before_db = &part[..db_end];
            let Some(last_slash) = before_db.rfind('/') else { continue };
            let db_str = before_db[last_slash + 1..].trim();
            let Ok(db) = db_str.parse::<f32>() else { continue };

            // Walk back from the slash-before-dB to find the "<N>%"
            // token sitting between two earlier slashes:
            // "<raw> / <N>% / <dB> dB".
            let part_percent: Option<u32> = (|| {
                let before_last_slash = &before_db[..last_slash];
                let pct_end = before_last_slash.rfind('%')?;
                let before_pct = &before_last_slash[..pct_end];
                let slash_before_pct = before_pct.rfind('/')?;
                before_last_slash[slash_before_pct + 1..pct_end]
                    .trim()
                    .parse::<f32>()
                    .ok()
                    .map(|f| f.round().max(0.0) as u32)
            })();

            if db.abs() > max_abs_db {
                max_abs_db = db.abs();
                chosen_db = db;
                chosen_percent = part_percent;
            }
        }
        if max_abs_db > 0.0 {
            volume = 10f32.powf(chosen_db / 20.0);
            percent = chosen_percent.unwrap_or_else(|| {
                // Fallback: PA's scale is cubic by default, so the
                // slider position is approximately cbrt(amplitude).
                (volume.cbrt() * 100.0).round().max(0.0) as u32
            });
        }
    }

    (volume, percent, muted)
}

/// Resolve any `<plugin>:<card-spec>` ALSA device string (hw, plughw, front,
/// hdmi, sysdefault, dmix, …) to its /proc/asound/<name> directory entry.
pub fn parse_alsa_card_from_device(device: &str) -> Option<String> {
    let body = device.split_once(':')?.1;

    if let Some(rest) = body.strip_prefix("CARD=") {
        let name = &rest[..rest.find(',').unwrap_or(rest.len())];
        return (!name.is_empty()).then(|| name.to_string());
    }

    let end = body.find(',').unwrap_or(body.len());
    card_index_to_name(body[..end].parse().ok()?)
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

/// One `Sink #N` / `Sink Input #N` block of `pactl list …` output.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct PactlObject {
    pub index: u32,
    pub fields: HashMap<String, String>,
    pub props: HashMap<String, String>,
}

impl PactlObject {
    pub fn field(&self, key: &str) -> Option<&str> {
        self.fields.get(key).map(String::as_str)
    }

    pub fn prop(&self, key: &str) -> Option<&str> {
        self.props.get(key).map(String::as_str)
    }

    pub fn sample_spec(&self) -> Option<(String, u32, u32)> {
        let (fmt, ch, rate) = parse_sample_spec(self.field("Sample Specification")?);
        (!fmt.is_empty() && rate > 0).then_some((fmt, ch, rate))
    }
}

/// Split `pactl list sinks|sink-inputs` output into blocks. `header` is the
/// block title without its ` #N` suffix ("Sink", "Sink Input").
pub fn parse_pactl_objects(stdout: &str, header: &str) -> Vec<PactlObject> {
    let mut out: Vec<PactlObject> = Vec::new();
    let mut in_props = false;
    for line in stdout.lines() {
        if let Some(index) = line
            .strip_prefix(header)
            .and_then(|r| r.strip_prefix(" #"))
            .and_then(|n| n.trim().parse().ok())
        {
            out.push(PactlObject { index, ..Default::default() });
            in_props = false;
            continue;
        }
        let Some(obj) = out.last_mut() else { continue };
        if let Some(rest) = line.strip_prefix("\t\t") {
            if in_props {
                if let Some((k, v)) = rest.split_once(" = ") {
                    obj.props.insert(k.trim().to_string(), v.trim().trim_matches('"').to_string());
                }
            }
        } else if let Some(rest) = line.strip_prefix('\t') {
            if rest.starts_with(char::is_whitespace) {
                continue;
            }
            if let Some((k, v)) = rest.split_once(':') {
                let k = k.trim();
                in_props = k == "Properties";
                obj.fields.insert(k.to_string(), v.trim().to_string());
            }
        }
    }
    out
}

fn strip_deleted(binary: &str) -> &str {
    binary.trim_end_matches(" (deleted)")
}

/// SONE's own playback stream. libpulse fills `application.process.id` with
/// getpid() (sandboxed PID under Flatpak, same as ours); the binary check
/// guards against PID collisions between sandboxes.
pub fn find_own_sink_input<'a>(
    inputs: &'a [PactlObject],
    pid: u32,
    binary: Option<&str>,
) -> Option<&'a PactlObject> {
    let pid = pid.to_string();
    inputs
        .iter()
        .filter(|i| i.prop("application.process.id") == Some(pid.as_str()))
        .filter(|i| match (binary, i.prop("application.process.binary")) {
            (Some(ours), Some(theirs)) => strip_deleted(ours) == strip_deleted(theirs),
            _ => true,
        })
        .max_by_key(|i| (i.field("Corked") == Some("no"), i.index))
}

#[derive(Debug, PartialEq)]
pub struct SinkRoute<'a> {
    /// Sink SONE's stream feeds.
    pub connected: &'a PactlObject,
    /// Device at the end of the route; None when it can't be determined.
    pub hardware: Option<&'a PactlObject>,
    /// Virtual sinks passed through before `hardware`, in order.
    pub virtual_sinks: Vec<&'a PactlObject>,
    /// Streams carrying a virtual sink's output on to the next sink.
    pub links: Vec<&'a PactlObject>,
}

const MAX_ROUTE_HOPS: usize = 8;

fn is_device(sink: &PactlObject) -> bool {
    sink.prop("device.api").is_some() || sink.prop("alsa.card").is_some()
}

/// Follow virtual sinks to the device. PipeWire modules (filter-chain,
/// loopback, echo-cancel, combine-stream) share `node.link-group` between a
/// virtual sink and the stream carrying its output; PulseAudio virtual sinks
/// name their master in `device.master_device`.
pub fn resolve_sink_route<'a>(
    start: u32,
    sinks: &'a [PactlObject],
    inputs: &'a [PactlObject],
    stream_active: bool,
) -> Option<SinkRoute<'a>> {
    let connected = sinks.iter().find(|s| s.index == start)?;
    let mut route = SinkRoute { connected, hardware: None, virtual_sinks: Vec::new(), links: Vec::new() };
    let mut cur = connected;
    for _ in 0..MAX_ROUTE_HOPS {
        if is_device(cur) {
            route.hardware = Some(cur);
            break;
        }
        route.virtual_sinks.push(cur);
        let next = match cur.prop("node.link-group") {
            Some(group) => {
                let outs: Vec<(&PactlObject, u32)> = inputs
                    .iter()
                    .filter(|i| i.prop("node.link-group") == Some(group))
                    .filter_map(|i| Some((i, i.field("Sink")?.parse().ok()?)))
                    .collect();
                let mut targets: Vec<u32> = outs.iter().map(|(_, t)| *t).collect();
                targets.sort_unstable();
                targets.dedup();
                match targets.as_slice() {
                    [t] => {
                        if let Some((link, _)) = outs.iter().find(|(_, s)| s == t) {
                            route.links.push(link);
                        }
                        sinks.iter().find(|s| s.index == *t)
                    }
                    _ => None,
                }
            }
            None => cur
                .prop("device.master_device")
                .and_then(|m| sinks.iter().find(|s| s.field("Name") == Some(m))),
        };
        match next {
            Some(s) if !route.virtual_sinks.iter().any(|v| v.index == s.index) => cur = s,
            _ => break,
        }
    }
    // EasyEffects (>= 8.2.9) links its effect nodes outside pactl's view;
    // while our stream plays, the only RUNNING device must be its output.
    let ends_in_easyeffects = route
        .virtual_sinks
        .last()
        .and_then(|s| s.prop("node.link-group"))
        == Some("ee_sink_group");
    if route.hardware.is_none() && stream_active && ends_in_easyeffects {
        let mut running = sinks.iter().filter(|s| is_device(s) && s.field("State") == Some("RUNNING"));
        if let (Some(only), None) = (running.next(), running.next()) {
            route.hardware = Some(only);
        }
    }
    Some(route)
}

/// Rate a PipeWire virtual sink is pinned to. echo-cancel always pins one
/// (48000 by default); filter-chain/loopback only with `audio.rate`.
fn fixed_rate(sink: &PactlObject) -> Option<u32> {
    sink.prop("audio.rate").and_then(|r| r.parse().ok()).filter(|r| *r > 0).or_else(|| {
        sink.prop("node.link-group")
            .is_some_and(|g| g.starts_with("echo-cancel-"))
            .then(|| sink.sample_spec().map(|(_, _, rate)| rate))
            .flatten()
    })
}

/// Fill the mixer from the route our stream takes. PipeWire virtual sinks
/// report a fixed float32 spec at the default rate and a suspended device
/// reports its fallback rate, so on PipeWire unpinned hops run at the
/// device's rate: kernel hw_params, else the device sink while RUNNING.
/// PulseAudio resamples into every sink, so each sink's spec is real.
pub fn apply_route(
    mixer: &mut OsMixerInfo,
    route: Option<&SinkRoute>,
    own: Option<&PactlObject>,
    dac: Option<&DacHwParams>,
) {
    let Some(route) = route else {
        mixer.sink_format.clear();
        mixer.sink_channels = 0;
        mixer.sink_rate = None;
        mixer.device_rate = None;
        mixer.sink_volume = 1.0;
        mixer.sink_volume_percent = 100;
        mixer.sink_muted = false;
        mixer.virtual_route.clear();
        return;
    };
    let pipewire = mixer.server == "PipeWire";
    let spec_rate = |s: &PactlObject| s.sample_spec().map(|(_, _, rate)| rate);

    if let Some(name) = route.connected.field("Name") {
        mixer.sink_name = name.to_string();
    }
    match route.connected.sample_spec() {
        Some((fmt, ch, _)) => {
            mixer.sink_format = fmt;
            mixer.sink_channels = ch;
        }
        None => mixer.sink_format.clear(),
    }

    let device_rate = match dac {
        Some(d) if d.state == HwParamsState::Active && d.rate > 0 => Some(d.rate),
        _ => route
            .hardware
            .filter(|h| h.field("State") == Some("RUNNING"))
            .and_then(spec_rate),
    };
    mixer.virtual_route = route
        .virtual_sinks
        .iter()
        .map(|s| VirtualHop {
            name: s.field("Description").or(s.field("Name")).unwrap_or("virtual sink").to_string(),
            rate: if pipewire { fixed_rate(s).or(device_rate) } else { spec_rate(s) },
        })
        .collect();
    mixer.sink_rate = match mixer.virtual_route.first() {
        Some(first) => first.rate,
        None if pipewire => device_rate,
        None => spec_rate(route.connected),
    };
    mixer.device_rate = device_rate;

    let (volume, muted) = if pipewire {
        let stages = own
            .into_iter()
            .chain(route.virtual_sinks.iter().copied())
            .chain(route.links.iter().copied())
            .chain(route.hardware);
        stages.fold((1.0f32, false), |(volume, muted), obj| {
            let (v, _, m) = object_volume(obj);
            // A hardware mixer attenuates in the DAC, not by scaling samples.
            let hw = obj
                .field("Flags")
                .is_some_and(|f| f.split_whitespace().any(|flag| flag == "HW_VOLUME_CTRL"));
            (if hw { volume } else { volume * v }, muted || m)
        })
    } else {
        // PulseAudio virtual sinks share their master's volume by default;
        // our own stream's mute applies regardless.
        let (v, _, m) = object_volume(route.hardware.unwrap_or(route.connected));
        (v, m || own.is_some_and(|o| object_volume(o).2))
    };
    mixer.sink_volume = volume;
    mixer.sink_volume_percent = (volume.cbrt() * 100.0).round().max(0.0) as u32;
    mixer.sink_muted = muted;
}

fn own_binary_name() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.file_name()?.to_str()?.to_string())
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

    /// One-shot refresh: probe all sources, push into tracker. Runs in the
    /// Tauri command handler thread; at most three pactl shell-outs. Never
    /// blocks on audio thread.
    pub fn refresh(&self) {
        // 1. Pad caps cells (mutex reads, very fast).
        let decoded = self.audio_player.snapshot_decoded_caps();
        let output = self.audio_player.snapshot_output_caps();

        // 2. OS mixer state via pactl. Best-effort; None on failure.
        let backend = self.signal_path.snapshot().backend;
        let normal = backend.as_deref() == Some("Normal");
        let mut mixer = run_pactl(&["info"]).as_deref().and_then(parse_pactl_info);
        let sinks = run_pactl(&["list", "sinks"])
            .as_deref()
            .map(|s| parse_pactl_objects(s, "Sink"))
            .unwrap_or_default();
        let inputs = if normal {
            run_pactl(&["list", "sink-inputs"])
                .as_deref()
                .map(|s| parse_pactl_objects(s, "Sink Input"))
                .unwrap_or_default()
        } else {
            Vec::new()
        };

        // 3. Route. Normal: only the sink our own stream feeds says anything
        //    about our audio — no linked stream, no claims. DirectAlsa: the
        //    default sink, for context only.
        let own = if normal {
            find_own_sink_input(&inputs, std::process::id(), own_binary_name().as_deref())
        } else {
            None
        };
        let start = if normal {
            own.and_then(|i| i.field("Sink")?.parse().ok())
        } else {
            mixer
                .as_ref()
                .and_then(|m| sinks.iter().find(|s| s.field("Name") == Some(m.default_sink_name.as_str())))
                .map(|s| s.index)
        };
        let stream_active = own.is_some_and(|i| i.field("Corked") == Some("no"));
        let route = start.and_then(|s| resolve_sink_route(s, &sinks, &inputs, stream_active));

        // 4. Kernel hw_params of the device actually in use.
        let card = match backend.as_deref() {
            Some("DirectAlsa") => self
                .audio_player
                .exclusive_device()
                .as_deref()
                .and_then(parse_alsa_card_from_device)
                .map(|c| (c, None)),
            Some("Normal") => route
                .as_ref()
                .and_then(|r| r.hardware)
                .and_then(|h| sink_alsa_location(h, &card_index_to_name)),
            _ => None,
        };
        let dac = card.and_then(|(name, pcm)| read_hw_params(&name, pcm));

        if let Some(m) = mixer.as_mut() {
            apply_route(m, route.as_ref(), own, if normal { dac.as_ref() } else { None });
        }
        self.signal_path.apply_probe(decoded, output, mixer, dac);
    }
}

/// Read kernel hw_params for the card's playback PCM. With `preferred_pcm`
/// (the sink's `alsa.device`) only that PCM is read, first active
/// subdevice wins; without it the legacy pcm0..3 grid is scanned.
pub fn read_hw_params(card_name: &str, preferred_pcm: Option<u32>) -> Option<DacHwParams> {
    read_hw_params_at("/proc/asound", card_name, preferred_pcm)
}

fn read_hw_params_at(root: &str, card_name: &str, preferred_pcm: Option<u32>) -> Option<DacHwParams> {
    let base = format!("{root}/{card_name}");
    let to_dac = |pcm: u32, parsed: ParsedHwParams| DacHwParams {
        card_index: read_card_index(card_name).unwrap_or(0),
        card_name: read_card_longname(card_name).unwrap_or_else(|| card_name.to_string()),
        pcm_device: format!("hw:CARD={card_name},DEV={pcm}"),
        format: parsed.format,
        rate: parsed.rate,
        channels: parsed.channels,
        period_size: parsed.period_size,
        buffer_size: parsed.buffer_size,
        state: parsed.state,
    };

    if let Some(pcm) = preferred_pcm {
        let mut closed = None;
        for sub in 0..2u32 {
            let path = format!("{base}/pcm{pcm}p/sub{sub}/hw_params");
            let Ok(contents) = std::fs::read_to_string(&path) else { continue };
            let Some(parsed) = parse_hw_params_file(&contents) else { continue };
            if parsed.state == HwParamsState::Active {
                return Some(to_dac(pcm, parsed));
            }
            if closed.is_none() {
                closed = Some(parsed);
            }
        }
        return closed.map(|p| to_dac(pcm, p));
    }

    // Probe a small grid of pcm/sub combinations (covers ~all hardware).
    for pcm in 0..4u32 {
        for sub in 0..2u32 {
            let path = format!("{base}/pcm{pcm}p/sub{sub}/hw_params");
            let Ok(contents) = std::fs::read_to_string(&path) else { continue };
            let parsed = parse_hw_params_file(&contents)?;
            if parsed.state == HwParamsState::Closed && (pcm != 0 || sub != 0) {
                continue; // try the next subdevice
            }
            return Some(to_dac(pcm, parsed));
        }
    }
    None
}

/// `/proc/asound` directory name and PCM device of an ALSA-backed sink.
pub fn sink_alsa_location(
    sink: &PactlObject,
    card_name_for_index: &dyn Fn(u32) -> Option<String>,
) -> Option<(String, Option<u32>)> {
    let card = sink
        .prop("alsa.card")
        .and_then(|c| c.parse().ok())
        .and_then(card_name_for_index)
        .or_else(|| sink.prop("alsa.id").map(str::to_string))?;
    let device = sink.prop("alsa.device").and_then(|d| d.parse().ok());
    Some((card, device))
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
        assert_eq!(info.sink_rate, Some(48000));
        assert_eq!(info.sink_channels, 2);
    }

    #[test]
    fn detects_pulseaudio_server() {
        let info = parse_pactl_info(PACTL_INFO_PULSE).unwrap();
        assert_eq!(info.server, "PulseAudio");
        assert_eq!(info.sink_rate, Some(44100));
    }

    #[test]
    fn parse_pactl_info_returns_none_when_no_sink() {
        let stripped = "Server Name: PulseAudio\nDefault Sample Specification: s16le 2ch 44100Hz\n";
        assert!(parse_pactl_info(stripped).is_none());
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

    fn volume_of(text: &str, name: &str) -> (f32, u32, bool) {
        let sinks = parse_pactl_objects(text, "Sink");
        object_volume(sinks.iter().find(|s| s.field("Name") == Some(name)).unwrap())
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

Sink #5
\tState: RUNNING
\tName: alsa_output.slider-25
\tSample Specification: s32le 2ch 48000Hz
\tMute: no
\tVolume: front-left: 16384 /  25% / -36.12 dB,   front-right: 16384 /  25% / -36.12 dB
\t        balance 0.00
\tBase Volume: 65536 / 100% / 0.00 dB
";

    #[test]
    fn parses_attenuated_sink_volume() {
        let (vol, pct, muted) = volume_of(
            PACTL_LIST_SINKS_WITH_VOLUME,
            "alsa_output.usb-iFi.iec958-stereo",
        );
        // -13.31 dB → ~0.2158 amplitude, but pactl prints 60% on its slider scale.
        assert!((vol - 0.2158).abs() < 0.001, "vol={vol}");
        assert_eq!(pct, 60);
        assert!(!muted);
    }

    #[test]
    fn parses_muted_sink() {
        let (_vol, _pct, muted) =
            volume_of(PACTL_LIST_SINKS_WITH_VOLUME, "alsa_output.muted-test");
        assert!(muted);
    }

    #[test]
    fn parses_unity_sink_volume() {
        let (vol, pct, muted) =
            volume_of(PACTL_LIST_SINKS_WITH_VOLUME, "alsa_output.unity");
        assert!((vol - 1.0).abs() < 1e-6, "vol={vol}");
        assert_eq!(pct, 100);
        assert!(!muted);
    }

    #[test]
    fn slider_percent_matches_pactl_not_amplitude() {
        // 25% on a cubic slider = 0.25^3 ≈ 0.0156 amplitude = -36.12 dB.
        // The display percent must mirror pactl's "25%", not the 2% you'd
        // get by treating the amplitude factor as a percentage.
        let (vol, pct, muted) =
            volume_of(PACTL_LIST_SINKS_WITH_VOLUME, "alsa_output.slider-25");
        assert!((vol - 0.01567).abs() < 0.001, "vol={vol}");
        assert_eq!(pct, 25);
        assert!(!muted);
    }

    #[test]
    fn object_without_volume_is_unity() {
        let sinks = parse_pactl_objects("Sink #1\n\tName: x\n", "Sink");
        assert_eq!(object_volume(&sinks[0]), (1.0, 100, false));
    }

    #[test]
    fn minus_inf_db_is_silence() {
        let sinks = parse_pactl_objects(
            "Sink #1\n\tName: x\n\tVolume: front-left: 0 /   0% / -inf dB,   front-right: 0 /   0% / -inf dB\n",
            "Sink",
        );
        let (vol, pct, _) = object_volume(&sinks[0]);
        assert_eq!(vol, 0.0);
        assert_eq!(pct, 0);
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
        let (vol, pct, muted) = volume_of(only_base, "alsa_output.only-base");
        // No Volume: line ever matched → default 1.0 / 100%
        assert!((vol - 1.0).abs() < 1e-6);
        assert_eq!(pct, 100);
        assert!(!muted);
    }

    const CHAIN_SINKS: &str = "\
Sink #62
\tState: RUNNING
\tName: alsa_output.usb-ULTRASONE_NAOS_MICRO_NAOS_MICRO-00.analog-stereo
\tDescription: NAOS MICRO Analog Stereo
\tDriver: PipeWire
\tSample Specification: s32le 2ch 44100Hz
\tChannel Map: front-left,front-right
\tMute: no
\tVolume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB
\t        balance 0.00
\tBase Volume: 65536 / 100% / 0.00 dB
\tFlags: HARDWARE DECIBEL_VOLUME LATENCY
\tProperties:
\t\talsa.card = \"3\"
\t\talsa.device = \"0\"
\t\talsa.id = \"MICRO\"
\t\tdevice.api = \"alsa\"
\t\tmedia.class = \"Audio/Sink\"
\tPorts:
\t\tanalog-output: Analog Output (type: Unknown, priority: 9900, availability unknown)
\tActive Port: analog-output
\tFormats:
\t\tpcm

Sink #70
\tState: RUNNING
\tName: effect_input.bs2b
\tDescription: bs2b
\tDriver: PipeWire
\tSample Specification: float32le 2ch 48000Hz
\tMute: no
\tVolume: front-left: 39322 /  60% / -13.31 dB,   front-right: 39322 /  60% / -13.31 dB
\t        balance 0.00
\tProperties:
\t\tnode.name = \"effect_input.bs2b\"
\t\tnode.link-group = \"filter-chain-1234-20\"
\t\tnode.virtual = \"true\"
\t\tmedia.class = \"Audio/Sink\"

Sink #72
\tState: RUNNING
\tName: true_stereo_brir
\tDescription: True Stereo BRIR
\tDriver: PipeWire
\tSample Specification: float32le 2ch 48000Hz
\tMute: no
\tVolume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB
\tProperties:
\t\tnode.link-group = \"filter-chain-1234-22\"
\t\tnode.virtual = \"true\"
\t\tmedia.class = \"Audio/Sink\"
";

    const CHAIN_INPUTS: &str = "\
Sink Input #80
\tDriver: PipeWire
\tClient: n/a
\tSink: 72
\tSample Specification: float32le 2ch 48000Hz
\tCorked: no
\tMute: no
\tVolume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB
\tProperties:
\t\tnode.name = \"effect_output.bs2b\"
\t\tnode.link-group = \"filter-chain-1234-20\"
\t\tmedia.class = \"Stream/Output/Audio\"

Sink Input #81
\tDriver: PipeWire
\tClient: n/a
\tSink: 62
\tSample Specification: float32le 2ch 48000Hz
\tCorked: no
\tMute: no
\tVolume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB
\tProperties:
\t\tnode.name = \"true_stereo_brir_out\"
\t\tnode.link-group = \"filter-chain-1234-22\"
\t\tmedia.class = \"Stream/Output/Audio\"

Sink Input #90
\tDriver: PipeWire
\tClient: 89
\tSink: 70
\tSample Specification: s16le 2ch 44100Hz
\tCorked: no
\tMute: no
\tVolume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB
\tProperties:
\t\tapplication.name = \"sone\"
\t\tapplication.process.id = \"4242\"
\t\tapplication.process.binary = \"sone\"
\t\tmedia.class = \"Stream/Output/Audio\"

Sink Input #91
\tDriver: PipeWire
\tClient: 95
\tSink: 62
\tSample Specification: float32le 2ch 48000Hz
\tCorked: no
\tProperties:
\t\tapplication.name = \"Firefox\"
\t\tapplication.process.id = \"4242\"
\t\tapplication.process.binary = \"firefox\"
";

    fn chain() -> (Vec<PactlObject>, Vec<PactlObject>) {
        (
            parse_pactl_objects(CHAIN_SINKS, "Sink"),
            parse_pactl_objects(CHAIN_INPUTS, "Sink Input"),
        )
    }

    #[test]
    fn parses_pactl_blocks() {
        let (sinks, inputs) = chain();
        assert_eq!(sinks.iter().map(|s| s.index).collect::<Vec<_>>(), vec![62, 70, 72]);
        assert_eq!(inputs.iter().map(|s| s.index).collect::<Vec<_>>(), vec![80, 81, 90, 91]);
        let dac = &sinks[0];
        assert_eq!(dac.field("Name"), Some("alsa_output.usb-ULTRASONE_NAOS_MICRO_NAOS_MICRO-00.analog-stereo"));
        assert_eq!(dac.prop("alsa.card"), Some("3"));
        assert_eq!(dac.sample_spec(), Some(("s32le".to_string(), 2, 44100)));
        // Ports/Formats entries after Properties must not leak into props.
        assert!(!dac.props.keys().any(|k| k.contains("analog-output") || k == "pcm"));
        // "\t        balance 0.00" is a continuation, not a field.
        assert!(!dac.fields.keys().any(|k| k.contains("balance")));
        assert_eq!(inputs[2].field("Sink"), Some("70"));
    }

    #[test]
    fn sink_header_does_not_match_sink_input_blocks() {
        assert!(parse_pactl_objects(CHAIN_INPUTS, "Sink").is_empty());
    }

    #[test]
    fn own_stream_matches_pid_and_binary() {
        let (_, inputs) = chain();
        assert_eq!(find_own_sink_input(&inputs, 4242, Some("sone")).map(|i| i.index), Some(90));
    }

    #[test]
    fn own_stream_rejects_pid_collision_with_other_binary() {
        let (_, inputs) = chain();
        assert!(find_own_sink_input(&inputs, 4242, Some("spotify")).is_none());
    }

    #[test]
    fn own_stream_ignores_deleted_suffix() {
        let (_, inputs) = chain();
        assert_eq!(find_own_sink_input(&inputs, 4242, Some("sone (deleted)")).map(|i| i.index), Some(90));
    }

    #[test]
    fn own_stream_prefers_uncorked_then_newest() {
        let text = "\
Sink Input #5
\tSink: 1
\tCorked: no
\tProperties:
\t\tapplication.process.id = \"7\"
Sink Input #6
\tSink: 2
\tCorked: yes
\tProperties:
\t\tapplication.process.id = \"7\"
Sink Input #4
\tSink: 3
\tCorked: no
\tProperties:
\t\tapplication.process.id = \"7\"
";
        let inputs = parse_pactl_objects(text, "Sink Input");
        assert_eq!(find_own_sink_input(&inputs, 7, None).map(|i| i.index), Some(5));
    }

    #[test]
    fn route_walks_filter_chain_to_hardware() {
        let (sinks, inputs) = chain();
        let r = resolve_sink_route(70, &sinks, &inputs, true).unwrap();
        assert_eq!(r.connected.index, 70);
        assert_eq!(r.hardware.map(|h| h.index), Some(62));
        assert_eq!(r.virtual_sinks.iter().map(|s| s.index).collect::<Vec<_>>(), vec![70, 72]);
        assert_eq!(r.links.iter().map(|s| s.index).collect::<Vec<_>>(), vec![80, 81]);
    }

    #[test]
    fn route_direct_to_hardware_has_no_hops() {
        let (sinks, inputs) = chain();
        let r = resolve_sink_route(62, &sinks, &inputs, true).unwrap();
        assert_eq!(r.hardware.map(|h| h.index), Some(62));
        assert!(r.virtual_sinks.is_empty());
        assert!(r.links.is_empty());
    }

    #[test]
    fn route_none_for_unlinked_stream() {
        // pipewire-pulse reports an unlinked stream as Sink: 4294967295.
        let (sinks, inputs) = chain();
        assert!(resolve_sink_route(u32::MAX, &sinks, &inputs, true).is_none());
    }

    #[test]
    fn route_follows_pulseaudio_master_device() {
        let sinks = parse_pactl_objects("\
Sink #1
\tName: alsa_output.dac
\tProperties:
\t\talsa.card = \"1\"
\t\tdevice.api = \"alsa\"
Sink #2
\tName: eq_sink
\tDescription: Equalizer
\tProperties:
\t\tdevice.master_device = \"alsa_output.dac\"
", "Sink");
        let r = resolve_sink_route(2, &sinks, &[], true).unwrap();
        assert_eq!(r.hardware.map(|h| h.index), Some(1));
        assert_eq!(r.virtual_sinks.iter().map(|s| s.index).collect::<Vec<_>>(), vec![2]);
    }

    const EE_SINKS: &str = "\
Sink #10
\tState: RUNNING
\tName: easyeffects_sink
\tDescription: Easy Effects Sink
\tSample Specification: float32le 2ch 48000Hz
\tProperties:
\t\tnode.link-group = \"ee_sink_group\"
Sink #11
\tState: RUNNING
\tName: alsa_output.dac
\tSample Specification: s32le 2ch 48000Hz
\tProperties:
\t\talsa.card = \"1\"
\t\tdevice.api = \"alsa\"
Sink #12
\tState: SUSPENDED
\tName: alsa_output.hdmi
\tProperties:
\t\talsa.card = \"0\"
\t\tdevice.api = \"alsa\"
";

    #[test]
    fn route_infers_only_running_device_when_playing() {
        // EasyEffects >= 8.2.9: link-group set, but its effect nodes are not sink-inputs.
        let sinks = parse_pactl_objects(EE_SINKS, "Sink");
        let r = resolve_sink_route(10, &sinks, &[], true).unwrap();
        assert_eq!(r.hardware.map(|h| h.index), Some(11));
        assert_eq!(r.virtual_sinks.iter().map(|s| s.index).collect::<Vec<_>>(), vec![10]);
    }

    #[test]
    fn route_no_inference_when_paused_or_ambiguous() {
        let sinks = parse_pactl_objects(EE_SINKS, "Sink");
        assert!(resolve_sink_route(10, &sinks, &[], false).unwrap().hardware.is_none());
        let both = EE_SINKS.replace("State: SUSPENDED", "State: RUNNING");
        let sinks = parse_pactl_objects(&both, "Sink");
        assert!(resolve_sink_route(10, &sinks, &[], true).unwrap().hardware.is_none());
    }

    #[test]
    fn route_no_inference_outside_easyeffects() {
        // A filter-chain whose output stream isn't linked, or a null sink
        // captured by OBS: never borrow another app's running device.
        for group in ["filter-chain-1-2", ""] {
            let text = EE_SINKS.replace("ee_sink_group", group);
            let sinks = parse_pactl_objects(&text, "Sink");
            assert!(resolve_sink_route(10, &sinks, &[], true).unwrap().hardware.is_none(), "group={group:?}");
        }
    }

    #[test]
    fn route_stops_on_fan_out() {
        // combine-stream: one virtual sink feeding two devices.
        let sinks = parse_pactl_objects("\
Sink #1
\tName: combined
\tProperties:
\t\tnode.link-group = \"combine-x\"
Sink #2
\tName: dac_a
\tProperties:
\t\tdevice.api = \"alsa\"
Sink #3
\tName: dac_b
\tProperties:
\t\tdevice.api = \"alsa\"
", "Sink");
        let inputs = parse_pactl_objects("\
Sink Input #20
\tSink: 2
\tProperties:
\t\tnode.link-group = \"combine-x\"
Sink Input #21
\tSink: 3
\tProperties:
\t\tnode.link-group = \"combine-x\"
", "Sink Input");
        let r = resolve_sink_route(1, &sinks, &inputs, false).unwrap();
        assert!(r.hardware.is_none());
        assert_eq!(r.virtual_sinks.len(), 1);
    }

    #[test]
    fn route_terminates_on_cycle() {
        let sinks = parse_pactl_objects("\
Sink #1
\tName: a
\tProperties:
\t\tnode.link-group = \"g1\"
Sink #2
\tName: b
\tProperties:
\t\tnode.link-group = \"g2\"
", "Sink");
        let inputs = parse_pactl_objects("\
Sink Input #11
\tSink: 2
\tProperties:
\t\tnode.link-group = \"g1\"
Sink Input #12
\tSink: 1
\tProperties:
\t\tnode.link-group = \"g2\"
", "Sink Input");
        let r = resolve_sink_route(1, &sinks, &inputs, false).unwrap();
        assert!(r.hardware.is_none());
        assert_eq!(r.virtual_sinks.iter().map(|s| s.index).collect::<Vec<_>>(), vec![1, 2]);
    }

    #[test]
    fn route_treats_bluetooth_sink_as_hardware() {
        let sinks = parse_pactl_objects("\
Sink #5
\tName: bluez_output.AA_BB.1
\tProperties:
\t\tdevice.api = \"bluez5\"
", "Sink");
        let r = resolve_sink_route(5, &sinks, &[], true).unwrap();
        assert_eq!(r.hardware.map(|h| h.index), Some(5));
    }

    #[test]
    fn alsa_location_prefers_card_index() {
        let (sinks, _) = chain();
        let loc = sink_alsa_location(&sinks[0], &|i| (i == 3).then(|| "Generic_1".to_string()));
        assert_eq!(loc, Some(("Generic_1".to_string(), Some(0))));
    }

    #[test]
    fn alsa_location_falls_back_to_alsa_id() {
        let (sinks, _) = chain();
        let loc = sink_alsa_location(&sinks[0], &|_| None);
        assert_eq!(loc, Some(("MICRO".to_string(), Some(0))));
    }

    #[test]
    fn alsa_location_none_for_bluetooth() {
        let sinks = parse_pactl_objects("Sink #5\n\tName: bt\n\tProperties:\n\t\tdevice.api = \"bluez5\"\n", "Sink");
        assert!(sink_alsa_location(&sinks[0], &|_| Some("x".into())).is_none());
    }

    fn write_pcm(root: &std::path::Path, card: &str, pcm: u32, sub: u32, contents: &str) {
        let dir = root.join(card).join(format!("pcm{pcm}p")).join(format!("sub{sub}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("hw_params"), contents).unwrap();
    }

    #[test]
    fn preferred_pcm_reads_that_device() {
        let tmp = tempfile::tempdir().unwrap();
        write_pcm(tmp.path(), "NVidia", 0, 0, CLOSED);
        write_pcm(tmp.path(), "NVidia", 7, 0, ACTIVE_HW_PARAMS_S16);
        let p = read_hw_params_at(tmp.path().to_str().unwrap(), "NVidia", Some(7)).unwrap();
        assert_eq!(p.state, HwParamsState::Active);
        assert_eq!(p.rate, 44100);
        assert_eq!(p.pcm_device, "hw:CARD=NVidia,DEV=7");
    }

    #[test]
    fn preferred_pcm_uses_active_subdevice() {
        let tmp = tempfile::tempdir().unwrap();
        write_pcm(tmp.path(), "Audio", 0, 0, CLOSED);
        write_pcm(tmp.path(), "Audio", 0, 1, ACTIVE_HW_PARAMS);
        let p = read_hw_params_at(tmp.path().to_str().unwrap(), "Audio", Some(0)).unwrap();
        assert_eq!(p.state, HwParamsState::Active);
        assert_eq!(p.rate, 96000);
    }

    #[test]
    fn preferred_pcm_closed_reports_closed() {
        let tmp = tempfile::tempdir().unwrap();
        write_pcm(tmp.path(), "Audio", 0, 0, CLOSED);
        let p = read_hw_params_at(tmp.path().to_str().unwrap(), "Audio", Some(0)).unwrap();
        assert_eq!(p.state, HwParamsState::Closed);
    }

    #[test]
    fn preferred_pcm_missing_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_hw_params_at(tmp.path().to_str().unwrap(), "Audio", Some(3)).is_none());
    }

    #[test]
    fn default_scan_keeps_pcm0_sub0_closed_semantics() {
        // DirectAlsa path (preferred = None) must behave exactly as before:
        // pcm0/sub0 closed is reported as Closed without scanning further.
        let tmp = tempfile::tempdir().unwrap();
        write_pcm(tmp.path(), "Audio", 0, 0, CLOSED);
        write_pcm(tmp.path(), "Audio", 1, 0, ACTIVE_HW_PARAMS);
        let p = read_hw_params_at(tmp.path().to_str().unwrap(), "Audio", None).unwrap();
        assert_eq!(p.state, HwParamsState::Closed);
    }

    fn pw_mixer() -> OsMixerInfo {
        parse_pactl_info(PACTL_INFO_PIPEWIRE).unwrap()
    }

    fn active_dac(rate: u32) -> DacHwParams {
        DacHwParams {
            card_index: 3,
            card_name: "NAOS".into(),
            pcm_device: "hw:CARD=MICRO,DEV=0".into(),
            format: "S32_LE".into(),
            rate,
            channels: 2,
            period_size: 1024,
            buffer_size: 4096,
            state: HwParamsState::Active,
        }
    }

    fn hop(name: &str, rate: Option<u32>) -> VirtualHop {
        VirtualHop { name: name.into(), rate }
    }

    fn mixer_for(sinks_text: &str, inputs_text: &str, start: u32, server: OsMixerInfo, dac: Option<&DacHwParams>) -> OsMixerInfo {
        let sinks = parse_pactl_objects(sinks_text, "Sink");
        let inputs = parse_pactl_objects(inputs_text, "Sink Input");
        let own = find_own_sink_input(&inputs, 4242, Some("sone"));
        let route = resolve_sink_route(start, &sinks, &inputs, true);
        let mut m = server;
        apply_route(&mut m, route.as_ref(), own, dac);
        m
    }

    #[test]
    fn pipewire_virtual_route_uses_device_rate() {
        // Issue #244: virtual sinks claim float32le/48000, device runs 44100.
        let m = mixer_for(CHAIN_SINKS, CHAIN_INPUTS, 70, pw_mixer(), Some(&active_dac(44100)));
        assert_eq!(m.sink_name, "effect_input.bs2b");
        assert_eq!(m.sink_format, "float32le");
        assert_eq!(m.sink_rate, Some(44100));
        assert_eq!(m.virtual_route, vec![hop("bs2b", Some(44100)), hop("True Stereo BRIR", Some(44100))]);
    }

    #[test]
    fn pipewire_fixed_rate_hop_keeps_its_rate() {
        let fixed = CHAIN_SINKS.replace(
            "\t\tnode.name = \"effect_input.bs2b\"\n",
            "\t\tnode.name = \"effect_input.bs2b\"\n\t\taudio.rate = \"48000\"\n",
        );
        let m = mixer_for(&fixed, CHAIN_INPUTS, 70, pw_mixer(), Some(&active_dac(44100)));
        assert_eq!(m.sink_rate, Some(48000));
        assert_eq!(m.virtual_route, vec![hop("bs2b", Some(48000)), hop("True Stereo BRIR", Some(44100))]);
    }

    #[test]
    fn echo_cancel_hop_is_fixed_rate() {
        let ec = CHAIN_SINKS.replace("filter-chain-1234-22", "echo-cancel-1234-22");
        let m = mixer_for(&ec, &CHAIN_INPUTS.replace("filter-chain-1234-22", "echo-cancel-1234-22"), 70, pw_mixer(), Some(&active_dac(44100)));
        assert_eq!(m.virtual_route, vec![hop("bs2b", Some(44100)), hop("True Stereo BRIR", Some(48000))]);
    }

    #[test]
    fn pipewire_rate_from_running_device_sink_without_hw_params() {
        let m = mixer_for(CHAIN_SINKS, CHAIN_INPUTS, 70, pw_mixer(), None);
        assert_eq!(m.sink_rate, Some(44100)); // NAOS sink is RUNNING at 44100
    }

    #[test]
    fn pipewire_rate_unknown_when_device_suspended() {
        let suspended = CHAIN_SINKS.replacen("State: RUNNING", "State: SUSPENDED", 1);
        let mut closed = active_dac(48000);
        closed.state = HwParamsState::Closed;
        let m = mixer_for(&suspended, CHAIN_INPUTS, 70, pw_mixer(), Some(&closed));
        assert_eq!(m.sink_rate, None);
        assert_eq!(m.virtual_route, vec![hop("bs2b", None), hop("True Stereo BRIR", None)]);
    }

    #[test]
    fn pipewire_rate_unknown_when_hardware_unresolved() {
        // EasyEffects with two running devices: nothing to infer.
        let both = EE_SINKS.replace("State: SUSPENDED", "State: RUNNING");
        let m = mixer_for(&both, "", 10, pw_mixer(), None);
        assert_eq!(m.sink_rate, None);
        assert_eq!(m.sink_format, "float32le");
        assert_eq!(m.virtual_route, vec![hop("Easy Effects Sink", None)]);
    }

    #[test]
    fn pipewire_rate_from_running_non_alsa_device() {
        let text = "\
Sink #5
\tState: RUNNING
\tName: bluez_output.AA_BB.1
\tSample Specification: s16le 2ch 44100Hz
\tProperties:
\t\tdevice.api = \"bluez5\"
";
        let m = mixer_for(text, "", 5, pw_mixer(), None);
        assert_eq!(m.sink_rate, Some(44100));
    }

    #[test]
    fn pulseaudio_uses_each_sinks_own_spec() {
        let m = mixer_for(CHAIN_SINKS, CHAIN_INPUTS, 70, parse_pactl_info(PACTL_INFO_PULSE).unwrap(), Some(&active_dac(44100)));
        assert_eq!(m.sink_rate, Some(48000));
        assert_eq!(m.virtual_route, vec![hop("bs2b", Some(48000)), hop("True Stereo BRIR", Some(48000))]);
    }

    #[test]
    fn no_claims_without_route() {
        let mut m = pw_mixer();
        apply_route(&mut m, None, None, Some(&active_dac(44100)));
        assert_eq!(m.sink_format, "");
        assert_eq!(m.sink_channels, 0);
        assert_eq!(m.sink_rate, None);
        assert_eq!(m.device_rate, None);
        assert!(m.virtual_route.is_empty());
        assert_eq!((m.sink_volume, m.sink_volume_percent, m.sink_muted), (1.0, 100, false));
    }

    #[test]
    fn volume_multiplies_along_route() {
        // Our stream at 50% (0.125) × bs2b at 60% (0.2158) → slider-equivalent 30%.
        let inputs = CHAIN_INPUTS.replacen(
            "\tCorked: no\n\tMute: no\n\tVolume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB\n\tProperties:\n\t\tapplication.name = \"sone\"",
            "\tCorked: no\n\tMute: no\n\tVolume: front-left: 32768 /  50% / -18.06 dB,   front-right: 32768 /  50% / -18.06 dB\n\tProperties:\n\t\tapplication.name = \"sone\"",
            1,
        );
        assert_ne!(inputs, CHAIN_INPUTS, "fixture edit must apply");
        let m = mixer_for(CHAIN_SINKS, &inputs, 70, pw_mixer(), Some(&active_dac(44100)));
        assert_eq!(m.sink_volume_percent, 30);
        assert!((m.sink_volume - 0.125 * 0.2158).abs() < 0.001, "vol={}", m.sink_volume);
        assert!(!m.sink_muted);
    }

    #[test]
    fn mute_anywhere_on_route() {
        let muted_dac = CHAIN_SINKS.replacen("\tMute: no", "\tMute: yes", 1); // NAOS device sink
        let m = mixer_for(&muted_dac, CHAIN_INPUTS, 70, pw_mixer(), Some(&active_dac(44100)));
        assert!(m.sink_muted);
    }

    #[test]
    fn hardware_volume_is_not_sample_scaling() {
        let hw = CHAIN_SINKS
            .replacen("Flags: HARDWARE DECIBEL_VOLUME LATENCY", "Flags: HARDWARE HW_VOLUME_CTRL DECIBEL_VOLUME LATENCY", 1)
            .replacen(
                "\tVolume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB",
                "\tVolume: front-left: 26214 /  40% / -23.88 dB,   front-right: 26214 /  40% / -23.88 dB",
                1,
            );
        assert_ne!(hw, CHAIN_SINKS, "fixture edit must apply");
        let m = mixer_for(&hw, CHAIN_INPUTS, 70, pw_mixer(), Some(&active_dac(44100)));
        assert_eq!(m.sink_volume_percent, 60); // bs2b only; the DAC's 40% is a hardware mixer
    }

    #[test]
    fn pulseaudio_volume_is_device_sinks_only() {
        // bs2b at 60% would be double-counted under PA volume sharing.
        let m = mixer_for(CHAIN_SINKS, CHAIN_INPUTS, 70, parse_pactl_info(PACTL_INFO_PULSE).unwrap(), Some(&active_dac(44100)));
        assert_eq!(m.sink_volume_percent, 100);
        assert!(!m.sink_muted);
    }

    #[test]
    fn pulseaudio_respects_own_stream_mute() {
        let inputs = CHAIN_INPUTS.replacen(
            "\tCorked: no\n\tMute: no\n\tVolume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB\n\tProperties:\n\t\tapplication.name = \"sone\"",
            "\tCorked: no\n\tMute: yes\n\tVolume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB\n\tProperties:\n\t\tapplication.name = \"sone\"",
            1,
        );
        assert_ne!(inputs, CHAIN_INPUTS, "fixture edit must apply");
        let m = mixer_for(CHAIN_SINKS, &inputs, 70, parse_pactl_info(PACTL_INFO_PULSE).unwrap(), Some(&active_dac(44100)));
        assert!(m.sink_muted);
    }

    #[test]
    fn device_rate_reported_without_hw_params() {
        let m = mixer_for(CHAIN_SINKS, CHAIN_INPUTS, 70, pw_mixer(), None);
        assert_eq!(m.device_rate, Some(44100));
    }

    #[test]
    fn parse_pactl_info_seeds_sink_name_with_default() {
        let info = pw_mixer();
        assert_eq!(info.sink_name, info.default_sink_name);
        assert!(info.virtual_route.is_empty());
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
