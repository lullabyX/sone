use crate::signal_path::SignalPathTracker;
use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as gst_app;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use tauri::Emitter;

/// Read the real GStreamer registry.
///
/// `gst::init()` is idempotent, and `main.rs` sets `GST_PLUGIN_PATH` before
/// `run()`, so calling this from `AppState::new` sees the same registry the
/// audio thread will. Note this adds a registry scan to the startup path,
/// where today `gst::init()` runs only on the audio thread.
pub fn probe_host_caps() -> crate::proxy::HostCaps {
    if let Err(e) = gst::init() {
        // A registry that cannot be read is not a reason to assume the best.
        // Reporting nothing present makes `route()` refuse the audio
        // capabilities, so the user is told rather than played unproxied.
        log::error!("[audio] GStreamer init failed; reporting no audio capability: {e}");
        return crate::proxy::HostCaps {
            has_dashdemux: false,
            has_curlhttpsrc: false,
            gst_version: (0, 0, 0),
        };
    }
    let (major, minor, micro, _nano) = gst::version();
    crate::proxy::HostCaps {
        has_dashdemux: gst::ElementFactory::find("dashdemux").is_some(),
        has_curlhttpsrc: gst::ElementFactory::find("curlhttpsrc").is_some(),
        gst_version: (major, minor, micro),
    }
}

/// Which audio tier a pipeline is playing. Both build sites already carry
/// `is_dash`, so nothing re-sniffs the URI — one source of truth.
fn capability_of(is_dash: bool) -> crate::proxy::Capability {
    if is_dash {
        crate::proxy::Capability::Dash
    } else {
        crate::proxy::Capability::Lossy
    }
}

/// The audio thread's proxy decision, held as settings plus capabilities so a
/// refusal stays a refusal.
///
/// Deliberately NOT a stored `Route`. A `Route` has two states and the answer
/// has three: proxied, direct, and refused. Collapsing the third into
/// `Route::NoProxy` is the defect the spec's stage 1a calls out by name, and
/// it would let a blocked tier stream on the user's own address.
#[derive(Clone)]
struct AudioProxy {
    settings: crate::ProxySettings,
    caps: crate::proxy::HostCaps,
    /// A bypass list that was in the environment at launch and stayed there.
    /// Read once from the process-global recorded in `main.rs`, then carried
    /// per-instance so the tests can set it without touching a `OnceLock`.
    launch_bypass: bool,
}

impl AudioProxy {
    fn new(settings: crate::ProxySettings, caps: crate::proxy::HostCaps) -> Self {
        Self {
            settings,
            caps,
            launch_bypass: crate::proxy::launch_bypass_was_set(),
        }
    }

    /// Test-only override. Production always takes the launch-time value;
    /// nothing may call `remember_launch_bypass` from a test, because it is a
    /// `OnceLock` shared by every test in the process and the first call wins
    /// for all of them.
    ///
    /// Compiled unconditionally rather than gated on the test cfg: that
    /// attribute is the anchor `audio_rs_production_source` splits this file
    /// on, and a second one partway up would move the boundary here and
    /// silently stop guarding every line below it. The attribute below keeps
    /// the dead-code check live in test builds, where the method is used.
    #[cfg_attr(not(test), allow(dead_code))]
    fn with_launch_bypass(mut self, v: bool) -> Self {
        self.launch_bypass = v;
        self
    }

    fn route_for(
        &self,
        c: crate::proxy::Capability,
    ) -> Result<crate::proxy::Route, crate::proxy::BlockReason> {
        let plan = crate::proxy::plan(&self.settings, &self.caps)
            .map_err(|e| crate::proxy::BlockReason::new(&e.to_string()))?;

        // After the `Direct` check, never before it. `Direct` hands routing
        // back to the system, bypass list included, so a user with no proxy
        // configured and an ambient `no_proxy` must keep playing.
        //
        // The mechanism this guards against is `curlhttpsrc`: it reads
        // `no_proxy` when the element is constructed and forwards it as
        // CURLOPT_NOPROXY, which beats the `proxy` property we set, and the
        // variable cannot be removed once GTK's threads exist — so only a
        // restart clears it.
        //
        // The refusal is deliberately WIDER than that mechanism, and this is
        // the note that says so rather than a claim the two line up. Curl wins
        // source selection only while credentials are in play
        // (`promote_curl_source` restores its rank otherwise), and F6 records
        // `souphttpsrc` as immune to `no_proxy` — so a credential-free proxy
        // would in all likelihood route correctly through soup. It is refused
        // regardless, because nothing here verifies which factory will win at
        // build time: the rank is process-global, this module mutates it, and
        // the spec chose fail-closed over an argument about autoplugging.
        if self.launch_bypass && !matches!(plan, crate::proxy::ProxyPlan::Direct) {
            return Err(crate::proxy::BlockReason::new(
                "a proxy bypass list was set in the environment when SONE \
                 started; restart SONE to route audio through the proxy",
            ));
        }

        plan.route(c, &self.caps)
    }
}

/// Whether a settings change alters what the audio thread may do.
///
/// Compares the `Result` across **both** capabilities. Three reasons, each of
/// which broke an earlier draft:
///
/// 1. "no proxy" and "blocked" are different answers that a bare `Route` cannot
///    tell apart, and the transition between them must force a teardown.
/// 2. Below GStreamer 1.26.10 every credentialed proxy leaves `Lossy` permanently
///    `Err`, and `BlockReason` carries no host — so two different proxies produce
///    byte-identical refusals there. Comparing only `Lossy` would report "no
///    change" when the user switches proxies mid-track; the `Dash` arm is what
///    catches it.
/// 3. Checking both removes the need to know which tier is playing — the worker
///    does not retain one, and inventing it was how the draft went wrong.
///
/// Strictly conservative: a spurious teardown costs one rebuild at the saved
/// position, and nothing else.
fn audio_route_differs(before: &AudioProxy, after: &AudioProxy) -> bool {
    [
        crate::proxy::Capability::Lossy,
        crate::proxy::Capability::Dash,
    ]
    .into_iter()
    .any(|c| before.route_for(c) != after.route_for(c))
}

/// The HTTP source elements this application can configure. Anything else the
/// hook sees — the `data:` URI source for a manifest, decoders, queues — is
/// left alone, because `set_property` panics on a property an element lacks.
const HTTP_SOURCE_FACTORIES: [&str; 2] = ["curlhttpsrc", "souphttpsrc"];

/// Apply one `Route` to one HTTP source element.
fn apply_route_to_source(source: &gst::Element, route: &crate::proxy::Route) {
    let Some(factory) = source.factory().map(|f| f.name().to_string()) else {
        return;
    };
    if !HTTP_SOURCE_FACTORIES.contains(&factory.as_str()) {
        return;
    }

    // `NoProxy` means the system's own configuration applies; these elements
    // read the environment themselves, so setting nothing is correct here.
    let crate::proxy::Route::Via { uri, creds } = route else {
        return;
    };

    source.set_property("proxy", uri);

    if let Some(c) = creds {
        source.set_property("proxy-id", &c.user);
        source.set_property("proxy-pw", &c.pass);
    }

    if factory == "curlhttpsrc" {
        // Both are `gint` on this element — a `u32` panics. Its defaults of 0
        // and -1 mean a dead-but-reachable proxy never produces a bus error.
        source.set_property("timeout", 15i32);
        source.set_property("retries", 3i32);
    }
}

/// Watch a whole pipeline for HTTP sources and configure each as it appears.
///
/// Pipeline-level rather than per-`uridecodebin`: the gapless path adds a second
/// branch later, and a per-element hook was measured leaving that branch's
/// source direct. One track also yields more than one source — a manifest
/// source and a per-stream segment source — so this must not be one-shot.
///
/// Takes the `Route` by value: the route is decided once, before the pipeline
/// exists, so the handler never locks on the streaming thread (the spec measured
/// a 13x preroll cost for a mutex here).
///
/// The captured value is therefore a snapshot. A pipeline that outlives a
/// settings change keeps it until `SetProxySettings` tears that pipeline down
/// and rebuilds it — this hook does not re-point a live source, and nothing
/// here should be read as claiming it does.
fn watch_pipeline_sources(pipeline: &gst::Pipeline, route: crate::proxy::Route) {
    pipeline.connect_deep_element_added(move |_pipeline, _bin, element| {
        // Check the factory first: this fires for every element in the graph.
        let is_source = element
            .factory()
            .map(|f| HTTP_SOURCE_FACTORIES.contains(&f.name().as_str()))
            .unwrap_or(false);
        if is_source {
            apply_route_to_source(element, &route);
        }
    });
}

/// Whether the element GStreamer would autoplug for an https URI is one this
/// application knows how to point at a proxy.
///
/// `apply_route_to_source` skips any factory outside `HTTP_SOURCE_FACTORIES`,
/// and for a *source* "skipped" means "unproxied". The allowlist is exhaustive
/// on a stock system, but which factory wins is decided by process-global rank,
/// which this very module mutates. Rather than trust that, ask — and let the
/// build sites refuse when the answer is no.
fn http_source_is_configurable() -> bool {
    let Ok(element) =
        gst::Element::make_from_uri(gst::URIType::Src, "https://example.invalid/probe", None)
    else {
        return false;
    };
    element
        .factory()
        .map(|f| HTTP_SOURCE_FACTORIES.contains(&f.name().as_str()))
        .unwrap_or(false)
}

/// Prefer the curl source only while credentials are in play.
///
/// Not optional: the soup source never answers a proxy's authentication
/// challenge on a CONNECT tunnel, and every streamed segment is HTTPS.
fn promote_curl_source(route: &crate::proxy::Route, original: Option<gst::Rank>) {
    let Some(factory) = gst::ElementFactory::find("curlhttpsrc") else {
        return;
    };
    if matches!(route, crate::proxy::Route::Via { creds: Some(_), .. }) {
        factory.set_rank(gst::Rank::PRIMARY + 100);
    } else if let Some(rank) = original {
        factory.set_rank(rank);
    }
}

type Reply<T> = mpsc::Sender<T>;

#[derive(Debug, Clone, Serialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
}

// ── PCM types ──────────────────────────────────────────────────────────

/// Raw PCM chunk from GStreamer appsink
struct AudioChunk {
    data: Vec<u8>,
    format: PcmFormat,
    generation: u64,
}

#[derive(Clone, Debug, PartialEq)]
struct PcmFormat {
    sample_rate: u32,
    channels: u32,
    gst_format: String,
    bytes_per_sample: u32,
}

// NOTE (2b): the old `NextTrack` / `PendingAdvance` slot structs (used by the
// 2a `about-to-finish` machinery) were removed in 2b-A1.

/// 2b-A2: the prerolled next-track branch. Built on the attach executor thread
/// and stored in the shared `Arc<Mutex<Option<NextBinState>>>` that the worker
/// (dedup/replace/gating), the executor (attach/detach), and the notify
/// handler (2b-A3 advance) all read.
struct NextBinState {
    /// The legacy `uridecodebin` for the next track. Linked through
    /// `branch_queue` → `concat sink_1`. Owned here so detach can null + remove it.
    bin: gst::Element,
    /// The per-branch upstream queue (C1) decoupling this decoder from concat's
    /// gate so it pre-buffers while the current track plays.
    branch_queue: gst::Element,
    /// The URI this branch is decoding. Read on promotion so the worker's
    /// `current_uri` follows a gapless advance — without it a route change after
    /// an advance would re-issue the previous track.
    uri: String,
    track_id: u64,
    qid: String,
    // Read by HandleGaplessAdvance to apply gain + emit `track-advanced` on the switch.
    norm_gain: f64,
    replay_gain: f64,
    peak_amplitude: f64,
}

/// Jobs for the serialized attach/detach executor thread (C3). Pad-slot
/// operations on `concat` must never race, so they are all funneled through
/// this single thread's mpsc. The worker dispatches and returns immediately;
/// the executor does the blocking `pipeline.add` / `sync_state_with_parent` /
/// `set_state(Null)` work off the worker thread.
enum AttachJob {
    /// Build a second `uridecodebin → branch_queue → concat sink_1`, preroll it,
    /// and store the resulting `NextBinState` into the shared slot.
    Attach {
        pipeline: gst::Pipeline,
        concat: gst::Element,
        /// The `route_generation` the target pipeline was built under — i.e.
        /// the route its `watch_pipeline_sources` hook applies. The executor
        /// compares it against the current generation and refuses when they
        /// differ: the hook is what actually configures this branch's source,
        /// so a pipeline older than the route would fetch the next track on
        /// the route the user just replaced.
        build_generation: u64,
        uri: String,
        is_dash: bool,
        track_id: u64,
        qid: String,
        norm_gain: f64,
        replay_gain: f64,
        peak_amplitude: f64,
    },
    /// Tear down a specific bin (+ its branch queue): set Null, release the
    /// concat request pad whose peer is the queue, and remove from the pipeline.
    /// Captured `pipeline`/`concat` clones are Normal-only (per C5 — the worker
    /// never dispatches this on DirectAlsa).
    Detach {
        pipeline: gst::Pipeline,
        concat: gst::Element,
        bin: gst::Element,
        branch_queue: gst::Element,
    },
}

/// Commands to the ALSA writer thread
enum WriterCommand {
    Data(AudioChunk),
    EndOfTrack {
        emit_finished: bool,
        generation: u64,
    },
    FormatHint(PcmFormat),
    Resampling { from: u32, to: u32 },
    PendingPromotion { from: String, generation: u64 },
    Flush,
    Shutdown,
}

/// Active playback backend — determines command dispatch.
/// The ALSA writer sender + thread handle live as separate state variables
/// so they persist across PlayUrl calls (track changes keep DAC open).
enum PlaybackBackend {
    /// Normal: full GStreamer pipeline with autoaudiosink.
    /// `concat` sits at the head (per-branch `queue` → concat → chain → sink)
    /// so the next track's decoder can preroll ahead for gapless (2b).
    Normal {
        pipeline: gst::Pipeline,
        concat: gst::Element,
        user_volume_el: Option<gst::Element>,
        norm_volume_el: Option<gst::Element>,
    },
    /// Exclusive/Bit-perfect: GStreamer decode → appsink, ALSA writer is external
    DirectAlsa {
        pipeline: gst::Pipeline,
        user_volume_el: Option<gst::Element>,
        norm_volume_el: Option<gst::Element>,
    },
}

impl PlaybackBackend {
    fn user_volume_el(&self) -> Option<&gst::Element> {
        match self {
            PlaybackBackend::Normal { user_volume_el, .. }
            | PlaybackBackend::DirectAlsa { user_volume_el, .. } => user_volume_el.as_ref(),
        }
    }

    fn norm_volume_el(&self) -> Option<&gst::Element> {
        match self {
            PlaybackBackend::Normal { norm_volume_el, .. }
            | PlaybackBackend::DirectAlsa { norm_volume_el, .. } => norm_volume_el.as_ref(),
        }
    }

    /// The backend's GStreamer pipeline. Both variants own a `gst::Pipeline`.
    #[allow(dead_code)]
    fn pipeline(&self) -> &gst::Pipeline {
        match self {
            PlaybackBackend::Normal { pipeline, .. }
            | PlaybackBackend::DirectAlsa { pipeline, .. } => pipeline,
        }
    }

    /// The head `concat` element. Normal-only — gapless never runs on
    /// DirectAlsa (the mode gate prevents this path), so calling it on
    /// DirectAlsa is a programming error.
    #[allow(dead_code)]
    fn concat(&self) -> &gst::Element {
        match self {
            PlaybackBackend::Normal { concat, .. } => concat,
            PlaybackBackend::DirectAlsa { .. } => {
                panic!("PlaybackBackend::concat() called on DirectAlsa — gapless is normal-only")
            }
        }
    }
}

// ── Helper functions ───────────────────────────────────────────────────

fn parse_pcm_format(caps: &gst::CapsRef) -> Option<PcmFormat> {
    let s = caps.structure(0)?;
    if !s.name().as_str().starts_with("audio/") {
        return None;
    }
    let format = s.get::<&str>("format").ok()?;
    let rate = s.get::<i32>("rate").ok()? as u32;
    let channels = s.get::<i32>("channels").ok()? as u32;
    let bps = match format {
        "S16LE" => 2,
        "S24LE" => 3,
        "S24_32LE" | "S32LE" | "F32LE" => 4,
        other => {
            log::warn!("[audio] unsupported PCM format: {other}");
            return None;
        }
    };
    Some(PcmFormat {
        sample_rate: rate,
        channels,
        gst_format: format.to_string(),
        bytes_per_sample: bps,
    })
}

#[cfg(target_os = "linux")]
fn gst_format_to_alsa(gst_format: &str) -> alsa::pcm::Format {
    match gst_format {
        "S16LE" => alsa::pcm::Format::S16LE,
        "S24LE" => alsa::pcm::Format::S243LE,
        "S24_32LE" => alsa::pcm::Format::S24LE,
        "S32LE" => alsa::pcm::Format::S32LE,
        "F32LE" => alsa::pcm::Format::FloatLE,
        _ => alsa::pcm::Format::S32LE,
    }
}

#[cfg(target_os = "linux")]
fn alsa_format_to_gst(alsa_fmt: alsa::pcm::Format) -> (&'static str, u32) {
    // Inverse of gst_format_to_alsa. The ALSA/GStreamer 24-bit naming is swapped:
    //   ALSA S24LE  = 24-in-32 container = GStreamer S24_32LE (4 bytes/sample)
    //   ALSA S243LE = packed 24-bit       = GStreamer S24LE   (3 bytes/sample)
    match alsa_fmt {
        alsa::pcm::Format::S32LE => ("S32LE", 4),
        alsa::pcm::Format::S24LE => ("S24_32LE", 4),
        alsa::pcm::Format::S243LE => ("S24LE", 3),
        alsa::pcm::Format::S16LE => ("S16LE", 2),
        alsa::pcm::Format::FloatLE => ("F32LE", 4),
        _ => ("S32LE", 4),
    }
}

/// Converts perceptual linear volume (0.0 to 1.0 from the UI)
/// into an audio amplitude curve (cubic taper, ~50 dB range).
#[inline]
fn slider_to_amplitude(slider_val: f64) -> f64 {
    slider_val.clamp(0.0, 1.0).powi(3)
}

/// Applies a normalization gain across all volume sinks: the GStreamer
/// `norm_vol` element (if present), the local `current_norm_gain` mirror, the
/// combined-volume atom (read by the ALSA writer), and the signal-path tracker.
/// Shared by `SetNormalizationGain` and the gapless `HandleGaplessAdvance` path.
fn apply_normalization_gain(
    gain: f64,
    current_norm_gain: &mut f64,
    norm_volume_el: Option<&gst::Element>,
    combined_vol: &Arc<AtomicU32>,
    current_volume: f64,
    signal_path: &SignalPathTracker,
) {
    *current_norm_gain = gain;
    if let Some(el) = norm_volume_el {
        el.set_property("volume", gain);
    }
    let amp = slider_to_amplitude(current_volume);
    combined_vol.store(((amp * gain) as f32).to_bits(), Ordering::Relaxed);
    signal_path.set_norm_gain_factor(gain as f32);
}

/// 2b-A2: build + preroll the next-track branch on the executor thread.
///
/// Mirrors the first branch's wiring (sink_0): legacy `uridecodebin` →
/// per-branch `queue` → `concat sink_1`. The branch queue (C1) decouples this
/// decoder from concat's back-pressure on the inactive sink pad so it
/// pre-buffers ahead while the current track plays. A smaller `buffer-duration`
/// (~3s, per C3) prerolls the source without fully pre-downloading it.
///
/// Returns the constructed elements so the caller can stash them in
/// `NextBinState`. On any error the partially-added elements are removed so the
/// pipeline isn't left with a dangling half-attached bin.
fn attach_next_bin(
    pipeline: &gst::Pipeline,
    concat: &gst::Element,
    uri: &str,
    is_dash: bool,
) -> Result<(gst::Element, gst::Element), String> {
    let udb = gst::ElementFactory::make("uridecodebin")
        .property("uri", uri)
        // 15s compressed buffer so the next track (and the current one once this
        // becomes active) rides out network jitter on slow connections. We have
        // the whole current track as lead time to fill it during preroll.
        .property("buffer-duration", 15_000_000_000i64)
        .property("use-buffering", true)
        .build()
        .map_err(|e| format!("Failed to create next uridecodebin: {e}"))?;
    // No route here: this bin joins a pipeline whose `watch_pipeline_sources`
    // hook already configures every HTTP source that appears under it.
    // Same props as the first branch's queue: 15s of decoded reservoir ahead of
    // concat — comfortable cushion against slow-internet rebuffering.
    let branch_queue = gst::ElementFactory::make("queue")
        .property("max-size-time", 15_000_000_000u64)
        .property("max-size-buffers", 0u32)
        .property("max-size-bytes", 0u32)
        .build()
        .map_err(|e| format!("Failed to create next branch queue: {e}"))?;

    if let Err(e) = pipeline.add_many([&udb, &branch_queue]) {
        return Err(format!("Failed to add next bin elements: {e}"));
    }

    // Link branch_queue.src → concat sink_1 (sink_0 is taken by the first
    // branch, so this request deterministically gets sink_1).
    let concat_sink = match concat.request_pad_simple("sink_%u") {
        Some(p) => p,
        None => {
            let _ = pipeline.remove_many([&udb, &branch_queue]);
            return Err("concat refused next sink pad".to_string());
        }
    };
    let queue_src = match branch_queue.static_pad("src") {
        Some(p) => p,
        None => {
            concat.release_request_pad(&concat_sink);
            let _ = pipeline.remove_many([&udb, &branch_queue]);
            return Err("next branch queue has no src pad".to_string());
        }
    };
    if let Err(e) = queue_src.link(&concat_sink) {
        concat.release_request_pad(&concat_sink);
        let _ = pipeline.remove_many([&udb, &branch_queue]);
        return Err(format!("Failed to link next queue→concat: {e}"));
    }

    // uridecodebin(B) → branch_queue (dynamic). Mirror sink_0's pad_added guard:
    // skip already-linked + non-audio pads.
    let branch_queue_weak = branch_queue.downgrade();
    udb.connect_pad_added(move |_src, src_pad| {
        let Some(branch_queue) = branch_queue_weak.upgrade() else {
            return;
        };
        let Some(sink_pad) = branch_queue.static_pad("sink") else {
            return;
        };
        if sink_pad.is_linked() {
            return;
        }
        if let Some(caps) = src_pad.current_caps() {
            if let Some(s) = caps.structure(0) {
                if !s.name().as_str().starts_with("audio/") {
                    return;
                }
            }
        }
        if let Err(e) = src_pad.link(&sink_pad) {
            log::error!("Failed to link next uridecodebin pad: {e:?}");
        }
    });

    // Preroll-before-PLAYING (fixes the `not-linked` race on async/network/DASH
    // sources). Going straight to PLAYING via `sync_state_with_parent` lets the
    // demuxer's streaming thread emit its decoded src pad AND push the first
    // buffer before the `pad_added` handler above links it into `branch_queue` —
    // the buffer hits an unlinked pad and `not-linked` (-1) propagates up to the
    // demuxer ("GstDashDemux: streaming stopped, reason not-linked"). Local files
    // decode instantly so the link always wins, masking the bug.
    //
    // Instead, bring B up to PAUSED only and BLOCK until the async preroll
    // settles (`get_state` returns once the state change is ASYNC-DONE). In
    // PAUSED no data flows past the prerolled pad, so `pad_added` fires and links
    // during preroll — guaranteeing the link is in place before any buffer moves.
    // Only then promote to PLAYING. `concat` back-pressures the inactive sink pad,
    // so the branch holds prerolled and switches in gap-free at sink_0's EOS.
    if let Err(e) = branch_queue.set_state(gst::State::Paused) {
        log::error!("next branch queue set Paused failed: {e}");
    }
    if let Err(e) = udb.set_state(gst::State::Paused) {
        log::error!("next uridecodebin set Paused failed: {e}");
    }
    // Wait for the preroll to complete so pad_added has fired + linked. Bounded
    // so a stalled network source can't hang the executor thread.
    let (ret, cur, pend) = udb.state(gst::ClockTime::from_seconds(15));
    log::debug!(
        "[audio] gapless: next bin preroll state ret={ret:?} cur={cur:?} pend={pend:?}"
    );

    // Preroll done + pad linked: now safe to promote to PLAYING.
    if let Err(e) = branch_queue.sync_state_with_parent() {
        log::error!("next branch queue sync_state failed: {e}");
    }
    if let Err(e) = udb.sync_state_with_parent() {
        log::error!("next uridecodebin sync_state failed: {e}");
    }
    log::debug!("[audio] gapless: attached next bin (is_dash={is_dash})");

    Ok((udb, branch_queue))
}

/// 2b-A2: tear down a next-track branch on the executor thread.
///
/// Sets the bin + its branch queue to Null, finds the `concat` sink pad whose
/// peer's parent is this bin's queue, unlinks + releases that request pad, then
/// removes both elements from the pipeline. Only ever called with Normal-mode
/// `pipeline`/`concat` clones (the worker gates dispatch — never DirectAlsa, C5).
fn detach_bin(
    pipeline: &gst::Pipeline,
    concat: &gst::Element,
    bin: &gst::Element,
    branch_queue: &gst::Element,
) {
    // Order matters. Unlink + release the concat request pad FIRST, BEFORE
    // nulling the bin. The branch queue's src is linked to concat's INACTIVE sink
    // pad, which concat hard-blocks (it only pulls from the active pad). If we
    // null the bin while still linked, its streaming threads are stuck pushing
    // into that blocked pad and the NULL transition can't complete — the
    // `set_state(Null)` call blocks the executor thread indefinitely on a live
    // network source. Releasing the pad first unblocks them so NULL completes.
    let sink_pads: Vec<gst::Pad> = concat
        .sink_pads()
        .into_iter()
        .filter(|pad| {
            pad.peer()
                .and_then(|peer| peer.parent_element())
                .is_some_and(|parent| &parent == branch_queue)
        })
        .collect();
    for pad in sink_pads {
        if let Some(peer) = pad.peer() {
            let _ = peer.unlink(&pad);
        }
        concat.release_request_pad(&pad);
    }

    // Now drive both elements to NULL and BLOCK until the (possibly async)
    // transition actually completes. Removing/dropping an element still mid-
    // transition disposes it in a non-NULL state, which emits GStreamer
    // CRITICALs ("Trying to dispose element … in PLAYING instead of the NULL
    // state") + GST_IS_ELEMENT assertion failures. `get_state` with a bounded
    // timeout guarantees we only `remove_many` once both are truly NULL.
    let _ = bin.set_state(gst::State::Null);
    let _ = branch_queue.set_state(gst::State::Null);
    let (br, bcur, _) = bin.state(gst::ClockTime::from_seconds(10));
    let (qr, qcur, _) = branch_queue.state(gst::ClockTime::from_seconds(10));
    log::debug!(
        "[audio] gapless: next bin NULL wait bin={br:?}/{bcur:?} queue={qr:?}/{qcur:?}"
    );

    let _ = pipeline.remove_many([bin, branch_queue]);
    log::debug!("[audio] gapless: detached next bin");
}

/// 2b-A2: the serialized attach/detach executor loop (C3). One dedicated thread
/// owns this so pad-slot operations on `concat` are strictly ordered and never
/// block the worker command thread. `next_bin` is the shared slot the worker /
/// executor / notify handler (2b-A3) all read.
fn run_attach_executor(
    job_rx: mpsc::Receiver<AttachJob>,
    next_bin: Arc<Mutex<Option<NextBinState>>>,
    audio_proxy: Arc<Mutex<AudioProxy>>,
    route_generation: Arc<AtomicU64>,
) {
    for job in job_rx {
        match job {
            AttachJob::Attach {
                pipeline,
                concat,
                build_generation,
                uri,
                is_dash,
                track_id,
                qid,
                norm_gain,
                replay_gain,
                peak_amplitude,
            } => {
                // Snapshot before the route is even read: if a settings change
                // lands from here on, this branch is built under a route that is
                // no longer current and must not be armed.
                let generation_at_start = route_generation.load(Ordering::Acquire);
                // The route below is recomputed from the current settings, but
                // it is not what configures this branch: the target pipeline's
                // hook is, and that hook holds the route of `build_generation`.
                // Refuse before `attach_next_bin`, because that call prerolls —
                // up to fifteen seconds of the next track on the old route.
                //
                // Nothing to detach here: this job built nothing, and the slot
                // it would otherwise clear belongs to the pipeline that is now
                // current (`SetProxySettings` already detached anything left on
                // the stale one), so dropping that reference without detaching
                // would strand a branch already linked to concat.
                if build_generation != generation_at_start {
                    log::warn!(
                        "[proxy] refusing to preroll onto a pipeline built under the previous route"
                    );
                    continue;
                }
                let route = {
                    let ap = audio_proxy.lock().unwrap_or_else(|p| p.into_inner());
                    ap.route_for(capability_of(is_dash))
                };
                if let Err(blocked) = route {
                    // A branch we may not proxy is a branch we must not preroll.
                    log::warn!("[proxy] refusing to preroll next track: {}", blocked.cause);
                    if let Ok(mut guard) = next_bin.lock() {
                        *guard = None;
                    }
                    continue;
                }

                match attach_next_bin(&pipeline, &concat, &uri, is_dash) {
                    Ok((bin, branch_queue)) => {
                        // Re-read the generation and store under ONE hold of the
                        // `next_bin` mutex, the same one `SetProxySettings` bumps
                        // and takes under. Two independent synchronisation points
                        // leave this legal interleaving: the settings change takes
                        // an empty slot (detaching nothing) and this thread then
                        // stores a branch built under the route it just replaced.
                        let mut guard = match next_bin.lock() {
                            Ok(g) => g,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        if route_generation.load(Ordering::Acquire) != generation_at_start {
                            // The branch is already in the pipeline and linked to
                            // concat's sink_1, so concat would switch to it at the
                            // boundary whether or not this slot names it. Dropping
                            // the reference is not enough — it has to be detached.
                            drop(guard);
                            log::warn!(
                                "[proxy] discarding a next branch prerolled under the previous route"
                            );
                            detach_bin(&pipeline, &concat, &bin, &branch_queue);
                            continue;
                        }
                        *guard = Some(NextBinState {
                            bin,
                            branch_queue,
                            uri,
                            track_id,
                            qid,
                            norm_gain,
                            replay_gain,
                            peak_amplitude,
                        });
                    }
                    Err(e) => {
                        // Preload failure is non-fatal: leave the slot empty so
                        // the natural track boundary falls back to playNext.
                        log::warn!("[audio] gapless: attach_next_bin failed: {e}");
                        if let Ok(mut guard) = next_bin.lock() {
                            *guard = None;
                        }
                    }
                }
            }
            AttachJob::Detach {
                pipeline,
                concat,
                bin,
                branch_queue,
            } => {
                detach_bin(&pipeline, &concat, &bin, &branch_queue);
            }
        }
    }
}

/// Probe which GStreamer format strings an ALSA device supports.
/// Returns a list like `["S32LE", "S24_32LE", "S16LE"]`.
#[cfg(target_os = "linux")]
fn probe_supported_gst_formats(pcm: &alsa::PCM) -> Vec<&'static str> {
    use alsa::pcm::{Format, HwParams};

    let Ok(hwp) = HwParams::any(pcm) else {
        return vec!["S32LE"]; // safe fallback
    };
    let probe: &[(Format, &str)] = &[
        (Format::S32LE, "S32LE"),
        (Format::S24LE, "S24_32LE"),  // ALSA S24LE = GStreamer S24_32LE
        (Format::S243LE, "S24LE"),    // ALSA S243LE = GStreamer S24LE
        (Format::FloatLE, "F32LE"),
        (Format::S16LE, "S16LE"),
    ];
    let supported: Vec<&str> = probe
        .iter()
        .filter(|(f, _)| hwp.test_format(*f).is_ok())
        .map(|(_, name)| *name)
        .collect();
    if supported.is_empty() {
        vec!["S32LE"] // safe fallback
    } else {
        supported
    }
}

/// Pick the bit-perfect capsfilter format for a given source.
/// Priority:
///   1. Pass-through if the DAC supports the source format directly (zero conversion work).
///   2. Narrowest lossless promotion the DAC supports (container widening or, for S24_32LE,
///      shrinking to S24LE which holds the same 24 audio bits in 3 bytes).
///   3. Lossy fallback: DAC's first probed format (widest per probe order).
/// In case 3, the writer's `resolve_pending` still emits a truthful from→to toast.
#[cfg(target_os = "linux")]
fn pick_capsfilter_format(source: &str, dac_supported: &[String]) -> String {
    // 1. Pass-through.
    if dac_supported.iter().any(|f| f == source) {
        return source.to_string();
    }
    // 2. Narrowest lossless promotion. audioconvert with dithering=none does pure
    //    integer bit-shift conversions between these formats — no quantization.
    //    S24_32LE → S24LE is safe because audioconvert writes a zero pad byte
    //    upstream; stripping it preserves the 24 audio bits exactly.
    let promotions: &[&str] = match source {
        "S16LE"    => &["S24LE", "S24_32LE", "S32LE"],
        "S24LE"    => &["S24_32LE", "S32LE"],
        "S24_32LE" => &["S24LE", "S32LE"], // S24LE = same 24 bits, narrower container
        _          => &[], // S32LE, F32LE, unknowns: no lossless integer alternative
    };
    if let Some(p) = promotions.iter().find(|p| dac_supported.iter().any(|f| f == *p)) {
        return (*p).to_string();
    }
    // 3. Lossy fallback — DAC's preferred (widest) format. PendingPromotion still
    //    fires from pad_added so the writer surfaces a truthful toast.
    dac_supported
        .first()
        .cloned()
        .unwrap_or_else(|| "S32LE".to_string())
}

/// Probe which standard sample rates an ALSA device supports.
/// Tests common audiophile rates and returns those that pass.
#[cfg(target_os = "linux")]
fn probe_supported_rates(pcm: &alsa::PCM) -> Vec<u32> {
    use alsa::pcm::HwParams;

    let Ok(hwp) = HwParams::any(pcm) else {
        return vec![44100, 48000]; // safe fallback
    };
    let candidates: &[u32] = &[
        44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000,
    ];
    let supported: Vec<u32> = candidates
        .iter()
        .copied()
        .filter(|&r| hwp.test_rate(r).is_ok())
        .collect();
    if supported.is_empty() {
        vec![44100, 48000] // safe fallback
    } else {
        supported
    }
}

// ── ALSA writer thread ─────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn configure_alsa_hwparams(
    pcm: &alsa::PCM,
    fmt: &PcmFormat,
    bit_perfect: bool,
) -> Result<PcmFormat, String> {
    use alsa::pcm::{Access, Format, HwParams};
    use alsa::ValueOr;

    let hwp = HwParams::any(pcm).map_err(|e| format!("HwParams::any failed: {e}"))?;
    hwp.set_access(Access::RWInterleaved)
        .map_err(|e| format!("set_access: {e}"))?;

    // Probe and log all supported formats
    let probe_formats: &[(Format, &str)] = &[
        (Format::S32LE, "S32LE (32-bit)"),
        (Format::S24LE, "S24LE (24-in-32)"),
        (Format::S243LE, "S24_3LE (24-bit packed)"),
        (Format::FloatLE, "F32LE (float)"),
        (Format::S16LE, "S16LE (16-bit)"),
    ];
    let supported: Vec<&str> = probe_formats
        .iter()
        .filter(|(f, _)| hwp.test_format(*f).is_ok())
        .map(|(_, name)| *name)
        .collect();
    log::debug!("[audio] DAC supported formats: [{}]", supported.join(", "));

    let requested = gst_format_to_alsa(&fmt.gst_format);

    let alsa_fmt = if bit_perfect {
        hwp.set_format(requested)
            .map_err(|e| format!("set_format({}): {e}", fmt.gst_format))?;
        requested
    } else {
        // Ranked fallback: requested first, then descending quality
        let fallbacks: &[Format] = &[
            Format::S32LE,
            Format::S24LE,   // 24-in-32 container
            Format::S243LE,  // 24-bit packed
            Format::FloatLE,
            Format::S16LE,
        ];
        let mut candidates: Vec<Format> = Vec::with_capacity(6);
        candidates.push(requested);
        for &f in fallbacks {
            if f != requested {
                candidates.push(f);
            }
        }
        let mut chosen = None;
        for &candidate in &candidates {
            if hwp.test_format(candidate).is_ok() {
                hwp.set_format(candidate)
                    .map_err(|e| format!("set_format after test: {e}"))?;
                chosen = Some(candidate);
                break;
            }
        }
        chosen.ok_or_else(|| {
            "Audio device does not support any compatible sample format".to_string()
        })?
    };

    if bit_perfect {
        hwp.set_rate_resample(false)
            .map_err(|e| format!("set_rate_resample: {e}"))?;
    }
    hwp.set_rate(fmt.sample_rate, ValueOr::Nearest)
        .map_err(|e| {
            if bit_perfect {
                log::warn!("[audio] bit-perfect set_rate({}) failed: {e}", fmt.sample_rate);
                format!(
                    "DAC doesn't support {}kHz — turn off bit-perfect mode for compatibility",
                    fmt.sample_rate / 1000
                )
            } else {
                format!("set_rate({}): {e}", fmt.sample_rate)
            }
        })?;
    if bit_perfect {
        let actual_rate = hwp.get_rate().map_err(|e| format!("get_rate: {e}"))?;
        if actual_rate != fmt.sample_rate {
            log::warn!(
                "[audio] bit-perfect rate mismatch: DAC negotiated {}Hz, track requires {}Hz",
                actual_rate, fmt.sample_rate
            );
            return Err(format!(
                "DAC doesn't support {}kHz — turn off bit-perfect mode for compatibility",
                fmt.sample_rate / 1000
            ));
        }
    }
    // Negotiate channel count. Some DACs (USB pro interfaces like Focusrite /
    // Audient) expose only a fixed channel count and reject 2ch stereo. Test the
    // requested count; if unsupported, fall back to the device's native minimum.
    let hw_channels = if hwp.test_channels(fmt.channels).is_ok() {
        fmt.channels
    } else {
        match hwp.get_channels_min() {
            Ok(n) if n > 0 => {
                log::info!(
                    "[audio] DAC rejects {}ch, using device-native {}ch",
                    fmt.channels, n
                );
                n
            }
            _ => {
                return Err(format!(
                    "DAC rejects {}ch and exposes no usable channel count",
                    fmt.channels
                ))
            }
        }
    };
    hwp.set_channels(hw_channels)
        .map_err(|e| format!("set_channels({hw_channels}): {e}"))?;
    hwp.set_buffer_time_near(500_000, ValueOr::Nearest)
        .map_err(|e| format!("set_buffer_time: {e}"))?;
    hwp.set_period_time_near(50_000, ValueOr::Nearest)
        .map_err(|e| format!("set_period_time: {e}"))?;
    pcm.hw_params(&hwp).map_err(|e| format!("hw_params: {e}"))?;

    // Configure sw_params: pre-fill buffer before DMA starts.
    // snd_pcm_hw_params() resets start_threshold to 1 (immediate start on first
    // writei), which causes underruns when the writer can't keep up from frame one.
    // Match GStreamer alsasink: start_threshold = buffer_size (full pre-fill).
    {
        let swp = pcm.sw_params_current()
            .map_err(|e| format!("sw_params_current: {e}"))?;
        let hwp_active = pcm.hw_params_current()
            .map_err(|e| format!("hw_params_current for sw: {e}"))?;
        let buffer_frames = hwp_active.get_buffer_size()
            .map_err(|e| format!("get_buffer_size: {e}"))?;
        let period_frames = hwp_active.get_period_size()
            .map_err(|e| format!("get_period_size: {e}"))?;
        // start_threshold: largest period-aligned value ≤ buffer_size.
        // With our time-near requests this equals buffer_size, but the
        // rounding guards against odd driver negotiations.
        let start = (buffer_frames / period_frames) * period_frames;
        swp.set_start_threshold(start as alsa::pcm::Frames)
            .map_err(|e| format!("set_start_threshold: {e}"))?;
        swp.set_avail_min(period_frames as alsa::pcm::Frames)
            .map_err(|e| format!("set_avail_min: {e}"))?;
        pcm.sw_params(&swp)
            .map_err(|e| format!("sw_params: {e}"))?;
        log::debug!(
            "[audio] sw_params committed: start_threshold={}, avail_min={}",
            start, period_frames
        );
    }

    // Log final negotiated hw_params
    if let Ok(active) = pcm.hw_params_current() {
        let rate = active.get_rate().unwrap_or(0);
        let channels = active.get_channels().unwrap_or(0);
        let buffer_frames = active.get_buffer_size().unwrap_or(0);
        let period_frames = active.get_period_size().unwrap_or(0);
        log::debug!(
            "[audio] hw_params committed: rate={}Hz, channels={}, buffer={} frames, period={} frames",
            rate, channels, buffer_frames, period_frames
        );
    }

    let (gst_fmt_str, bps) = alsa_format_to_gst(alsa_fmt);
    if alsa_fmt != requested {
        log::info!(
            "[audio] format fallback: {} -> {} (DAC doesn't support {})",
            fmt.gst_format, gst_fmt_str, fmt.gst_format
        );
    }
    let actual_rate = pcm.hw_params_current()
        .and_then(|p| p.get_rate())
        .unwrap_or(fmt.sample_rate);
    Ok(PcmFormat {
        sample_rate: actual_rate,
        channels: hw_channels,
        gst_format: gst_fmt_str.to_string(),
        bytes_per_sample: bps,
    })
}

#[cfg(target_os = "linux")]
#[allow(clippy::too_many_arguments)]
fn spawn_alsa_writer(
    device: &str,
    initial_format: &PcmFormat,
    app_handle: tauri::AppHandle,
    tearing_down: Arc<AtomicBool>,
    frames_written: Arc<AtomicU64>,
    current_sample_rate: Arc<AtomicU32>,
    writer_gen: Arc<AtomicU64>,
    paused: Arc<AtomicBool>,
    bit_perfect: bool,
    combined_vol: Arc<AtomicU32>,
    signal_path: Arc<SignalPathTracker>,
    decoded_cell: Arc<Mutex<Option<crate::pipeline_probe::PadCaps>>>,
    output_cell: Arc<Mutex<Option<crate::pipeline_probe::PadCaps>>>,
) -> Result<(crossbeam_channel::Sender<WriterCommand>, JoinHandle<()>, PcmFormat, Vec<&'static str>, Vec<u32>), String> {
    let device = device.to_string();
    let initial_format = initial_format.clone();
    let (tx, rx) = crossbeam_channel::bounded::<WriterCommand>(256);

    // Open device eagerly to detect EBUSY immediately
    let pcm = alsa::PCM::new(&device, alsa::Direction::Playback, false).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("busy") || msg.contains("EBUSY") {
            "device_busy".to_string()
        } else {
            format!("Failed to open ALSA device: {e}")
        }
    })?;

    let supported_gst_formats = probe_supported_gst_formats(&pcm);
    log::debug!("[alsa-writer] DAC supported GStreamer formats: {:?}", supported_gst_formats);

    let supported_rates = probe_supported_rates(&pcm);
    log::debug!("[alsa-writer] DAC supported rates: {:?}", supported_rates);

    // Adjust initial format to something the DAC actually supports.
    // This is a placeholder — the real format arrives via FormatHint/pad_added
    // once GStreamer decodes the stream. We just need the DAC to accept it.
    let initial_format = {
        let mut fmt = initial_format;
        if !supported_gst_formats.contains(&fmt.gst_format.as_str()) {
            let best = supported_gst_formats[0]; // probe orders by quality (S32>S24>S16)
            let (_, bps) = alsa_format_to_gst(gst_format_to_alsa(best));
            log::info!(
                "[alsa-writer] DAC doesn't support {}, using {} for initial config",
                fmt.gst_format, best
            );
            fmt.gst_format = best.to_string();
            fmt.bytes_per_sample = bps;
        }
        if !supported_rates.is_empty() && !supported_rates.contains(&fmt.sample_rate) {
            let fallback = supported_rates[0]; // first probed rate (44100 typically)
            log::info!(
                "[alsa-writer] DAC doesn't support {}Hz, using {}Hz for initial config",
                fmt.sample_rate, fallback
            );
            fmt.sample_rate = fallback;
        }
        fmt
    };

    let requested_for_fallback = initial_format.clone();
    let initial_format = configure_alsa_hwparams(&pcm, &initial_format, bit_perfect)?;
    pcm.prepare().map_err(|e| format!("pcm.prepare: {e}"))?;
    current_sample_rate.store(initial_format.sample_rate, Ordering::Relaxed);
    let negotiated_fmt = initial_format.clone();

    signal_path.set_output(
        &initial_format.gst_format,
        initial_format.sample_rate,
        initial_format.channels,
    );
    if !bit_perfect && requested_for_fallback.gst_format != initial_format.gst_format {
        signal_path.record_format_fallback(
            &requested_for_fallback.gst_format,
            &initial_format.gst_format,
        );
    }

    let signal_path_thread = Arc::clone(&signal_path);
    let handle = std::thread::Builder::new()
        .name("alsa-writer".into())
        .spawn(move || {
            let sp = signal_path_thread;
            let mut pcm = pcm; // rebind as mutable for format-change reopen
            let mut current_fmt = initial_format;
            let period_duration = std::time::Duration::from_millis(50);

            let silence_frames = (current_fmt.sample_rate as usize * 50) / 1000;
            let mut silence_buf = vec![0u8; silence_frames * current_fmt.channels as usize * current_fmt.bytes_per_sample as usize];

            // Bit-perfect promotion announcement: pad_added sends only the source format,
            // writer emits the toast once the actually-negotiated `current_fmt` is known.
            let mut pending_promotion_from: Option<String> = None;
            let resolve_pending = |pending: &mut Option<String>, current: &PcmFormat| {
                if let Some(from) = pending.take() {
                    if from != current.gst_format {
                        log::info!("[alsa-writer] bit-depth promotion: {from} -> {}", current.gst_format);
                        sp.record_bit_depth_promotion(&from, &current.gst_format);
                        app_handle.emit(
                            "audio-bit-depth-changed",
                            serde_json::json!({ "from": from, "to": current.gst_format }),
                        ).ok();
                    } else {
                        log::debug!("[alsa-writer] bit-perfect: no promotion needed ({from})");
                    }
                }
            };

            // Recover from ALSA errors (XRUN, suspend, etc.)
            fn alsa_recover(pcm: &alsa::PCM, errno: i32) -> bool {
                if errno == libc::EPIPE {
                    log::warn!("[alsa-writer] XRUN, recovering");
                    pcm.prepare().ok();
                    true
                } else if errno == libc::ESTRPIPE {
                    let mut recovered = false;
                    loop {
                        match pcm.resume() {
                            Ok(_) => { recovered = true; break; }
                            Err(e) if e.errno() == libc::EAGAIN => {
                                std::thread::sleep(std::time::Duration::from_millis(10));
                            }
                            Err(_) => {
                                if pcm.prepare().is_ok() { recovered = true; }
                                break;
                            }
                        }
                    }
                    recovered
                } else {
                    false
                }
            }

            fn write_bytes(pcm: &alsa::PCM, data: &[u8], fmt: &PcmFormat, fw: &AtomicU64, silence_buf: &[u8]) -> Result<(), &'static str> {
                let frame_size = fmt.channels as usize * fmt.bytes_per_sample as usize;
                if frame_size == 0 { return Ok(()); }
                let mut offset = 0;
                while offset < data.len() {
                    let result = {
                        let io = pcm.io_bytes();
                        io.writei(&data[offset..])
                    }; // io dropped here — flag cleared before any recovery
                    match result {
                        Ok(0) => break, // sub-frame remnant
                        Ok(frames) => {
                            offset += frames * frame_size;
                            fw.fetch_add(frames as u64, Ordering::Relaxed);
                        }
                        Err(e) => {
                            let errno = e.errno();
                            if alsa_recover(pcm, errno) {
                                let kick_frames = (fmt.sample_rate as usize * 50) / 1000;
                                let kick_bytes = kick_frames * frame_size;
                                let io = pcm.io_bytes();
                                let _ = io.writei(&silence_buf[..kick_bytes.min(silence_buf.len())]);
                            } else if errno == libc::ENODEV {
                                return Err("device_disconnected");
                            } else {
                                log::error!("[alsa-writer] write error: {e}");
                                return Err("write_error");
                            }
                        }
                    }
                }
                Ok(())
            }

            fn write_silence(pcm: &alsa::PCM, buf: &[u8]) -> bool {
                let result = {
                    let io = pcm.io_bytes();
                    io.writei(buf)
                }; // io dropped here
                match result {
                    Ok(_) => {}
                    Err(e) if alsa_recover(pcm, e.errno()) => {
                        let io = pcm.io_bytes();
                        let _ = io.writei(buf);
                    }
                    Err(e) => {
                        log::error!("[alsa-writer] silence write error: {e}");
                        return false;
                    }
                }
                true
            }

            /// Scale raw PCM samples in-place by a volume multiplier.
            fn apply_volume(data: &mut [u8], fmt: &PcmFormat, vol: f32) {
                if (vol - 1.0).abs() < f32::EPSILON {
                    return; // unity gain — no-op
                }
                match fmt.gst_format.as_str() {
                    "S16LE" => {
                        for chunk in data.chunks_exact_mut(2) {
                            let s = i16::from_le_bytes([chunk[0], chunk[1]]);
                            let v = (s as f32 * vol).round() as i32;
                            let clamped = v.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
                            chunk.copy_from_slice(&clamped.to_le_bytes());
                        }
                    }
                    "S32LE" => {
                        for chunk in data.chunks_exact_mut(4) {
                            let s = i32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                            let v = (s as f64 * vol as f64).round() as i64;
                            let clamped = v.clamp(i32::MIN as i64, i32::MAX as i64) as i32;
                            chunk.copy_from_slice(&clamped.to_le_bytes());
                        }
                    }
                    "S24_32LE" => {
                        for chunk in data.chunks_exact_mut(4) {
                            let s = i32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                            let v = (s as f64 * vol as f64).round() as i64;
                            let clamped = v.clamp(-8_388_608, 8_388_607) as i32;
                            chunk.copy_from_slice(&clamped.to_le_bytes());
                        }
                    }
                    "S24LE" => {
                        for chunk in data.chunks_exact_mut(3) {
                            let raw = chunk[0] as i32 | (chunk[1] as i32) << 8 | (chunk[2] as i8 as i32) << 16;
                            let v = (raw as f64 * vol as f64).round() as i64;
                            let clamped = v.clamp(-8_388_608, 8_388_607) as i32;
                            chunk[0] = clamped as u8;
                            chunk[1] = (clamped >> 8) as u8;
                            chunk[2] = (clamped >> 16) as u8;
                        }
                    }
                    "F32LE" => {
                        for chunk in data.chunks_exact_mut(4) {
                            let s = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                            chunk.copy_from_slice(&(s * vol).clamp(-1.0, 1.0).to_le_bytes());
                        }
                    }
                    _ => {}
                }
            }

            /// Close and reopen ALSA device with new format.
            /// Some hardware (e.g. XMOS USB controllers) can't reconfigure
            /// HW params in-place after snd_pcm_drop() — need full close+reopen.
            fn reopen_alsa(
                device: &str,
                fmt: &PcmFormat,
                sr: &AtomicU32,
                sbuf: &mut Vec<u8>,
                bit_perfect: bool,
            ) -> Result<(alsa::PCM, PcmFormat), String> {
                let pcm = alsa::PCM::new(device, alsa::Direction::Playback, false)
                    .map_err(|e| format!("Failed to reopen ALSA device: {e}"))?;
                let negotiated = configure_alsa_hwparams(&pcm, fmt, bit_perfect)?;
                pcm.prepare().map_err(|e| format!("pcm.prepare: {e}"))?;
                sr.store(negotiated.sample_rate, Ordering::Relaxed);
                let silence_frames = (negotiated.sample_rate as usize * 50) / 1000;
                *sbuf = vec![0u8; silence_frames * negotiated.channels as usize * negotiated.bytes_per_sample as usize];
                Ok((pcm, negotiated))
            }

            fn drain_writer_rx(rx: &crossbeam_channel::Receiver<WriterCommand>) -> bool {
                while let Ok(cmd) = rx.try_recv() {
                    if let WriterCommand::Shutdown = cmd { return true; }
                }
                false
            }

            log::info!(
                "[alsa-writer] started, device={device}, format={}, rate={}Hz, channels={}, bps={}, combined_vol={}",
                current_fmt.gst_format, current_fmt.sample_rate, current_fmt.channels, current_fmt.bytes_per_sample,
                f32::from_bits(combined_vol.load(Ordering::Relaxed))
            );

            'main: loop {
                match rx.recv_timeout(period_duration) {
                    Ok(WriterCommand::Data(mut chunk)) => {
                        if chunk.generation < writer_gen.load(Ordering::Acquire) {
                            continue; // discard stale data from old pipeline
                        }

                        // Pause: freeze output immediately, spin until resumed
                        if paused.load(Ordering::Acquire) {
                            let can_hw = pcm.state() == alsa::pcm::State::Running
                                && pcm.hw_params_current().map(|p| p.can_pause()).unwrap_or(false);
                            if can_hw { pcm.pause(true).ok(); }

                            while paused.load(Ordering::Acquire) {
                                if can_hw {
                                    // HW pause: DAC frozen, nothing to feed — just sleep
                                    std::thread::sleep(std::time::Duration::from_millis(50));
                                } else {
                                    // SW pause: blocking writei paces the thread (~50ms per period)
                                    if !write_silence(&pcm, &silence_buf) {
                                        *decoded_cell.lock().unwrap() = None;
                                        *output_cell.lock().unwrap() = None;
                                        app_handle.emit("audio-error",
                                            serde_json::json!({ "kind": "device_disconnected" })).ok();
                                        tearing_down.store(true, Ordering::SeqCst);
                                        break 'main;
                                    }
                                }
                            }

                            if can_hw {
                                pcm.pause(false).ok();
                            } else {
                                // Clear silence from ring buffer after software pause
                                pcm.drop().ok();
                                pcm.prepare().ok();
                            }

                            // Re-check generation — may have changed during pause (track change)
                            if chunk.generation < writer_gen.load(Ordering::Acquire) {
                                continue;
                            }
                        }

                        if chunk.format != current_fmt {
                            log::info!("[alsa-writer] format change: {current_fmt:?} -> {:?}", chunk.format);
                            sp.set_decoded(&chunk.format.gst_format, chunk.format.sample_rate, chunk.format.channels);
                            drop(pcm);
                            match reopen_alsa(&device, &chunk.format, &current_sample_rate, &mut silence_buf, bit_perfect) {
                                Ok((new_pcm, negotiated)) => {
                                    pcm = new_pcm;
                                    if negotiated.gst_format != chunk.format.gst_format
                                        || negotiated.channels != chunk.format.channels {
                                        log::error!(
                                            "[alsa-writer] format mismatch after reopen: chunk={}/{}ch, ALSA={}/{}ch",
                                            chunk.format.gst_format, chunk.format.channels,
                                            negotiated.gst_format, negotiated.channels
                                        );
                                        app_handle.emit("audio-error",
                                            serde_json::json!({ "kind": "device_changed" })).ok();
                                        tearing_down.store(true, Ordering::SeqCst);
                                        return;
                                    }
                                    sp.set_output(&negotiated.gst_format, negotiated.sample_rate, negotiated.channels);
                                    if !bit_perfect && chunk.format.gst_format != negotiated.gst_format {
                                        sp.record_format_fallback(&chunk.format.gst_format, &negotiated.gst_format);
                                    } else {
                                        sp.clear_format_fallback();
                                    }
                                    current_fmt = negotiated;
                                }
                                Err(e) => {
                                    log::error!("[alsa-writer] reopen failed: {e}");
                                    app_handle.emit("audio-error", serde_json::json!({ "kind": "format_change_failed", "message": e })).ok();
                                    tearing_down.store(true, Ordering::SeqCst);
                                    return; // pcm already dropped, just exit thread
                                }
                            }
                        }
                        resolve_pending(&mut pending_promotion_from, &current_fmt);
                        let vol = f32::from_bits(combined_vol.load(Ordering::Relaxed));
                        apply_volume(&mut chunk.data, &current_fmt, vol);
                        if let Err(kind) = write_bytes(&pcm, &chunk.data, &current_fmt, &frames_written, &silence_buf) {
                            app_handle.emit("audio-error", serde_json::json!({ "kind": kind })).ok();
                            tearing_down.store(true, Ordering::SeqCst);
                            break;
                        }
                    }

                    Ok(WriterCommand::FormatHint(new_fmt)) => {
                        sp.set_decoded(&new_fmt.gst_format, new_fmt.sample_rate, new_fmt.channels);
                        if new_fmt != current_fmt {
                            log::info!("[alsa-writer] format hint: {current_fmt:?} -> {new_fmt:?}");
                            let requested = new_fmt.clone();
                            drop(pcm);
                            match reopen_alsa(&device, &new_fmt, &current_sample_rate, &mut silence_buf, bit_perfect) {
                                Ok((new_pcm, negotiated)) => {
                                    pcm = new_pcm;
                                    // Format fallback is allowed here (handled below); a
                                    // CHANNEL mismatch is not — it would misframe writes.
                                    if negotiated.channels != requested.channels {
                                        log::error!(
                                            "[alsa-writer] channel mismatch after format-hint reopen: requested={}ch, ALSA={}ch",
                                            requested.channels, negotiated.channels
                                        );
                                        app_handle.emit("audio-error",
                                            serde_json::json!({ "kind": "device_changed" })).ok();
                                        tearing_down.store(true, Ordering::SeqCst);
                                        return;
                                    }
                                    sp.set_output(&negotiated.gst_format, negotiated.sample_rate, negotiated.channels);
                                    if !bit_perfect && requested.gst_format != negotiated.gst_format {
                                        sp.record_format_fallback(&requested.gst_format, &negotiated.gst_format);
                                    } else {
                                        sp.clear_format_fallback();
                                    }
                                    current_fmt = negotiated;
                                }
                                Err(e) => {
                                    log::error!("[alsa-writer] reopen for format hint failed: {e}");
                                    app_handle.emit("audio-error", serde_json::json!({ "kind": "format_change_failed", "message": e })).ok();
                                    tearing_down.store(true, Ordering::SeqCst);
                                    return;
                                }
                            }
                        }
                        resolve_pending(&mut pending_promotion_from, &current_fmt);
                    }

                    Ok(WriterCommand::Resampling { from, to }) => {
                        log::info!("[alsa-writer] resampling: {}kHz -> {}kHz", from / 1000, to / 1000);
                        sp.record_resample(from, to);
                        app_handle.emit("audio-resampled",
                            serde_json::json!({ "from": from, "to": to })).ok();
                    }

                    Ok(WriterCommand::PendingPromotion { from, generation }) => {
                        if generation < writer_gen.load(Ordering::Acquire) {
                            continue; // stale promotion from old pipeline
                        }
                        // Last-write-wins: overwrites any prior unresolved pending.
                        // resolve_pending will fire sp.record_bit_depth_promotion()
                        // once the actually-negotiated format is known.
                        pending_promotion_from = Some(from);
                    }

                    Ok(WriterCommand::EndOfTrack { emit_finished, generation }) => {
                        if generation < writer_gen.load(Ordering::Acquire) {
                            continue; // stale EOS from old pipeline
                        }
                        let got_shutdown = drain_writer_rx(&rx);
                        if !write_silence(&pcm, &silence_buf) {
                            *decoded_cell.lock().unwrap() = None;
                            *output_cell.lock().unwrap() = None;
                            app_handle.emit("audio-error",
                                serde_json::json!({ "kind": "device_disconnected" })).ok();
                            tearing_down.store(true, Ordering::SeqCst);
                            break 'main;
                        }

                        if emit_finished && !tearing_down.load(Ordering::SeqCst) {
                            log::debug!("[alsa-writer] emitting track-finished");
                            app_handle.emit("track-finished", ()).ok();
                        }

                        if got_shutdown { break; }

                        // Idle silence loop — keep DAC clock alive between tracks
                        log::debug!("[alsa-writer] entering idle silence loop");
                        loop {
                            if !write_silence(&pcm, &silence_buf) {
                                *decoded_cell.lock().unwrap() = None;
                                *output_cell.lock().unwrap() = None;
                                app_handle.emit("audio-error",
                                    serde_json::json!({ "kind": "device_disconnected" })).ok();
                                tearing_down.store(true, Ordering::SeqCst);
                                break 'main;
                            }
                            match rx.try_recv() {
                                Ok(WriterCommand::Data(mut chunk)) => {
                                    if chunk.generation < writer_gen.load(Ordering::Acquire) {
                                        continue; // discard stale data, stay in idle
                                    }
                                    if chunk.format != current_fmt {
                                        sp.set_decoded(&chunk.format.gst_format, chunk.format.sample_rate, chunk.format.channels);
                                        // reopen_alsa drops old PCM — buffer cleared implicitly
                                        drop(pcm);
                                        match reopen_alsa(&device, &chunk.format, &current_sample_rate, &mut silence_buf, bit_perfect) {
                                            Ok((new_pcm, negotiated)) => {
                                                pcm = new_pcm;
                                                if negotiated.gst_format != chunk.format.gst_format
                                                    || negotiated.channels != chunk.format.channels {
                                                    log::error!(
                                                        "[alsa-writer] format mismatch after reopen (idle): chunk={}/{}ch, ALSA={}/{}ch",
                                                        chunk.format.gst_format, chunk.format.channels,
                                                        negotiated.gst_format, negotiated.channels
                                                    );
                                                    app_handle.emit("audio-error",
                                                        serde_json::json!({ "kind": "device_changed" })).ok();
                                                    tearing_down.store(true, Ordering::SeqCst);
                                                    return;
                                                }
                                                sp.set_output(&negotiated.gst_format, negotiated.sample_rate, negotiated.channels);
                                                if !bit_perfect && chunk.format.gst_format != negotiated.gst_format {
                                                    sp.record_format_fallback(&chunk.format.gst_format, &negotiated.gst_format);
                                                } else {
                                                    sp.clear_format_fallback();
                                                }
                                                current_fmt = negotiated;
                                            }
                                            Err(e) => {
                                                log::error!("[alsa-writer] reopen failed in idle: {e}");
                                                app_handle.emit("audio-error", serde_json::json!({ "kind": "format_change_failed", "message": e })).ok();
                                                return;
                                            }
                                        }
                                    } else {
                                        // Same format — flush stale silence from ring buffer
                                        pcm.drop().ok();
                                        pcm.prepare().ok();
                                    }
                                    resolve_pending(&mut pending_promotion_from, &current_fmt);
                                    let vol = f32::from_bits(combined_vol.load(Ordering::Relaxed));
                                    apply_volume(&mut chunk.data, &current_fmt, vol);
                                    if let Err(kind) = write_bytes(&pcm, &chunk.data, &current_fmt, &frames_written, &silence_buf) {
                                        app_handle.emit("audio-error", serde_json::json!({ "kind": kind })).ok();
                                        break 'main;
                                    }
                                    break; // back to main loop
                                }
                                Ok(WriterCommand::Shutdown) => break 'main,
                                Ok(WriterCommand::Flush) => { drain_writer_rx(&rx); pcm.drop().ok(); pcm.prepare().ok(); pending_promotion_from = None; break; }
                                Ok(WriterCommand::FormatHint(new_fmt)) => {
                                    sp.set_decoded(&new_fmt.gst_format, new_fmt.sample_rate, new_fmt.channels);
                                    if new_fmt != current_fmt {
                                        log::info!("[alsa-writer] format hint (idle): {current_fmt:?} -> {new_fmt:?}");
                                        let requested = new_fmt.clone();
                                        drop(pcm);
                                        match reopen_alsa(&device, &new_fmt, &current_sample_rate, &mut silence_buf, bit_perfect) {
                                            Ok((new_pcm, negotiated)) => {
                                                pcm = new_pcm;
                                                if negotiated.channels != requested.channels {
                                                    log::error!(
                                                        "[alsa-writer] channel mismatch after format-hint reopen (idle): requested={}ch, ALSA={}ch",
                                                        requested.channels, negotiated.channels
                                                    );
                                                    app_handle.emit("audio-error",
                                                        serde_json::json!({ "kind": "device_changed" })).ok();
                                                    tearing_down.store(true, Ordering::SeqCst);
                                                    return;
                                                }
                                                sp.set_output(&negotiated.gst_format, negotiated.sample_rate, negotiated.channels);
                                                if !bit_perfect && requested.gst_format != negotiated.gst_format {
                                                    sp.record_format_fallback(&requested.gst_format, &negotiated.gst_format);
                                                } else {
                                                    sp.clear_format_fallback();
                                                }
                                                current_fmt = negotiated;
                                            }
                                            Err(e) => {
                                                log::error!("[alsa-writer] reopen for format hint failed (idle): {e}");
                                                app_handle.emit("audio-error", serde_json::json!({ "kind": "format_change_failed", "message": e })).ok();
                                                return;
                                            }
                                        }
                                    }
                                    resolve_pending(&mut pending_promotion_from, &current_fmt);
                                }
                                Ok(WriterCommand::Resampling { from, to }) => {
                                    sp.record_resample(from, to);
                                }
                                Ok(WriterCommand::PendingPromotion { from, generation }) => {
                                    if generation < writer_gen.load(Ordering::Acquire) {
                                        continue;
                                    }
                                    pending_promotion_from = Some(from);
                                }
                                Ok(_) => {}
                                Err(crossbeam_channel::TryRecvError::Empty) => {}
                                Err(crossbeam_channel::TryRecvError::Disconnected) => break 'main,
                            }
                        }
                    }

                    Ok(WriterCommand::Flush) => {
                        drain_writer_rx(&rx);
                        pcm.drop().ok();
                        pcm.prepare().ok();
                        pending_promotion_from = None;
                    }

                    Ok(WriterCommand::Shutdown) => {
                        log::debug!("[alsa-writer] shutdown");
                        pcm.drop().ok();
                        break;
                    }

                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                        if !write_silence(&pcm, &silence_buf) {
                            *decoded_cell.lock().unwrap() = None;
                            *output_cell.lock().unwrap() = None;
                            app_handle.emit("audio-error",
                                serde_json::json!({ "kind": "device_disconnected" })).ok();
                            tearing_down.store(true, Ordering::SeqCst);
                            break 'main;
                        }
                    }

                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                        log::debug!("[alsa-writer] channel disconnected");
                        pcm.drop().ok();
                        break;
                    }
                }
            }

            log::info!("[alsa-writer] thread exiting");
        })
        .map_err(|e| format!("Failed to spawn ALSA writer thread: {e}"))?;

    Ok((tx, handle, negotiated_fmt, supported_gst_formats, supported_rates))
}

// ── Audio command protocol ─────────────────────────────────────────────

enum AudioCommand {
    PlayUrl {
        uri: String,
        /// Where the new pipeline should start. `None` is a normal track start;
        /// `Some` is a rebuild that has to resume where the torn-down pipeline
        /// was, which is how a mid-track route change stays inaudible.
        start_secs: Option<f32>,
        reply: Reply<Result<(), String>>,
    },
    Pause {
        reply: Reply<Result<(), String>>,
    },
    Resume {
        reply: Reply<Result<(), String>>,
    },
    Stop {
        reply: Reply<Result<(), String>>,
    },
    SetVolume {
        level: f32,
        reply: Reply<Result<(), String>>,
    },
    SetNormalizationGain {
        gain: f64,
        reply: Reply<Result<(), String>>,
    },
    Seek {
        position_secs: f32,
        reply: Reply<Result<(), String>>,
    },
    GetPosition {
        reply: Reply<Result<f32, String>>,
    },
    IsFinished {
        reply: Reply<Result<bool, String>>,
    },
    SetExclusiveMode {
        enabled: bool,
        device: Option<String>,
        reply: Reply<Result<(), String>>,
    },
    SetBitPerfect {
        enabled: bool,
        reply: Reply<Result<(), String>>,
    },
    SetProxySettings {
        settings: crate::ProxySettings,
        reply: Reply<()>,
    },
    SetGapless {
        enabled: bool,
        reply: Reply<Result<(), String>>,
    },
    // 2b-A2: fields drive the preroll attach (uri, gating metadata, qid).
    SetNextTrack {
        uri: String,
        norm_gain: f64,
        track_id: u64,
        qid: String,
        replay_gain: f64,
        peak_amplitude: f64,
        is_dash: bool,
        reply: Reply<Result<(), String>>,
    },
    ClearNextTrack {
        reply: Reply<Result<(), String>>,
    },
    /// 2b-A3: emitted by concat's notify::active-pad handler once it has verified
    /// (by pad identity) that concat switched to the prerolled next branch.
    /// Fieldless (C6) — the handler reads everything from the `next_bin` slot.
    HandleGaplessAdvance,
    /// 2b-A3: forwarded by the Normal bus watcher when an Error originates inside
    /// the prerolled next bin. The worker detaches that bin (gated on
    /// !next_active) without disturbing the currently-playing track.
    HandleNextBinError,
    ListDevices {
        reply: Reply<Result<Vec<AudioDevice>, String>>,
    },
}

// ── AudioPlayer (public API unchanged) ─────────────────────────────────

#[derive(Clone)]
pub struct AudioPlayer {
    cmd_tx: mpsc::Sender<AudioCommand>,
    /// Latest exclusive ALSA device set via `SetExclusiveMode`. Mirrored from
    /// the audio thread so the pipeline probe can read it without messaging.
    exclusive_device: Arc<Mutex<Option<String>>>,
    decoded_caps_cell: Arc<Mutex<Option<crate::pipeline_probe::PadCaps>>>,
    output_caps_cell: Arc<Mutex<Option<crate::pipeline_probe::PadCaps>>>,
}

impl AudioPlayer {
    pub fn new(
        app_handle: tauri::AppHandle,
        signal_path: Arc<SignalPathTracker>,
        proxy_settings: crate::ProxySettings,
    ) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel::<AudioCommand>();
        // Clone a self-sender into the worker so the Normal bus thread can send
        // HandleGaplessAdvance back to this loop (Task 3). `cmd_tx` itself is
        // owned by AudioPlayer, not the worker closure.
        let cmd_tx_worker = cmd_tx.clone();
        let exclusive_device: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let exclusive_device_thread = exclusive_device.clone();
        let decoded_caps_cell: Arc<Mutex<Option<crate::pipeline_probe::PadCaps>>> =
            Arc::new(Mutex::new(None));
        let output_caps_cell: Arc<Mutex<Option<crate::pipeline_probe::PadCaps>>> =
            Arc::new(Mutex::new(None));
        let decoded_cell_thread = Arc::clone(&decoded_caps_cell);
        let output_cell_thread = Arc::clone(&output_caps_cell);

        std::thread::spawn(move || {
            // GST_PLUGIN_PATH is set in main(), before any thread exists.
            gst::init().expect("Failed to initialize GStreamer");

            // Captured once, before anything promotes it. Re-reading this at a
            // later call site would bake the promoted rank in as "original" and
            // the rank would never come back down.
            let original_curl_rank =
                gst::ElementFactory::find("curlhttpsrc").map(|factory| factory.rank());
            let probed = probe_host_caps();

            // Seed from the settings the constructor already received. Without
            // this, nothing pushes a route until the user next presses Save, and
            // a launch with a saved proxy would play every track direct. Moved in
            // by value: `audio_proxy` below is the one live copy the worker reads,
            // and `SetProxySettings` replaces it, so a second shared cell would
            // only be written and never read.
            let audio_proxy = Arc::new(Mutex::new(AudioProxy::new(proxy_settings, probed)));

            // Promotion follows whichever tier is routable; when both are, the
            // routes are identical, so either answers the credentials question.
            {
                let ap = audio_proxy
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let probe_route = ap
                    .route_for(crate::proxy::Capability::Lossy)
                    .or_else(|_| ap.route_for(crate::proxy::Capability::Dash))
                    .unwrap_or(crate::proxy::Route::NoProxy);
                promote_curl_source(&probe_route, original_curl_rank);
            }

            let mut backend: Option<PlaybackBackend> = None;
            // ALSA writer state — lives outside PlaybackBackend so it persists across track changes
            let mut writer_tx: Option<crossbeam_channel::Sender<WriterCommand>> = None;
            let mut writer_thread: Option<JoinHandle<()>> = None;
            let mut writer_fmt: Option<PcmFormat> = None;
            let mut writer_supported_fmts: Option<Vec<&'static str>> = None;
            let mut writer_supported_rates: Option<Vec<u32>> = None;
            let mut writer_device: Option<String> = None;
            // Track the mode the live writer was spawned in. `bit_perfect` is
            // baked into the writer thread at spawn (it drives reopen format
            // negotiation), so a same-device exclusive↔bit-perfect toggle must
            // force a respawn rather than reuse a stale-mode writer.
            let mut writer_bit_perfect: Option<bool> = None;
            let frames_written = Arc::new(AtomicU64::new(0));
            let current_sample_rate = Arc::new(AtomicU32::new(48000));
            let writer_gen = Arc::new(AtomicU64::new(0));
            let paused = Arc::new(AtomicBool::new(false));
            let combined_vol = Arc::new(AtomicU32::new(1.0_f32.to_bits()));

            let eos = Arc::new(AtomicBool::new(false));
            let tearing_down = Arc::new(AtomicBool::new(false));
            let has_uri = AtomicBool::new(false);

            let mut exclusive = false;
            let mut bit_perfect = false;
            let mut device: Option<String> = None;

            let mut current_volume: f64 = 1.0;
            let mut current_norm_gain: f64 = 1.0;
            let mut track_generation: u64 = 0;
            // 2b: under `concat` (adjust-base=true), `query_position(TIME)` re-bases
            // to ~0 at each track boundary — it is per-track, NOT cumulative. So the
            // 2a `position_offset_ns` capture/subtract mechanism is gone (C2).

            // Gapless state. `gapless_setting` defaults to true and is pushed
            // from saved settings at startup via `set_gapless` (the worker has
            // no access to AppState). `cmd_tx_worker` is the self-sender the
            // Normal bus thread clones for gapless advance handling (2b-A3).
            let mut gapless_setting: bool = true;
            let cmd_tx_worker = cmd_tx_worker;

            // 2b-A2: the prerolled next bin. Shared between this worker (dedup /
            // replace / gating), the attach executor (which fills it), and the
            // notify::active-pad handler (2b-A3 advance). Locking is brief and
            // never held across a blocking GStreamer call: the worker locks only
            // to read `track_id`/`qid` for dedup or to overwrite the slot on
            // dispatch; the executor locks only to store/clear after the
            // (off-thread) attach completes. No lock is held across `pipeline.add`
            // / `sync_state_with_parent` / `set_state(Null)` → no deadlock path.
            let next_bin: Arc<Mutex<Option<NextBinState>>> = Arc::new(Mutex::new(None));
            // Set true by 2b-A3's notify handler while concat is switching to the
            // next bin; gates detach/replace (C5) so we never tear down a bin
            // mid-advance. Read by 2b-A3.
            let next_active = Arc::new(AtomicBool::new(false));
            // 2b-A3: the (uridecodebin, branch_queue) of the CURRENTLY-PLAYING
            // track's branch (concat sink_0 at build time). On a gapless advance
            // this finished branch is detached and replaced by the promoted next
            // branch. None when no Normal pipeline is live (or DirectAlsa).
            let mut current_branch: Option<(gst::Element, gst::Element)> = None;
            // The URI of whatever is playing now. The worker otherwise retains
            // none: `uri` is local to the `PlayUrl` arm, and the only surviving
            // state is `has_uri`. Without it a route change mid-track has nothing
            // to re-issue, and this whole path is a no-op.
            let mut current_uri: Option<String> = None;
            // Bumped by every `SetProxySettings`. The executor snapshots it before
            // it starts prerolling and re-reads it under the `next_bin` mutex
            // before storing, so a branch built under the previous route is
            // discarded instead of being armed as the next playing track.
            let route_generation = Arc::new(AtomicU64::new(0));
            // The generation the live pipeline's hook was built under. Sampled
            // at each build in `PlayUrl`, carried in every `AttachJob::Attach`,
            // and compared there: `SetProxySettings` bumps the generation and
            // only then queues the rebuild on the self-sender, so a
            // `SetNextTrack` landing in that gap is served by the pipeline that
            // is about to be replaced.
            let mut pipeline_route_generation: u64 = 0;

            // Serialized attach/detach executor thread (C3). The worker dispatches
            // jobs here and returns immediately — it never blocks on pad-slot ops.
            let (attach_tx, attach_rx) = mpsc::channel::<AttachJob>();
            {
                let next_bin_exec = Arc::clone(&next_bin);
                let audio_proxy_exec = Arc::clone(&audio_proxy);
                let route_generation_exec = Arc::clone(&route_generation);
                std::thread::spawn(move || {
                    run_attach_executor(
                        attach_rx,
                        next_bin_exec,
                        audio_proxy_exec,
                        route_generation_exec,
                    )
                });
            }

            for cmd in cmd_rx {
                match cmd {
                    AudioCommand::PlayUrl {
                        uri,
                        start_secs,
                        reply,
                    } => {
                        let result = (|| -> Result<(), String> {
                            // ── Teardown old backend (GStreamer pipeline only) ──
                            if let Some(old_backend) = backend.take() {
                                tearing_down.store(true, Ordering::SeqCst);

                                match old_backend {
                                    PlaybackBackend::Normal {
                                        pipeline,
                                        user_volume_el,
                                        ..
                                    } => {
                                        if let Some(bus) = pipeline.bus() {
                                            bus.set_flushing(true);
                                        }
                                        let old_pipe = pipeline;
                                        std::thread::spawn(move || {
                                            // Fade out
                                            if let Some(ref vol) = user_volume_el {
                                                for i in (0..=10).rev() {
                                                    vol.set_property("volume", slider_to_amplitude(current_volume) * (i as f64 / 10.0));
                                                    std::thread::sleep(std::time::Duration::from_millis(10));
                                                }
                                            }
                                            old_pipe.set_state(gst::State::Null).ok();
                                        });
                                    }
                                    PlaybackBackend::DirectAlsa { pipeline, .. } => {
                                        // Unblock writer if paused, then bump generation —
                                        // writer instantly discards stale Data, channel
                                        // drains fast, pipeline can reach Null without blocking.
                                        paused.store(false, Ordering::Release);
                                        track_generation += 1;
                                        writer_gen.store(track_generation, Ordering::Release);
                                        if let Some(ref tx) = writer_tx {
                                            let _ = tx.send_timeout(
                                                WriterCommand::Flush,
                                                std::time::Duration::from_millis(200),
                                            );
                                        }
                                        if let Some(bus) = pipeline.bus() {
                                            bus.set_flushing(true);
                                        }
                                        pipeline.set_state(gst::State::Null).ok();
                                        let _ = pipeline.state(gst::ClockTime::from_mseconds(500));
                                        drop(pipeline);
                                    }
                                }

                                log::debug!("[audio] teardown: complete");
                            }
                            // 2b-A3 (detach matrix): the whole old pipeline is being
                            // torn down (its elements die with it), so we don't dispatch
                            // an executor detach — just null the gapless slots. The
                            // executor detach would be moot (and could race the new
                            // pipeline). Clearing `next_active` releases any in-flight
                            // advance gate, which is correct on a hard re-play.
                            if let Ok(mut g) = next_bin.lock() {
                                *g = None;
                            }
                            next_active.store(false, Ordering::Release);
                            current_branch = None;

                            tearing_down.store(false, Ordering::SeqCst);
                            eos.store(false, Ordering::SeqCst);
                            has_uri.store(true, Ordering::SeqCst);
                            frames_written.store(0, Ordering::Relaxed);

                            *decoded_cell_thread.lock().unwrap() = None;
                            *output_cell_thread.lock().unwrap() = None;
                            signal_path.reset_for_track();
                            if exclusive || bit_perfect {
                                signal_path.set_backend("DirectAlsa", device.clone());
                            } else {
                                signal_path.set_backend("Normal", None);
                            }
                            signal_path.set_audio_modes(exclusive, bit_perfect);

                            // One decision for both arms below. Each used to
                            // sniff the URI for itself, and neither could see
                            // the other's answer.
                            let is_dash = uri.starts_with("data:application/dash");
                            let route = {
                                let ap = audio_proxy.lock().unwrap_or_else(|p| p.into_inner());
                                ap.route_for(capability_of(is_dash))
                            };
                            let route = match route {
                                Ok(r) => r,
                                Err(blocked) => {
                                    // Refuse rather than play direct. This is the
                                    // containment boundary: the gapless advance
                                    // path reaches no Tauri command, so a
                                    // command-layer check cannot cover it.
                                    log::warn!("[proxy] refusing playback: {}", blocked.cause);
                                    return Err(format!("proxy blocked: {}", blocked.cause));
                                }
                            };
                            if matches!(route, crate::proxy::Route::Via { .. })
                                && !http_source_is_configurable()
                            {
                                return Err("proxy blocked: this system's https source \
                                            cannot be pointed at a proxy"
                                    .to_string());
                            }
                            // Stamp the pipeline both arms below are about to
                            // build with the generation this route came from.
                            pipeline_route_generation = route_generation.load(Ordering::Acquire);

                            if exclusive || bit_perfect {
                                // ── DirectAlsa path ──
                                #[cfg(not(target_os = "linux"))]
                                return Err("Exclusive/bit-perfect mode requires Linux".into());

                                #[cfg(target_os = "linux")]
                                {
                                    let dev = device.as_deref().ok_or_else(|| {
                                        "No audio device selected for exclusive mode".to_string()
                                    })?;

                                    let default_fmt = PcmFormat {
                                        sample_rate: 48000,
                                        channels: 2,
                                        gst_format: "S32LE".to_string(),
                                        bytes_per_sample: 4,
                                    };

                                    // Bump generation again: the old appsink may have
                                    // pushed chunks (stamped gen N+1) from its internal
                                    // queue between the Flush and set_state(Null).
                                    // Gen N+2 causes the writer to discard them instantly
                                    // instead of writing each to ALSA at audio rate (~85ms).
                                    track_generation += 1;
                                    writer_gen.store(track_generation, Ordering::Release);

                                    // Reuse writer if alive, otherwise spawn new one
                                    let writer_alive = writer_thread
                                        .as_ref()
                                        .map(|h| !h.is_finished())
                                        .unwrap_or(false);

                                    let device_changed = writer_device.as_deref() != Some(dev);
                                    let mode_changed = writer_bit_perfect != Some(bit_perfect);

                                    if !writer_alive || writer_tx.is_none() || device_changed || mode_changed {
                                        // Shut down old writer cleanly
                                        if let Some(tx) = writer_tx.take() {
                                            tx.try_send(WriterCommand::Shutdown).ok();
                                        }
                                        if let Some(h) = writer_thread.take() {
                                            h.join().ok();
                                        }
                                        let (tx, handle, negotiated_fmt, supported_gst_fmts, supported_rates) = spawn_alsa_writer(
                                            dev,
                                            &default_fmt,
                                            app_handle.clone(),
                                            Arc::clone(&tearing_down),
                                            Arc::clone(&frames_written),
                                            Arc::clone(&current_sample_rate),
                                            Arc::clone(&writer_gen),
                                            Arc::clone(&paused),
                                            bit_perfect,
                                            Arc::clone(&combined_vol),
                                            Arc::clone(&signal_path),
                                            Arc::clone(&decoded_cell_thread),
                                            Arc::clone(&output_cell_thread),
                                        )?;
                                        writer_tx = Some(tx);
                                        writer_thread = Some(handle);
                                        writer_fmt = Some(negotiated_fmt);
                                        writer_supported_fmts = Some(supported_gst_fmts);
                                        writer_supported_rates = Some(supported_rates);
                                        writer_device = Some(dev.to_string());
                                        writer_bit_perfect = Some(bit_perfect);
                                    }

                                    let wtx = writer_tx.as_ref().unwrap().clone();

                                    // Build appsink pipeline
                                    let fmt_for_pipeline = writer_fmt.as_ref().unwrap_or(&default_fmt);
                                    let supported_fmts_for_pipeline = writer_supported_fmts.as_deref().unwrap_or(&["S32LE"]);
                                    let supported_rates_for_pipeline = writer_supported_rates.as_deref().unwrap_or(&[44100, 48000]);
                                    let (pipe, u_vol, n_vol) = build_appsink_pipeline(
                                        &uri,
                                        is_dash,
                                        route,
                                        exclusive,
                                        bit_perfect,
                                        wtx.clone(),
                                        Arc::clone(&writer_gen),
                                        fmt_for_pipeline,
                                        supported_fmts_for_pipeline,
                                        supported_rates_for_pipeline,
                                        Arc::clone(&decoded_cell_thread),
                                        Arc::clone(&output_cell_thread),
                                    )?;

                                    // Start pipeline directly — errors come via bus watcher
                                    pipe.set_state(gst::State::Playing)
                                        .map_err(|e| format!("Failed to start playback: {e}"))?;

                                    // Bus watcher: decode errors + EOS → forward to writer
                                    let eos_flag = Arc::clone(&eos);
                                    let app_handle_clone = app_handle.clone();
                                    let writer_tx_bus = wtx;
                                    let bus_gen = Arc::clone(&writer_gen);
                                    let tearing_down_bus = Arc::clone(&tearing_down);
                                    if let Some(bus) = pipe.bus() {
                                        std::thread::spawn(move || {
                                            for msg in bus.iter_timed(gst::ClockTime::NONE) {
                                                match msg.view() {
                                                    gst::MessageView::Eos(..) => {
                                                        eos_flag.store(true, Ordering::SeqCst);
                                                        writer_tx_bus
                                                            .send(WriterCommand::EndOfTrack {
                                                                emit_finished: true,
                                                                generation: bus_gen
                                                                    .load(Ordering::Acquire),
                                                            })
                                                            .ok();
                                                        break;
                                                    }
                                                    gst::MessageView::Error(err) => {
                                                        let err_msg = err.error().to_string();
                                                        let debug_str = err
                                                            .debug()
                                                            .map(|s| s.to_string())
                                                            .unwrap_or_default();
                                                        log::error!(
                                                            "GStreamer error: {} (debug: {})",
                                                            err_msg,
                                                            debug_str
                                                        );
                                                        eos_flag.store(true, Ordering::SeqCst);
                                                        if !tearing_down_bus.load(Ordering::SeqCst)
                                                        {
                                                            app_handle_clone
                                                                .emit(
                                                                    "audio-error",
                                                                    serde_json::json!({
                                                                        "kind": "playback_error",
                                                                        "message": err_msg
                                                                    }),
                                                                )
                                                                .ok();
                                                        }
                                                        writer_tx_bus
                                                            .send(WriterCommand::EndOfTrack {
                                                                emit_finished: false,
                                                                generation: bus_gen
                                                                    .load(Ordering::Acquire),
                                                            })
                                                            .ok();
                                                        break;
                                                    }
                                                    gst::MessageView::Buffering(b) => {
                                                        log::debug!(
                                                            "[audio] direct-alsa: buffering {}%",
                                                            b.percent()
                                                        );
                                                    }
                                                    _ => {}
                                                }
                                            }
                                        });
                                    }

                                    backend = Some(PlaybackBackend::DirectAlsa {
                                        pipeline: pipe,
                                        user_volume_el: u_vol,
                                        norm_volume_el: n_vol,
                                    });
                                }
                            } else {
                                // ── Normal path (unchanged) ──
                                // Shut down any lingering ALSA writer from a mode switch
                                if let Some(tx) = writer_tx.take() {
                                    tx.try_send(WriterCommand::Shutdown).ok();
                                }
                                if let Some(h) = writer_thread.take() {
                                    h.join().ok();
                                }

                                let pipe = gst::Pipeline::new();
                                watch_pipeline_sources(&pipe, route);
                                // 2b: legacy `uridecodebin` per branch. `concat` does the
                                // gapless switching, so we no longer need uridecodebin3 /
                                // about-to-finish. Legacy uridecodebin handles Tidal
                                // `data:application/dash+xml` URIs and works on GStreamer
                                // < 1.24.
                                let mut udb =
                                    gst::ElementFactory::make("uridecodebin").property("uri", &uri);
                                if is_dash {
                                    udb = udb
                                        .property("buffer-duration", 15_000_000_000i64)
                                        .property("use-buffering", true);
                                } else {
                                    udb = udb
                                        .property("buffer-duration", 5_000_000_000i64)
                                        .property("use-buffering", true);
                                }
                                let uridecodebin = udb
                                    .build()
                                    .map_err(|e| format!("Failed to create uridecodebin: {e}"))?;
                                // Per-branch upstream queue (C1): decouples the decoder from
                                // concat's gate so the next branch can pre-buffer ahead while
                                // the current track plays. With one branch it's a passthrough.
                                // 15s of decoded reservoir for slow-internet cushion.
                                let branch_queue = gst::ElementFactory::make("queue")
                                    .property("max-size-time", 15_000_000_000u64)
                                    .property("max-size-buffers", 0u32)
                                    .property("max-size-bytes", 0u32)
                                    .build()
                                    .map_err(|e| format!("Failed to create branch queue: {e}"))?;
                                // `concat` at the head of the chain. With a single sink pad it
                                // is a passthrough (identical signal path to the old direct
                                // chain); the gapless second branch attaches in 2b-A2.
                                let concat = gst::ElementFactory::make("concat")
                                    .name("gapless-concat")
                                    .build()
                                    .map_err(|e| format!("Failed to create concat: {e}"))?;
                                let audioconvert = gst::ElementFactory::make("audioconvert")
                                    .build()
                                    .map_err(|e| format!("Failed to create audioconvert: {e}"))?;
                                let audioresample = gst::ElementFactory::make("audioresample")
                                    .build()
                                    .map_err(|e| format!("Failed to create audioresample: {e}"))?;
                                let norm_vol = gst::ElementFactory::make("volume")
                                    .property("volume", current_norm_gain)
                                    .build()
                                    .map_err(|e| format!("Failed to create norm volume: {e}"))?;
                                let user_vol = gst::ElementFactory::make("volume")
                                    .property("volume", slider_to_amplitude(current_volume))
                                    .build()
                                    .map_err(|e| format!("Failed to create user volume: {e}"))?;
                                let sink = gst::ElementFactory::make("autoaudiosink")
                                    .build()
                                    .map_err(|e| format!("Failed to create autoaudiosink: {e}"))?;

                                pipe.add_many([
                                    &uridecodebin,
                                    &branch_queue,
                                    &concat,
                                    &audioconvert,
                                    &audioresample,
                                    &norm_vol,
                                    &user_vol,
                                    &sink,
                                ])
                                .map_err(|e| format!("Failed to add elements: {e}"))?;
                                // Static chain: concat → audioconvert → … → sink.
                                // (uridecodebin → branch_queue is dynamic via pad_added;
                                // branch_queue.src → concat sink_0 is linked below.)
                                gst::Element::link_many([
                                    &concat,
                                    &audioconvert,
                                    &audioresample,
                                    &norm_vol,
                                    &user_vol,
                                    &sink,
                                ])
                                .map_err(|e| format!("Failed to link chain: {e}"))?;

                                // N2: connect notify::active-pad BEFORE requesting sink_0.
                                // gstconcat fires `notify` synchronously inside
                                // request_pad_simple when current_sinkpad is NULL; the
                                // first-fire-suppressing counter absorbs that.
                                //
                                // 2b-A3 (C4): on every subsequent fire we gate on
                                // active-pad IDENTITY, not a bare counter. We read
                                // `concat.active-pad` and only treat it as a gapless
                                // advance when its peer's parent is the currently-prerolled
                                // next bin's `branch_queue`. A transition to `None` (final
                                // EOS) or to a stale/unknown pad is ignored. This makes the
                                // handler robust across attach/detach churn.
                                let notify_count = Arc::new(AtomicU32::new(0));
                                let next_bin_notify = Arc::clone(&next_bin);
                                let next_active_notify = Arc::clone(&next_active);
                                let cmd_tx_notify = cmd_tx_worker.clone();
                                concat.connect_notify(Some("active-pad"), move |concat, _pspec| {
                                    let prev = notify_count.fetch_add(1, Ordering::AcqRel);
                                    if prev == 0 {
                                        // Initial sink_0 activation from request_pad_simple.
                                        log::debug!("[gapless-diag] notify active-pad fire #1 (initial sink_0), suppressed");
                                        return;
                                    }
                                    // Read the new active pad. None → final EOS transition; ignore.
                                    let Some(active_pad) = concat.property::<Option<gst::Pad>>("active-pad")
                                    else {
                                        // Dump concat's sink-pad situation so we can tell WHY it
                                        // went terminal: did sink_1 exist at all (timing), and was
                                        // it linked / already-EOS?
                                        let pads: Vec<String> = concat
                                            .sink_pads()
                                            .into_iter()
                                            .map(|p| {
                                                let linked = p.peer().is_some();
                                                format!("{}(linked={linked})", p.name())
                                            })
                                            .collect();
                                        log::debug!(
                                            "[gapless-diag] notify active-pad fire #{} → None (terminal). concat sink pads: [{}]",
                                            prev + 1,
                                            pads.join(", ")
                                        );
                                        return;
                                    };
                                    log::debug!("[gapless-diag] notify active-pad fire #{} → pad {}", prev + 1, active_pad.name());
                                    // Identity: the active pad's peer (a queue src) must belong
                                    // to the prerolled next bin's branch_queue. This is the only
                                    // transition we treat as a gapless advance.
                                    let peer_parent =
                                        active_pad.peer().and_then(|p| p.parent_element());
                                    let is_next = {
                                        match next_bin_notify.lock() {
                                            Ok(guard) => guard.as_ref().is_some_and(|nb| {
                                                peer_parent
                                                    .as_ref()
                                                    .is_some_and(|parent| parent == &nb.branch_queue)
                                            }),
                                            Err(_) => false,
                                        }
                                    };
                                    if !is_next {
                                        // Stale pad / not our next bin → not an advance.
                                        log::debug!("[gapless-diag] notify active-pad: peer_parent does NOT match next_bin.branch_queue (next_bin present={}); not an advance", next_bin_notify.lock().map(|g| g.is_some()).unwrap_or(false));
                                        return;
                                    }
                                    log::debug!("[gapless-diag] notify active-pad: MATCH next bin → dispatching HandleGaplessAdvance");
                                    // Mark the advance in-flight (gates detach/replace, C5)
                                    // and hand off to the worker. Keep this minimal — we're
                                    // on the streaming thread.
                                    next_active_notify.store(true, Ordering::Release);
                                    let _ = cmd_tx_notify.send(AudioCommand::HandleGaplessAdvance);
                                });

                                // Request concat sink_0 and link the branch queue into it.
                                let concat_sink_0 = concat
                                    .request_pad_simple("sink_%u")
                                    .ok_or_else(|| "concat refused initial sink pad".to_string())?;
                                let queue_src = branch_queue
                                    .static_pad("src")
                                    .ok_or_else(|| "branch queue has no src pad".to_string())?;
                                queue_src
                                    .link(&concat_sink_0)
                                    .map_err(|e| format!("Failed to link queue→concat: {e}"))?;

                                // Pad probe on audioconvert.sink — captures the codec's raw output
                                // (pre-conversion). audioconvert.src would show the post-promotion
                                // format when the downstream capsfilter is locked, which is misleading.
                                if let Some(sink_pad) = audioconvert.static_pad("sink") {
                                    let cell = Arc::clone(&decoded_cell_thread);
                                    sink_pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_pad, info| {
                                        if let Some(gst::PadProbeData::Event(ref event)) = info.data {
                                            if let gst::EventView::Caps(caps_event) = event.view() {
                                                let caps = caps_event.caps();
                                                if let Some(fmt) = parse_pcm_format(caps) {
                                                    if let Ok(mut guard) = cell.lock() {
                                                        *guard = Some(crate::pipeline_probe::PadCaps {
                                                            format: fmt.gst_format.clone(),
                                                            rate: fmt.sample_rate,
                                                            channels: fmt.channels,
                                                        });
                                                    }
                                                }
                                            }
                                        }
                                        gst::PadProbeReturn::Ok
                                    });
                                }

                                // autoaudiosink is a bin — its real child sink
                                // (pulsesink/pipewiresink/alsasink) is added asynchronously.
                                // Hook child-added to attach a CAPS probe on the real sink's pad.
                                // Race trade-off: if the child is added BEFORE this signal handler
                                // is connected, the initial CAPS event is missed and output_cell
                                // stays None until the next caps event (e.g., format renegotiation)
                                // or until the 2s heartbeat triggers a refresh; the diagram
                                // gracefully shows "—" until then. In practice the connect happens
                                // before the pipeline transitions to PAUSED, so the race is rare.
                                if let Ok(sink_bin) = sink.clone().dynamic_cast::<gst::Bin>() {
                                    let output_cell = Arc::clone(&output_cell_thread);
                                    sink_bin.connect_element_added(move |_bin, element| {
                                        let cell = Arc::clone(&output_cell);
                                        if let Some(sink_pad) = element.static_pad("sink") {
                                            sink_pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_pad, info| {
                                                if let Some(gst::PadProbeData::Event(ref event)) = info.data {
                                                    if let gst::EventView::Caps(caps_event) = event.view() {
                                                        let caps = caps_event.caps();
                                                        if let Some(fmt) = parse_pcm_format(caps) {
                                                            if let Ok(mut guard) = cell.lock() {
                                                                *guard = Some(crate::pipeline_probe::PadCaps {
                                                                    format: fmt.gst_format.clone(),
                                                                    rate: fmt.sample_rate,
                                                                    channels: fmt.channels,
                                                                });
                                                            }
                                                        }
                                                    }
                                                }
                                                gst::PadProbeReturn::Ok
                                            });
                                        }
                                    });
                                }

                                // uridecodebin(A) → branch_queue (dynamic). The branch
                                // queue's src is already linked to concat sink_0.
                                let branch_queue_weak = branch_queue.downgrade();
                                uridecodebin.connect_pad_added(move |_src, src_pad| {
                                    let Some(branch_queue) = branch_queue_weak.upgrade() else {
                                        return;
                                    };
                                    let Some(sink_pad) = branch_queue.static_pad("sink") else {
                                        return;
                                    };
                                    if sink_pad.is_linked() {
                                        return;
                                    }
                                    if let Some(caps) = src_pad.current_caps() {
                                        if let Some(s) = caps.structure(0) {
                                            if !s.name().as_str().starts_with("audio/") {
                                                return;
                                            }
                                        }
                                    }
                                    if let Err(e) = src_pad.link(&sink_pad) {
                                        log::error!("Failed to link uridecodebin pad: {e:?}");
                                    }
                                });

                                pipe.set_state(gst::State::Playing)
                                    .map_err(|e| format!("Failed to start playback: {e}"))?;

                                // Bus watcher (normal mode). 2b: the StreamStart arm
                                // (2a gapless trigger) is gone; advance is driven by
                                // concat's notify::active-pad (2b-A3). The bus keeps
                                // Eos / Error / Buffering.
                                let eos_flag = Arc::clone(&eos);
                                let tearing_down_flag = Arc::clone(&tearing_down);
                                let app_handle_clone = app_handle.clone();
                                // 2b-A3: next-bin error isolation. The bus thread reads
                                // the shared next_bin to decide whether an Error message
                                // originated inside the prerolled next branch (parent
                                // walk). If so it forwards HandleNextBinError to the
                                // worker (which detaches it) and keeps the current track
                                // playing — NO audio-error, no teardown.
                                let next_bin_bus = Arc::clone(&next_bin);
                                let cmd_tx_bus = cmd_tx_worker.clone();
                                if let Some(bus) = pipe.bus() {
                                    std::thread::spawn(move || {
                                        for msg in bus.iter_timed(gst::ClockTime::NONE) {
                                            match msg.view() {
                                                gst::MessageView::Eos(..) => {
                                                    log::debug!("[gapless-diag] bus EOS (terminal) → emitting track-finished (concat did NOT switch to a next branch)");
                                                    eos_flag.store(true, Ordering::SeqCst);
                                                    if !tearing_down_flag.load(Ordering::SeqCst) {
                                                        app_handle_clone
                                                            .emit("track-finished", ())
                                                            .ok();
                                                    }
                                                    break;
                                                }
                                                gst::MessageView::Error(err) => {
                                                    let err_msg = err.error().to_string();
                                                    let debug_str = err
                                                        .debug()
                                                        .map(|s| s.to_string())
                                                        .unwrap_or_default();
                                                    log::error!(
                                                        "GStreamer error: {} (debug: {})",
                                                        err_msg,
                                                        debug_str
                                                    );

                                                    // Did this error originate inside the
                                                    // prerolled next bin? Walk the src's
                                                    // parent chain and compare against the
                                                    // next bin's element.
                                                    let is_next_bin_error = {
                                                        let next_el = next_bin_bus
                                                            .lock()
                                                            .ok()
                                                            .and_then(|g| {
                                                                g.as_ref().map(|nb| nb.bin.clone())
                                                            });
                                                        match (err.src(), next_el) {
                                                            (Some(src), Some(next_el)) => {
                                                                let mut cur: Option<gst::Object> =
                                                                    Some(src.clone());
                                                                let mut found = false;
                                                                while let Some(obj) = cur.take() {
                                                                    if let Ok(el) = obj
                                                                        .clone()
                                                                        .downcast::<gst::Element>(
                                                                        )
                                                                    {
                                                                        if el == next_el {
                                                                            found = true;
                                                                            break;
                                                                        }
                                                                        cur = el.parent();
                                                                    } else {
                                                                        cur = obj.parent();
                                                                    }
                                                                }
                                                                found
                                                            }
                                                            _ => false,
                                                        }
                                                    };

                                                    if is_next_bin_error {
                                                        // Isolate: detach the bad next bin,
                                                        // keep the current track playing. The
                                                        // natural EOS will fall back to
                                                        // track-finished → playNext fresh.
                                                        log::warn!(
                                                            "[audio] gapless: next-bin bus error, isolating: {err_msg}"
                                                        );
                                                        let _ = cmd_tx_bus.send(
                                                            AudioCommand::HandleNextBinError,
                                                        );
                                                        // Do NOT set eos / emit audio-error /
                                                        // break — current track is unaffected.
                                                        continue;
                                                    }

                                                    eos_flag.store(true, Ordering::SeqCst);
                                                    if !tearing_down_flag.load(Ordering::SeqCst) {
                                                        let is_busy = err_msg.contains("busy")
                                                            || debug_str.contains("busy")
                                                            || err_msg.contains("EBUSY")
                                                            || debug_str.contains("EBUSY");
                                                        let kind = if is_busy {
                                                            "device_busy"
                                                        } else {
                                                            "playback_error"
                                                        };
                                                        app_handle_clone.emit("audio-error",
                                                            serde_json::json!({ "kind": kind, "message": err_msg })
                                                        ).ok();
                                                    }
                                                    break;
                                                }
                                                gst::MessageView::Buffering(b) => {
                                                    log::debug!(
                                                        "[audio] normal: buffering {}%",
                                                        b.percent()
                                                    );
                                                }
                                                _ => {}
                                            }
                                        }
                                    });
                                }

                                backend = Some(PlaybackBackend::Normal {
                                    pipeline: pipe,
                                    concat,
                                    user_volume_el: Some(user_vol),
                                    norm_volume_el: Some(norm_vol),
                                });

                                // 2b-A3: this is the sink_0 branch — the currently
                                // playing track. On a gapless advance it gets detached
                                // and replaced by the promoted next branch.
                                current_branch = Some((uridecodebin, branch_queue));
                            }

                            // Resume where the torn-down pipeline was. Only a
                            // rebuild passes `Some`, so an ordinary track start
                            // reaches none of this.
                            //
                            // The wait is the load-bearing half. Both paths above
                            // call `set_state(Playing)` and fall straight through,
                            // and a seek issued against a pipeline that has not
                            // prerolled is silently dropped — measured, not
                            // assumed — which looks exactly like this feature
                            // working while every track restarts at 0:00.
                            // `state()` returns once the asynchronous state change
                            // has settled, and that is the first moment a seek is
                            // accepted.
                            //
                            // It waits on a thread of its own because the worker is
                            // the sole receiver of its own command channel: waiting
                            // here froze play/pause, next/prev, seek, position
                            // polling and MPRIS for the whole bound — and against an
                            // unreachable proxy, which is precisely what enabling a
                            // proxy invites, it ran the bound out in full and the
                            // seek was refused anyway. Off-thread the bound costs
                            // the UI nothing, so it stays generous enough for a slow
                            // link to finish prerolling.
                            if let Some(position_secs) = start_secs {
                                let pos = gst::ClockTime::from_nseconds(
                                    (position_secs as f64 * 1_000_000_000.0) as u64,
                                );
                                let seek_to = move |pipeline: &gst::Pipeline| {
                                    let (ret, cur, pend) =
                                        pipeline.state(gst::ClockTime::from_seconds(10));
                                    log::debug!("[audio] resume: preroll {ret:?} {cur:?} {pend:?}");
                                    if let Err(e) = pipeline.seek_simple(
                                        gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                                        pos,
                                    ) {
                                        log::warn!(
                                            "[audio] resume at {position_secs}s failed: {e}"
                                        );
                                    }
                                };
                                match backend.as_ref() {
                                    Some(PlaybackBackend::Normal { pipeline, .. }) => {
                                        // A strong ref, so a teardown that beats the
                                        // preroll only delays the final unref past
                                        // the NULL the worker already drove it to —
                                        // where the seek is a refused no-op.
                                        let pipeline = pipeline.clone();
                                        std::thread::spawn(move || seek_to(&pipeline));
                                    }
                                    Some(PlaybackBackend::DirectAlsa { pipeline, .. }) => {
                                        // The generation is bumped here, on the
                                        // worker, because it is worker-local state;
                                        // only the *publishing* of it waits for the
                                        // preroll, which is what makes the writer
                                        // discard the pre-seek chunks in flight.
                                        track_generation += 1;
                                        let resume_gen = track_generation;
                                        let pipeline = pipeline.clone();
                                        let writer_gen = Arc::clone(&writer_gen);
                                        let frames_written = Arc::clone(&frames_written);
                                        let sample_rate = Arc::clone(&current_sample_rate);
                                        let paused = Arc::clone(&paused);
                                        let writer_tx = writer_tx.clone();
                                        std::thread::spawn(move || {
                                            let (ret, cur, pend) =
                                                pipeline.state(gst::ClockTime::from_seconds(10));
                                            log::debug!(
                                                "[audio] resume: preroll {ret:?} {cur:?} {pend:?}"
                                            );
                                            // `fetch_max` never walks the generation
                                            // backwards: if a newer track claimed the
                                            // writer while this one prerolled, it owns
                                            // the position and the seek is abandoned.
                                            if writer_gen.fetch_max(resume_gen, Ordering::AcqRel)
                                                > resume_gen
                                            {
                                                return;
                                            }
                                            // `frames_written` is the only position
                                            // this backend reports, and the writer
                                            // has to be unblocked to take the Flush.
                                            let was_paused = paused.load(Ordering::Acquire);
                                            paused.store(false, Ordering::Release);
                                            if let Some(ref tx) = writer_tx {
                                                let _ = tx.send(WriterCommand::Flush);
                                            }
                                            let seek_frames = (position_secs as f64
                                                * sample_rate.load(Ordering::Relaxed) as f64)
                                                as u64;
                                            frames_written.store(seek_frames, Ordering::Relaxed);
                                            if let Err(e) = pipeline.seek_simple(
                                                gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                                                pos,
                                            ) {
                                                log::warn!(
                                                    "[audio] resume at {position_secs}s failed: {e}"
                                                );
                                            }
                                            if was_paused {
                                                paused.store(true, Ordering::Release);
                                            }
                                        });
                                    }
                                    None => {}
                                }
                            }
                            Ok(())
                        })();
                        // Retained only on success: a failed build leaves no
                        // pipeline, and re-issuing a URI that never played would
                        // resume something that was never torn down.
                        if result.is_ok() {
                            current_uri = Some(uri);
                        }
                        reply.send(result).ok();
                    }

                    AudioCommand::Pause { reply } => {
                        let result = match backend.as_ref() {
                            Some(PlaybackBackend::Normal { pipeline, .. }) => pipeline
                                .set_state(gst::State::Paused)
                                .map(|_| ())
                                .map_err(|e| format!("Failed to pause: {e}")),
                            Some(PlaybackBackend::DirectAlsa { pipeline, .. }) => {
                                paused.store(true, Ordering::Release);
                                pipeline
                                    .set_state(gst::State::Paused)
                                    .map(|_| ())
                                    .map_err(|e| format!("Failed to pause decode: {e}"))
                            }
                            None => Err("No active pipeline".into()),
                        };
                        reply.send(result).ok();
                    }

                    AudioCommand::Resume { reply } => {
                        let result = match backend.as_ref() {
                            Some(PlaybackBackend::Normal { pipeline, .. }) => pipeline
                                .set_state(gst::State::Playing)
                                .map(|_| ())
                                .map_err(|e| format!("Failed to resume: {e}")),
                            Some(PlaybackBackend::DirectAlsa { pipeline, .. }) => {
                                paused.store(false, Ordering::Release);
                                pipeline
                                    .set_state(gst::State::Playing)
                                    .map(|_| ())
                                    .map_err(|e| format!("Failed to resume decode: {e}"))
                            }
                            None => Err("No active pipeline".into()),
                        };
                        reply.send(result).ok();
                    }

                    AudioCommand::Stop { reply } => {
                        // 2b-A3 (detach matrix): Stop tears down the whole pipeline,
                        // so the next-bin + current-branch elements die with it. Just
                        // null the gapless slots (no executor detach — moot, and it
                        // would race the impending set_state(Null)).
                        if let Ok(mut g) = next_bin.lock() {
                            *g = None;
                        }
                        next_active.store(false, Ordering::Release);
                        current_branch = None;
                        // Cleared with `has_uri` below: nothing is playing, so a
                        // later route change has nothing to resume.
                        current_uri = None;
                        let result = match backend.take() {
                            Some(PlaybackBackend::Normal { pipeline, .. }) => {
                                if let Some(bus) = pipeline.bus() {
                                    bus.set_flushing(true);
                                }
                                eos.store(false, Ordering::SeqCst);
                                has_uri.store(false, Ordering::SeqCst);
                                std::thread::spawn(move || {
                                    pipeline.set_state(gst::State::Null).ok();
                                });
                                *decoded_cell_thread.lock().unwrap() = None;
                                *output_cell_thread.lock().unwrap() = None;
                                Ok(())
                            }
                            Some(PlaybackBackend::DirectAlsa { pipeline, .. }) => {
                                // Bump generation so writer discards stale data,
                                // then unblock and shut down
                                paused.store(false, Ordering::Release);
                                track_generation += 1;
                                writer_gen.store(track_generation, Ordering::Release);
                                if let Some(bus) = pipeline.bus() {
                                    bus.set_flushing(true);
                                }
                                if let Some(tx) = writer_tx.take() {
                                    let _ = tx.send_timeout(
                                        WriterCommand::Shutdown,
                                        std::time::Duration::from_millis(200),
                                    );
                                }
                                pipeline.set_state(gst::State::Null).ok();
                                let _ = pipeline.state(gst::ClockTime::from_mseconds(500));
                                drop(pipeline);
                                if let Some(h) = writer_thread.take() {
                                    h.join().ok();
                                }
                                eos.store(false, Ordering::SeqCst);
                                has_uri.store(false, Ordering::SeqCst);
                                *decoded_cell_thread.lock().unwrap() = None;
                                *output_cell_thread.lock().unwrap() = None;
                                Ok(())
                            }
                            None => {
                                // Clean up orphaned writer (e.g. pipeline build failed after spawn)
                                if let Some(tx) = writer_tx.take() {
                                    let _ = tx.send(WriterCommand::Shutdown);
                                }
                                if let Some(h) = writer_thread.take() {
                                    h.join().ok();
                                }
                                Ok(())
                            }
                        };
                        reply.send(result).ok();
                    }

                    AudioCommand::SetVolume { level, reply } => {
                        current_volume = level as f64;
                        let amplitude = slider_to_amplitude(current_volume);
                        if let Some(vol) = backend.as_ref().and_then(|b| b.user_volume_el()) {
                            vol.set_property("volume", amplitude);
                        }
                        combined_vol.store(
                            ((amplitude * current_norm_gain) as f32).to_bits(),
                            Ordering::Relaxed,
                        );
                        signal_path.set_user_volume(amplitude as f32);
                        reply.send(Ok(())).ok();
                    }

                    AudioCommand::SetNormalizationGain { gain, reply } => {
                        apply_normalization_gain(
                            gain,
                            &mut current_norm_gain,
                            backend.as_ref().and_then(|b| b.norm_volume_el()),
                            &combined_vol,
                            current_volume,
                            &signal_path,
                        );
                        reply.send(Ok(())).ok();
                    }

                    AudioCommand::Seek {
                        position_secs,
                        reply,
                    } => {
                        // 2b-A3 (detach matrix): a flush seek must NOT detach the
                        // prerolled next branch. Empirically verified on GStreamer
                        // 1.24.2 (python-gi, concat + dual uridecodebin→queue): a
                        // `seek_simple(FLUSH|KEY_UNIT)` on the pipeline forwards the
                        // FLUSH_START/FLUSH_STOP + new SEGMENT only to concat's ACTIVE
                        // sink pad (sink_0). The inactive prerolled branch on sink_1
                        // sees ZERO flush events, stays linked + PLAYING, and concat
                        // still switches to it at the active branch's EOS (gapless
                        // advance intact). Detaching here was the bug: it threw away a
                        // valid preroll on every seek, forcing a frontend rebuild (gap)
                        // at the boundary. Concat re-bases running time per active
                        // segment, so the seek touches only the current track; the next
                        // branch's relationship to concat is unaffected. Leave it armed.
                        let result = match backend.as_ref() {
                            Some(PlaybackBackend::Normal { pipeline, .. }) => {
                                let pos = gst::ClockTime::from_nseconds(
                                    (position_secs as f64 * 1_000_000_000.0) as u64,
                                );
                                pipeline
                                    .seek_simple(
                                        gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                                        pos,
                                    )
                                    .map_err(|e| format!("Seek failed: {e}"))
                            }
                            Some(PlaybackBackend::DirectAlsa { pipeline, .. }) => {
                                let was_paused = paused.load(Ordering::Acquire);
                                paused.store(false, Ordering::Release);
                                track_generation += 1;
                                writer_gen.store(track_generation, Ordering::Release);
                                if let Some(ref tx) = writer_tx {
                                    let _ = tx.send(WriterCommand::Flush);
                                }
                                let pos = gst::ClockTime::from_nseconds(
                                    (position_secs as f64 * 1_000_000_000.0) as u64,
                                );
                                let seek_frames = (position_secs as f64
                                    * current_sample_rate.load(Ordering::Relaxed) as f64)
                                    as u64;
                                frames_written.store(seek_frames, Ordering::Relaxed);
                                let result = pipeline
                                    .seek_simple(
                                        gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                                        pos,
                                    )
                                    .map_err(|e| format!("Seek failed: {e}"));
                                if was_paused {
                                    paused.store(true, Ordering::Release);
                                }
                                result
                            }
                            None => Err("No active pipeline".into()),
                        };
                        reply.send(result).ok();
                    }

                    AudioCommand::GetPosition { reply } => {
                        let pos = match backend.as_ref() {
                            Some(PlaybackBackend::Normal { pipeline, .. }) => pipeline
                                .query_position::<gst::ClockTime>()
                                // 2b (C2): under concat (adjust-base=true) query_position
                                // re-bases per track, so it is already B-relative — no
                                // offset subtraction needed.
                                .map(|pos| pos.nseconds() as f32 / 1_000_000_000.0)
                                .unwrap_or(0.0),
                            Some(PlaybackBackend::DirectAlsa { .. }) => {
                                let frames = frames_written.load(Ordering::Relaxed);
                                let rate = current_sample_rate.load(Ordering::Relaxed);
                                if rate > 0 {
                                    frames as f32 / rate as f32
                                } else {
                                    0.0
                                }
                            }
                            None => 0.0,
                        };
                        reply.send(Ok(pos)).ok();
                    }

                    AudioCommand::IsFinished { reply } => {
                        let finished =
                            eos.load(Ordering::SeqCst) || !has_uri.load(Ordering::SeqCst);
                        reply.send(Ok(finished)).ok();
                    }

                    AudioCommand::SetExclusiveMode {
                        enabled,
                        device: dev,
                        reply,
                    } => {
                        exclusive = enabled;
                        if let Some(d) = dev {
                            device = Some(d);
                        }
                        if !enabled {
                            bit_perfect = false;
                        }
                        // Mirror the device into the shared cell so the
                        // pipeline probe can read it without messaging.
                        if let Ok(mut cell) = exclusive_device_thread.lock() {
                            *cell = if enabled { device.clone() } else { None };
                        }
                        // 2b-A3 (detach matrix): enabling exclusive invalidates any
                        // Normal-pipeline next bin. Detach it (gated on !next_active).
                        if enabled && !next_active.load(Ordering::Acquire) {
                            if let (Some(stale), Some(PlaybackBackend::Normal {
                                pipeline,
                                concat,
                                ..
                            })) = (
                                next_bin.lock().ok().and_then(|mut g| g.take()),
                                backend.as_ref(),
                            ) {
                                let _ = attach_tx.send(AttachJob::Detach {
                                    pipeline: pipeline.clone(),
                                    concat: concat.clone(),
                                    bin: stale.bin,
                                    branch_queue: stale.branch_queue,
                                });
                            }
                        }
                        reply.send(Ok(())).ok();
                    }

                    AudioCommand::SetBitPerfect { enabled, reply } => {
                        bit_perfect = enabled;
                        if enabled {
                            exclusive = true;
                        }
                        // 2b-A3 (detach matrix): enabling bit-perfect invalidates any
                        // Normal-pipeline next bin. Detach it (gated on !next_active).
                        if enabled && !next_active.load(Ordering::Acquire) {
                            if let (Some(stale), Some(PlaybackBackend::Normal {
                                pipeline,
                                concat,
                                ..
                            })) = (
                                next_bin.lock().ok().and_then(|mut g| g.take()),
                                backend.as_ref(),
                            ) {
                                let _ = attach_tx.send(AttachJob::Detach {
                                    pipeline: pipeline.clone(),
                                    concat: concat.clone(),
                                    bin: stale.bin,
                                    branch_queue: stale.branch_queue,
                                });
                            }
                        }
                        reply.send(Ok(())).ok();
                    }

                    AudioCommand::SetProxySettings { settings, reply } => {
                        let probed = probe_host_caps();
                        // Kept to answer one question below: does this change alter
                        // what the audio thread may do? Taken by replacement so the
                        // cell is never briefly empty.
                        let previous = {
                            let mut ap = audio_proxy
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner());
                            std::mem::replace(&mut *ap, AudioProxy::new(settings, probed))
                        };

                        {
                            // Promotion follows whichever tier is routable. On 1.24
                            // with credentials that is Dash, so curlhttpsrc is
                            // promoted process-wide on a host where its progressive
                            // seek is broken -- harmless only because Lossy refuses
                            // separately at the build site. The promotion and the
                            // refusal are load-bearing for each other.
                            let ap = audio_proxy.lock().unwrap_or_else(|p| p.into_inner());
                            let probe_route = ap
                                .route_for(crate::proxy::Capability::Lossy)
                                .or_else(|_| ap.route_for(crate::proxy::Capability::Dash))
                                .unwrap_or(crate::proxy::Route::NoProxy);
                            promote_curl_source(&probe_route, original_curl_rank);
                        }

                        // Detach unconditionally. A branch prerolled under the
                        // previous settings already holds an open source with up
                        // to fifteen seconds buffered; left alone it becomes the
                        // next playing track, still routed the old way.
                        //
                        // Deliberately not conditional on "did the route change".
                        // Comparing routes cannot see off -> blocked (both would
                        // have to be spelled the same), and a spurious detach
                        // costs one re-preroll and nothing else.
                        //
                        // The bump and the take are one critical section on the
                        // `next_bin` mutex, and the executor reads that generation
                        // and stores under the same one. Split apart, the executor
                        // can store a branch built under the old route immediately
                        // after this take found the slot empty — and nothing
                        // downstream would ever refuse it: the gapless advance that
                        // promotes it reaches no Tauri command, and `SetNextTrack`'s
                        // dedup makes it sticky once it is armed.
                        let stale = {
                            let mut guard = match next_bin.lock() {
                                Ok(g) => g,
                                Err(poisoned) => poisoned.into_inner(),
                            };
                            route_generation.fetch_add(1, Ordering::AcqRel);
                            // Mid-advance the slot belongs to HandleGaplessAdvance
                            // (C5) — the generation still has to move, so the bump
                            // sits outside this gate.
                            if next_active.load(Ordering::Acquire) {
                                None
                            } else {
                                guard.take()
                            }
                        };
                        if let (
                            Some(stale),
                            Some(PlaybackBackend::Normal { pipeline, concat, .. }),
                        ) = (stale, backend.as_ref())
                        {
                            let _ = attach_tx.send(AttachJob::Detach {
                                pipeline: pipeline.clone(),
                                concat: concat.clone(),
                                bin: stale.bin,
                                branch_queue: stale.branch_queue,
                            });
                        }

                        // The playing pipeline carries the route it was built with:
                        // `watch_pipeline_sources` snapshotted it by value, and no
                        // later command re-applies one. So the only way to stop a
                        // track streaming on the previous route is to rebuild it —
                        // which is also what replaces the stale hook, and with it
                        // every branch that would have been attached under it.
                        //
                        // Gated on `backend.is_some()`, not on a play/pause flag: a
                        // paused pipeline still holds an open source.
                        //
                        // `eos` is the one exception, and it is not a play/pause
                        // flag. FOUR bus handlers set it — the terminal EOS arm and
                        // the Error arm of each mode's watcher — and it is cleared
                        // only where a track starts or playback is torn down:
                        // `PlayUrl`, `HandleGaplessAdvance`, and both backend arms
                        // of `Stop`. So it means playback ended, by completion or by
                        // failure; it does NOT mean the source drained.
                        //
                        // The failure shape is the one that reaches here, and it is
                        // the containment hole. An Error arm sets `eos`, emits
                        // `audio-error` and breaks WITHOUT tearing anything down, so
                        // the pipeline is left standing in PLAYING with
                        // `backend = Some` and a source still open on the route it
                        // was built with; the user gets a toast and nothing else
                        // moves. Change the route now and that source keeps its old
                        // one for as long as the backend lives.
                        //
                        // The clean-EOS shape barely exists by comparison: the bus
                        // emits `track-finished`, the frontend's listener calls
                        // `playNext`, and `playNext` invokes `stop_track` before it
                        // inspects the queue at all, so that backend is gone within
                        // milliseconds. (Repeat-one returns above that call, and it
                        // re-plays immediately, which clears `eos`.)
                        //
                        // Rebuilding is the wrong answer in either shape: it would
                        // re-open the stream, seek to the duration, EOS again and
                        // emit a second `track-finished` — which the frontend turns
                        // into `playNext`, i.e. autoplay radio starting while the UI
                        // reads stopped. Driving the pipeline to NULL is what
                        // actually releases the stale-route source, and it resumes
                        // nothing.
                        let current = audio_proxy
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        let route_changed = audio_route_differs(&previous, &current);
                        drop(current);
                        if !route_changed {
                            // No rebuild is coming, and the hook on the live
                            // pipeline still carries what a fresh build would
                            // compute — so the bump above did not make it stale.
                            // Without this, a save that changes nothing would
                            // refuse every later preroll on the playing track.
                            pipeline_route_generation = route_generation.load(Ordering::Acquire);
                        }
                        if route_changed && backend.is_some() {
                            if eos.load(Ordering::SeqCst) {
                                // Queued on the self-sender for the same reason the
                                // rebuild below is re-issued that way: this arm is
                                // an inline closure, and `Stop` is another arm of
                                // the same match rather than a function.
                                //
                                // It lands at the BACK of the worker queue, so a
                                // user-initiated `PlayUrl` enqueued while this arm
                                // was running is processed first and this `Stop`
                                // then tears down the track it just started, with
                                // the UI reading playing. Milliseconds wide, and
                                // the same class of window the rebuild path below
                                // already carries — named here, not guarded.
                                let (stop_tx, _stop_rx) = mpsc::channel();
                                let _ = cmd_tx_worker.send(AudioCommand::Stop { reply: stop_tx });
                            } else if let Some(uri) = current_uri.clone() {
                                // `get_position` cannot be called here — it is an
                                // `AudioPlayer` method, and this thread is the one
                                // its reply would have to come back through. This is
                                // the body of the `GetPosition` arm.
                                let position_secs = match backend.as_ref() {
                                    Some(PlaybackBackend::Normal { pipeline, .. }) => pipeline
                                        .query_position::<gst::ClockTime>()
                                        .map(|pos| pos.nseconds() as f32 / 1_000_000_000.0)
                                        .unwrap_or(0.0),
                                    Some(PlaybackBackend::DirectAlsa { .. }) => {
                                        let frames = frames_written.load(Ordering::Relaxed);
                                        let rate = current_sample_rate.load(Ordering::Relaxed);
                                        if rate > 0 {
                                            frames as f32 / rate as f32
                                        } else {
                                            0.0
                                        }
                                    }
                                    None => 0.0,
                                };
                                log::info!(
                                    "[proxy] route changed mid-track: rebuilding at {position_secs:.1}s"
                                );
                                // There is no `PlayUrl` function to call — the arm
                                // is an inline closure — so re-issue it as a command
                                // on the self-sender. The reply is watched off-thread
                                // purely so a refusal under the new settings reaches
                                // the user rather than stopping playback in silence.
                                let (rebuilt_tx, rebuilt_rx) =
                                    mpsc::channel::<Result<(), String>>();
                                let app_handle_rebuild = app_handle.clone();
                                std::thread::spawn(move || {
                                    if let Ok(Err(e)) = rebuilt_rx.recv() {
                                        log::warn!("[proxy] rebuild after route change: {e}");
                                        app_handle_rebuild
                                            .emit(
                                                "audio-error",
                                                serde_json::json!({
                                                    "kind": "playback_error",
                                                    "message": e,
                                                }),
                                            )
                                            .ok();
                                    }
                                });
                                // A paused track is torn down like any other (it
                                // holds an open source), but it must not come back
                                // playing: the frontend still says paused, and the
                                // two would disagree out loud. Queued behind the
                                // rebuild, so it pauses the pipeline that replaces
                                // this one.
                                let resume_paused = match backend.as_ref() {
                                    Some(PlaybackBackend::Normal { pipeline, .. }) => {
                                        // `current_state` alone would read a pipeline
                                        // still prerolling toward PLAYING as paused.
                                        let (_, cur, pending) =
                                            pipeline.state(gst::ClockTime::ZERO);
                                        cur == gst::State::Paused
                                            && pending == gst::State::VoidPending
                                    }
                                    Some(PlaybackBackend::DirectAlsa { .. }) => {
                                        paused.load(Ordering::Acquire)
                                    }
                                    None => false,
                                };
                                let _ = cmd_tx_worker.send(AudioCommand::PlayUrl {
                                    uri,
                                    start_secs: Some(position_secs),
                                    reply: rebuilt_tx,
                                });
                                if resume_paused {
                                    let (paused_tx, _paused_rx) = mpsc::channel();
                                    let _ = cmd_tx_worker
                                        .send(AudioCommand::Pause { reply: paused_tx });
                                }
                            }
                        }

                        reply.send(()).ok();
                    }

                    AudioCommand::SetGapless { enabled, reply } => {
                        // 2b-A2: drives SetNextTrack's effective-gapless gate.
                        gapless_setting = enabled;
                        // 2b-A3 (detach matrix): disabling gapless invalidates any
                        // prerolled next bin. Detach it (gated on !next_active).
                        if !enabled && !next_active.load(Ordering::Acquire) {
                            if let (Some(stale), Some(PlaybackBackend::Normal {
                                pipeline,
                                concat,
                                ..
                            })) = (
                                next_bin.lock().ok().and_then(|mut g| g.take()),
                                backend.as_ref(),
                            ) {
                                let _ = attach_tx.send(AttachJob::Detach {
                                    pipeline: pipeline.clone(),
                                    concat: concat.clone(),
                                    bin: stale.bin,
                                    branch_queue: stale.branch_queue,
                                });
                            }
                        }
                        let _ = reply.send(Ok(()));
                    }

                    // 2b-A2: preroll the next track via a second uridecodebin
                    // attached to concat sink_1, OFF the worker thread (C3). The
                    // worker only validates gating + dedup + records intent, then
                    // dispatches to the attach executor and replies immediately.
                    AudioCommand::SetNextTrack {
                        uri,
                        norm_gain,
                        track_id,
                        qid,
                        replay_gain,
                        peak_amplitude,
                        is_dash,
                        reply,
                    } => {
                        // Effective gapless = setting on AND normal mode (C5: never
                        // attach a concat branch under exclusive/bit-perfect — the
                        // DirectAlsa path has no concat).
                        let effective_gapless = gapless_setting && !exclusive && !bit_perfect;

                        // Normal-mode pipeline/concat clones for the executor. If the
                        // backend isn't Normal (or absent), we can't (and mustn't,
                        // C5) touch concat — treat as "no preroll".
                        let normal_clones = match backend.as_ref() {
                            Some(PlaybackBackend::Normal {
                                pipeline, concat, ..
                            }) => Some((pipeline.clone(), concat.clone())),
                            _ => None,
                        };
                        log::debug!("[gapless-diag] SetNextTrack track={track_id}: effective_gapless={effective_gapless} (setting={gapless_setting} excl={exclusive} bp={bit_perfect}), backend_normal={}", normal_clones.is_some());

                        if !effective_gapless || normal_clones.is_none() {
                            // Gapless off / wrong mode: detach any existing next_bin
                            // (gated on !next_active per C5) and do nothing else.
                            if !next_active.load(Ordering::Acquire) {
                                if let Some(stale) = next_bin.lock().ok().and_then(|mut g| g.take()) {
                                    if let Some(PlaybackBackend::Normal {
                                        pipeline, concat, ..
                                    }) = backend.as_ref()
                                    {
                                        let _ = attach_tx.send(AttachJob::Detach {
                                            pipeline: pipeline.clone(),
                                            concat: concat.clone(),
                                            bin: stale.bin,
                                            branch_queue: stale.branch_queue,
                                        });
                                    }
                                    // If not Normal we can't detach via concat; the
                                    // bin was attached under Normal so backend is
                                    // Normal here in practice. Drop silently otherwise.
                                }
                            }
                            let _ = reply.send(Ok(()));
                            continue;
                        }

                        let (pipeline, concat) = normal_clones.unwrap();

                        // Dedup (C5): if an existing next_bin targets the same track,
                        // just refresh its stored qid (so the eventual track-advanced
                        // payload matches the frontend queue) — no re-attach.
                        {
                            let mut guard = next_bin.lock().unwrap();
                            if let Some(existing) = guard.as_mut() {
                                if existing.track_id == track_id {
                                    existing.qid = qid.clone();
                                    drop(guard);
                                    let _ = reply.send(Ok(()));
                                    continue;
                                }
                            }
                        }

                        // A different next track is requested. Only replace if concat
                        // isn't already switching (C5) — otherwise let 2b-A3's advance
                        // complete and skip.
                        if next_active.load(Ordering::Acquire) {
                            let _ = reply.send(Ok(()));
                            continue;
                        }

                        // Detach the stale (different) bin, then attach the new one.
                        // Both jobs are serialized on the executor, so detach-then-
                        // attach is ordered correctly.
                        if let Some(stale) = next_bin.lock().ok().and_then(|mut g| g.take()) {
                            let _ = attach_tx.send(AttachJob::Detach {
                                pipeline: pipeline.clone(),
                                concat: concat.clone(),
                                bin: stale.bin,
                                branch_queue: stale.branch_queue,
                            });
                        }

                        log::debug!("[gapless-diag] SetNextTrack: dispatching ATTACH for track {track_id}");
                        let _ = attach_tx.send(AttachJob::Attach {
                            pipeline,
                            concat,
                            build_generation: pipeline_route_generation,
                            uri,
                            is_dash,
                            track_id,
                            qid,
                            norm_gain,
                            replay_gain,
                            peak_amplitude,
                        });
                        let _ = reply.send(Ok(()));
                    }

                    // 2b-A2: detach the prerolled next bin (gated on !next_active per
                    // C5 — if concat is already switching, leave it for 2b-A3).
                    AudioCommand::ClearNextTrack { reply } => {
                        if !next_active.load(Ordering::Acquire) {
                            if let Some(stale) = next_bin.lock().ok().and_then(|mut g| g.take()) {
                                if let Some(PlaybackBackend::Normal {
                                    pipeline, concat, ..
                                }) = backend.as_ref()
                                {
                                    let _ = attach_tx.send(AttachJob::Detach {
                                        pipeline: pipeline.clone(),
                                        concat: concat.clone(),
                                        bin: stale.bin,
                                        branch_queue: stale.branch_queue,
                                    });
                                }
                            }
                        }
                        let _ = reply.send(Ok(()));
                    }

                    // 2b-A3: concat switched its active pad to the prerolled next
                    // branch (verified by the notify identity gate). Run the
                    // now-playing cascade: detach the finished branch, promote the
                    // next branch to current, apply its normalization gain, and emit
                    // `track-advanced`. Fieldless (C6): all data comes from the
                    // single `next_bin` slot, which we `take()` — the empty-take
                    // guard makes a double-advance a no-op.
                    AudioCommand::HandleGaplessAdvance => {
                        let promoted = match next_bin.lock().ok().and_then(|mut g| g.take()) {
                            Some(p) => p,
                            None => {
                                // Spurious / double advance (e.g. a stray notify, or
                                // the slot was already taken/cleared). Release the gate
                                // and ignore.
                                log::debug!(
                                    "[audio] gapless: HandleGaplessAdvance with empty next_bin — ignoring"
                                );
                                next_active.store(false, Ordering::Release);
                                continue;
                            }
                        };

                        // Detach the now-finished current branch (sink_0). Safe to
                        // detach now that concat has switched away from it. Gated to
                        // Normal (C5) — the worker never reaches here on DirectAlsa
                        // (gapless is mode-gated off), but be defensive.
                        if let (Some((old_bin, old_queue)), Some(PlaybackBackend::Normal {
                            pipeline,
                            concat,
                            ..
                        })) = (current_branch.take(), backend.as_ref())
                        {
                            let _ = attach_tx.send(AttachJob::Detach {
                                pipeline: pipeline.clone(),
                                concat: concat.clone(),
                                bin: old_bin,
                                branch_queue: old_queue,
                            });
                        }

                        // Promote the next branch to current. The URI moves with
                        // it: this branch is the playing track now, and a route
                        // change from here must rebuild *this* one.
                        current_branch = Some((promoted.bin, promoted.branch_queue));
                        current_uri = Some(promoted.uri);

                        // Apply the promoted track's normalization gain across the
                        // shared volume chain (concat is upstream of norm_vol, so the
                        // gain applies to the now-active branch).
                        apply_normalization_gain(
                            promoted.norm_gain,
                            &mut current_norm_gain,
                            backend.as_ref().and_then(|b| b.norm_volume_el()),
                            &combined_vol,
                            current_volume,
                            &signal_path,
                        );
                        signal_path.reset_for_track();

                        // Emit track-advanced (unchanged payload, C4). The lib.rs
                        // listener stores rg/peak + scrobbles; the frontend reconciles
                        // its queue by trackId/qid.
                        let _ = app_handle.emit(
                            "track-advanced",
                            serde_json::json!({
                                "trackId": promoted.track_id,
                                "qid": promoted.qid,
                                "replayGain": promoted.replay_gain,
                                "peakAmplitude": promoted.peak_amplitude,
                            }),
                        );

                        // A new track is now playing on the same pipeline: clear EOS,
                        // keep has_uri true. The boundary is resolved.
                        eos.store(false, Ordering::SeqCst);
                        has_uri.store(true, Ordering::SeqCst);
                        next_active.store(false, Ordering::Release);
                    }

                    // 2b-A3: a prerolled next bin reported a decode error on the bus.
                    // Detach it (gated on !next_active per C5) without touching the
                    // current track — the natural boundary falls back to playNext.
                    AudioCommand::HandleNextBinError => {
                        if !next_active.load(Ordering::Acquire) {
                            if let (Some(stale), Some(PlaybackBackend::Normal {
                                pipeline,
                                concat,
                                ..
                            })) = (
                                next_bin.lock().ok().and_then(|mut g| g.take()),
                                backend.as_ref(),
                            ) {
                                let _ = attach_tx.send(AttachJob::Detach {
                                    pipeline: pipeline.clone(),
                                    concat: concat.clone(),
                                    bin: stale.bin,
                                    branch_queue: stale.branch_queue,
                                });
                            }
                        }
                    }

                    AudioCommand::ListDevices { reply } => {
                        let result = list_alsa_devices_inner();
                        reply.send(result).ok();
                    }
                }
            }
        });

        Self {
            cmd_tx,
            exclusive_device,
            decoded_caps_cell,
            output_caps_cell,
        }
    }

    fn send_cmd<T>(&self, build: impl FnOnce(Reply<T>) -> AudioCommand) -> T {
        let (tx, rx) = mpsc::channel();
        let cmd = build(tx);
        self.cmd_tx.send(cmd).expect("Audio thread dead");
        rx.recv().expect("Audio thread dead")
    }

    pub fn play_url(&self, uri: &str, start_secs: Option<f32>) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::PlayUrl {
            uri: uri.to_string(),
            start_secs,
            reply,
        })
    }
    pub fn pause(&self) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::Pause { reply })
    }
    pub fn resume(&self) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::Resume { reply })
    }
    pub fn stop(&self) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::Stop { reply })
    }
    pub fn set_volume(&self, level: f32) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::SetVolume { level, reply })
    }
    pub fn set_normalization_gain(&self, gain: f64) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::SetNormalizationGain { gain, reply })
    }
    pub fn seek(&self, position_secs: f32) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::Seek {
            position_secs,
            reply,
        })
    }
    pub fn get_position(&self) -> Result<f32, String> {
        self.send_cmd(|reply| AudioCommand::GetPosition { reply })
    }
    pub fn is_finished(&self) -> Result<bool, String> {
        self.send_cmd(|reply| AudioCommand::IsFinished { reply })
    }
    pub fn set_exclusive_mode(&self, enabled: bool, device: Option<String>) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::SetExclusiveMode {
            enabled,
            device,
            reply,
        })
    }
    pub fn set_bit_perfect(&self, enabled: bool) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::SetBitPerfect { enabled, reply })
    }
    pub fn set_proxy_settings(&self, settings: crate::ProxySettings) {
        self.send_cmd(|reply| AudioCommand::SetProxySettings { settings, reply });
    }
    pub fn set_gapless(&self, enabled: bool) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::SetGapless { enabled, reply })
    }
    #[allow(clippy::too_many_arguments)]
    pub fn set_next_track(
        &self,
        uri: String,
        norm_gain: f64,
        track_id: u64,
        qid: String,
        replay_gain: f64,
        peak_amplitude: f64,
        is_dash: bool,
    ) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::SetNextTrack {
            uri,
            norm_gain,
            track_id,
            qid,
            replay_gain,
            peak_amplitude,
            is_dash,
            reply,
        })
    }
    pub fn clear_next_track(&self) -> Result<(), String> {
        self.send_cmd(|reply| AudioCommand::ClearNextTrack { reply })
    }
    pub fn list_devices(&self) -> Result<Vec<AudioDevice>, String> {
        self.send_cmd(|reply| AudioCommand::ListDevices { reply })
    }

    pub fn snapshot_decoded_caps(&self) -> Option<crate::pipeline_probe::PadCaps> {
        self.decoded_caps_cell.lock().ok()?.clone()
    }

    pub fn snapshot_output_caps(&self) -> Option<crate::pipeline_probe::PadCaps> {
        self.output_caps_cell.lock().ok()?.clone()
    }

    /// Returns the ALSA device string for DirectAlsa, or None for Normal mode.
    pub fn exclusive_device(&self) -> Option<String> {
        self.exclusive_device.lock().ok()?.clone()
    }
}

// ── Appsink pipeline builder ───────────────────────────────────────────

/// audioconvert `mix-matrix` that maps a stereo source (in0=L, in1=R) onto the
/// first two of `out_channels` outputs at unity gain, silencing the rest. This
/// keeps L/R bit-exact on the device's first output pair (the monitor outs) and
/// fills the extra channels with digital silence — the GStreamer equivalent of
/// an ALSA `ttable.0.0 1; ttable.1.1 1` route. Coefficient leaves MUST be f32
/// (the property's leaf type is G_TYPE_FLOAT; f64 is rejected).
#[cfg(target_os = "linux")]
fn stereo_pad_mix_matrix(out_channels: u32) -> gst::Array {
    let rows = (0..out_channels).map(|o| {
        let cols = (0..2u32).map(move |i| if o == i { 1.0f32 } else { 0.0f32 });
        gst::Array::new(cols)
    });
    gst::Array::new(rows)
}

#[cfg(target_os = "linux")]
fn build_appsink_pipeline(
    uri: &str,
    // Both decided by the caller: one tier decision serves this arm and the
    // normal one, so nothing here re-sniffs the URI.
    is_dash: bool,
    route: crate::proxy::Route,
    exclusive: bool,
    bit_perfect: bool,
    writer_tx: crossbeam_channel::Sender<WriterCommand>,
    writer_gen: Arc<AtomicU64>,
    // The ALSA writer's negotiated device format. Its channel count drives the
    // stereo→Nch upmix (mix-matrix) and the capsfilter / appsink channel pin
    // when the DAC exposes only a fixed channel count (> 2).
    negotiated_fmt: &PcmFormat,
    supported_gst_formats: &[&str],
    supported_rates: &[u32],
    decoded_cell: Arc<Mutex<Option<crate::pipeline_probe::PadCaps>>>,
    output_cell: Arc<Mutex<Option<crate::pipeline_probe::PadCaps>>>,
) -> Result<(gst::Pipeline, Option<gst::Element>, Option<gst::Element>), String> {
    use gst_app::prelude::*;

    let pipe = gst::Pipeline::new();
    watch_pipeline_sources(&pipe, route);
    let mut udb = gst::ElementFactory::make("uridecodebin").property("uri", uri);
    if is_dash {
        udb = udb
            .property("buffer-duration", 15_000_000_000i64)
            .property("use-buffering", true);
    } else {
        udb = udb
            .property("buffer-duration", 5_000_000_000i64)
            .property("use-buffering", true);
    }
    let uridecodebin = udb
        .build()
        .map_err(|e| format!("Failed to create uridecodebin: {e}"))?;
    let device_channels = negotiated_fmt.channels;
    let audioconvert = gst::ElementFactory::make("audioconvert")
        .build()
        .map_err(|e| format!("Failed to create audioconvert: {e}"))?;
    // Fixed-channel DAC: the device opened at > 2ch but the source is stereo.
    // Install a stereo→Nch silence-pad mix-matrix at BUILD time (before caps
    // negotiate) so the first caps event resolves directly to the device count
    // — avoids a 2ch transient that would thrash the ALSA writer.
    if device_channels > 2 {
        audioconvert.set_property("mix-matrix", stereo_pad_mix_matrix(device_channels));
        log::info!(
            "[audio] stereo→{device_channels}ch silence-pad mix-matrix installed for fixed-channel DAC"
        );
    }

    let appsink = gst_app::AppSink::builder()
        .max_buffers(20)
        .sync(false)
        .build();

    // DASH: constrain appsink to DAC-supported formats (and, for non-bit-perfect,
    // rates) for BOTH modes. The pad_added capsfilter relock is gated by
    // `if !is_dash` (DASH renegotiates caps mid-stream and would fight the lock),
    // so without this constraint a non-bit-perfect DASH chain has no protection
    // and source-format chunks (e.g. S24_32LE on a DAC that only supports S32LE)
    // reach the writer, triggering the strict format-mismatch teardown in the
    // Data handler.
    //
    // RATE is constrained ONLY in non-bit-perfect mode. There, an audioresample
    // element bridges any source rate to a DAC-supported one, so the constraint
    // is always satisfiable. In bit-perfect mode there is deliberately NO
    // resampler (audioconvert can't change rate), so pinning the rate to the
    // DAC's list makes GStreamer fail negotiation outright when the source rate
    // isn't supported — surfacing as the opaque "Internal data stream error" on
    // the bus instead of the actionable "turn off bit-perfect" message. Leaving
    // rate unconstrained lets the source rate pass through to the appsink; its
    // CAPS probe then hands the writer a FormatHint, the writer attempts the ALSA
    // reopen at that exact rate, and configure_alsa_hwparams emits the friendly
    // "DAC doesn't support XkHz — turn off bit-perfect mode" toast (matching the
    // non-DASH/BTS path).
    if is_dash {
        let mut caps_builder = gst::Caps::builder("audio/x-raw")
            .field("format", gst::List::new(supported_gst_formats.iter().copied()))
            .field("channels", device_channels as i32);
        let rate_list: Vec<i32> = supported_rates.iter().map(|&r| r as i32).collect();
        if !bit_perfect && !rate_list.is_empty() {
            caps_builder = caps_builder.field("rate", gst::List::new(rate_list));
        }
        appsink.set_caps(Some(&caps_builder.build()));
        log::debug!(
            "[audio] DASH appsink caps = formats:{:?} rates:{} (bit_perfect={bit_perfect})",
            supported_gst_formats,
            if bit_perfect { "passthrough".to_string() } else { format!("{supported_rates:?}") }
        );
    }

    log::debug!(
        "[audio] building appsink pipeline: exclusive={exclusive} bit_perfect={bit_perfect}"
    );

    let (u_vol, n_vol, capsfilter_weak_from_build): (Option<gst::Element>, Option<gst::Element>, Option<gst::glib::WeakRef<gst::Element>>) = if bit_perfect {
        audioconvert.set_property_from_str("dithering", "none");
        audioconvert.set_property_from_str("noise-shaping", "none");

        if is_dash {
            // DASH: no capsfilter — appsink caps constrain format,
            // audioconvert passes through rate changes
            pipe.add_many([&uridecodebin, &audioconvert, appsink.upcast_ref()])
                .map_err(|e| format!("Failed to add elements: {e}"))?;
            gst::Element::link_many([&audioconvert, appsink.upcast_ref()])
                .map_err(|e| format!("Failed to link bit-perfect DASH chain: {e}"))?;
            (None, None, None)
        } else {
            // BTS: capsfilter for dynamic locking (preserves exact decoded format)
            let capsfilter = gst::ElementFactory::make("capsfilter")
                .build()
                .map_err(|e| format!("Failed to create capsfilter: {e}"))?;
            let cf_weak = capsfilter.downgrade();
            pipe.add_many([
                &uridecodebin,
                &audioconvert,
                &capsfilter,
                appsink.upcast_ref(),
            ])
            .map_err(|e| format!("Failed to add elements: {e}"))?;
            gst::Element::link_many([&audioconvert, &capsfilter, appsink.upcast_ref()])
                .map_err(|e| format!("Failed to link bit-perfect chain: {e}"))?;
            (None, None, Some(cf_weak))
        }
    } else {
        // Exclusive (non-bit-perfect): volume applied in ALSA writer thread.
        // Rate constrained to DAC-supported rates — audioresample converts unsupported rates.
        let audioresample = gst::ElementFactory::make("audioresample")
            .build()
            .map_err(|e| format!("Failed to create audioresample: {e}"))?;
        // Construct capsfilter EMPTY so it imposes no FORMAT constraint until
        // pad_added relocks it with the chosen format. Seeding a format here
        // makes src_pad.link() trigger downstream negotiation against the seed
        // BEFORE the relock runs — audioconvert then commits to converting (e.g.
        // S16LE→S32LE) and the writer reopens ALSA at the wrong format. (The
        // channel count is handled separately by the build-time mix-matrix,
        // which is orthogonal to format negotiation.) Matches the bit-perfect
        // BTS pattern where the capsfilter is also built empty.
        let capsfilter = gst::ElementFactory::make("capsfilter")
            .build()
            .map_err(|e| format!("Failed to create capsfilter: {e}"))?;
        let cf_weak = capsfilter.downgrade();

        pipe.add_many([
            &uridecodebin,
            &audioconvert,
            &audioresample,
            &capsfilter,
            appsink.upcast_ref(),
        ])
        .map_err(|e| format!("Failed to add elements: {e}"))?;
        gst::Element::link_many([
            &audioconvert,
            &audioresample,
            &capsfilter,
            appsink.upcast_ref(),
        ])
        .map_err(|e| format!("Failed to link exclusive chain: {e}"))?;

        (None, None, Some(cf_weak))
    };

    // Capsfilter weak ref captured at element creation (line ~1903/1925).
    // DON'T use audioconvert.src.peer.parent_element — the chain length differs
    // between bit-perfect (audioconvert→capsfilter) and non-bit-perfect
    // (audioconvert→audioresample→capsfilter), so peer-walk would target the
    // wrong element in non-bit-perfect mode.
    let capsfilter_weak = capsfilter_weak_from_build;

    // Pad probe on audioconvert.sink — captures the codec's raw output
    // (pre-conversion). audioconvert.src would show the post-promotion
    // format when the downstream capsfilter is locked, which is misleading.
    if let Some(sink_pad) = audioconvert.static_pad("sink") {
        let cell = Arc::clone(&decoded_cell);
        sink_pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_pad, info| {
            if let Some(gst::PadProbeData::Event(ref event)) = info.data {
                if let gst::EventView::Caps(caps_event) = event.view() {
                    let caps = caps_event.caps();
                    if let Some(fmt) = parse_pcm_format(caps) {
                        if let Ok(mut guard) = cell.lock() {
                            *guard = Some(crate::pipeline_probe::PadCaps {
                                format: fmt.gst_format.clone(),
                                rate: fmt.sample_rate,
                                channels: fmt.channels,
                            });
                        }
                    }
                }
            }
            gst::PadProbeReturn::Ok
        });
    }

    // Connect uridecodebin's dynamic pad to audioconvert
    let convert_weak = audioconvert.downgrade();
    let supported_fmts_for_closure: Vec<String> = supported_gst_formats.iter().map(|s| s.to_string()).collect();
    let supported_rates_for_closure: Vec<u32> = supported_rates.to_vec();
    let resample_tx = writer_tx.clone();
    let is_bit_perfect = bit_perfect;
    // pad_added runs on the GStreamer streaming thread; clone writer_gen up front
    // since `writer_gen` itself is moved into the appsink callback later.
    let pad_gen = Arc::clone(&writer_gen);
    uridecodebin.connect_pad_added(move |_src, src_pad| {
        let Some(convert) = convert_weak.upgrade() else {
            return;
        };
        let Some(sink_pad) = convert.static_pad("sink") else {
            return;
        };
        if sink_pad.is_linked() {
            return;
        }

        if let Some(caps) = src_pad.current_caps() {
            if let Some(s) = caps.structure(0) {
                if !s.name().as_str().starts_with("audio/") {
                    return;
                }
            }
        }

        if let Err(e) = src_pad.link(&sink_pad) {
            log::error!("Failed to link uridecodebin pad: {e:?}");
        }

        // Detect if resampling will occur (non-bit-perfect exclusive only)
        if !is_bit_perfect {
            if let Some(caps) = src_pad.current_caps() {
                if let Some(s) = caps.structure(0) {
                    if let Ok(native_rate) = s.get::<i32>("rate") {
                        let native = native_rate as u32;
                        if !supported_rates_for_closure.contains(&native) {
                            let closest = supported_rates_for_closure
                                .iter()
                                .copied()
                                .min_by_key(|&r| (r as i64 - native as i64).unsigned_abs())
                                .unwrap_or(48000);
                            let _ = resample_tx.try_send(
                                WriterCommand::Resampling { from: native, to: closest },
                            );
                        }
                    }
                }
            }
        }

        // Format selection: both bit-perfect AND non-bit-perfect prefer the
        // narrowest lossless option from pick_capsfilter_format. Difference:
        // bit-perfect also emits PendingPromotion so the writer can fire a
        // truthful from→to toast; non-bit-perfect just relies on FormatHint.
        if !is_dash {
            let caps = src_pad.current_caps().or_else(|| {
                let query = src_pad.query_caps(None);
                if query.is_fixed() {
                    Some(query)
                } else {
                    None
                }
            });
            if let Some(caps) = caps {
                if let Some(s) = caps.structure(0) {
                    if let (Ok(rate), Ok(channels), Ok(format)) = (
                        s.get::<i32>("rate"),
                        s.get::<i32>("channels"),
                        s.get::<&str>("format"),
                    ) {
                        // The build-time mix-matrix assumes a stereo source (SONE
                        // only ever streams stereo). Surface it loudly if a
                        // non-stereo source ever reaches a multichannel-only DAC,
                        // where the [device][2] matrix would fail to negotiate.
                        if device_channels > 2 && channels != 2 {
                            log::error!(
                                "[audio] {channels}ch source on a {device_channels}ch-only DAC: \
                                 stereo-pad mix-matrix cannot negotiate this layout"
                            );
                        }

                        // Bit-perfect: announce source format so the writer
                        // can emit a truthful promotion toast once negotiation lands.
                        if is_bit_perfect {
                            let _ = resample_tx.try_send(WriterCommand::PendingPromotion {
                                from: format.to_string(),
                                generation: pad_gen.load(Ordering::Acquire),
                            });
                        }

                        let chosen = pick_capsfilter_format(format, &supported_fmts_for_closure);

                        if let Some(ref cf_weak) = capsfilter_weak {
                            if let Some(cf) = cf_weak.upgrade() {
                                let locked = if is_bit_perfect {
                                    // Bit-perfect: single rate (no audioresample work).
                                    gst::Caps::builder("audio/x-raw")
                                        .field("format", chosen.as_str())
                                        .field("rate", rate)
                                        .field("channels", device_channels as i32)
                                        .build()
                                } else {
                                    // Non-bit-perfect: rate stays a list so audioresample
                                    // can pick a DAC-supported rate when source rate isn't.
                                    let rate_list: Vec<i32> = supported_rates_for_closure
                                        .iter()
                                        .map(|&r| r as i32)
                                        .collect();
                                    gst::Caps::builder("audio/x-raw")
                                        .field("format", chosen.as_str())
                                        .field("channels", device_channels as i32)
                                        .field("rate", gst::List::new(rate_list))
                                        .build()
                                };
                                log::info!("[audio] capsfilter locked to {locked}");
                                cf.set_property("caps", &locked);

                                // Belt-and-braces: notify the writer explicitly so it
                                // reopens ALSA at the chosen format. The appsink CAPS
                                // probe will also fire FormatHint when the new caps
                                // event reaches it; both arrive at the writer's mpsc
                                // and the writer dedups via the current_fmt comparison.
                                if !is_bit_perfect {
                                    let bps: u32 = match chosen.as_str() {
                                        "S16LE" => 2,
                                        "S24LE" => 3,
                                        "S24_32LE" | "S32LE" | "F32LE" => 4,
                                        _ => 4,
                                    };
                                    let hint_fmt = PcmFormat {
                                        gst_format: chosen.clone(),
                                        sample_rate: rate as u32,
                                        channels: device_channels,
                                        bytes_per_sample: bps,
                                    };
                                    let _ = resample_tx.try_send(WriterCommand::FormatHint(hint_fmt));
                                }
                            }
                        }
                    }
                }
            }
        }
    });

    // Pad probe: intercept CAPS events for preemptive ALSA format changes (DASH renegotiation)
    let probe_tx = writer_tx.clone();
    if let Some(sink_pad) = appsink.static_pad("sink") {
        let output_cell_for_probe = Arc::clone(&output_cell);
        sink_pad.add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_pad, info| {
            if let Some(gst::PadProbeData::Event(ref event)) = info.data {
                if let gst::EventView::Caps(caps_event) = event.view() {
                    let caps = caps_event.caps();
                    if let Some(fmt) = parse_pcm_format(caps) {
                        log::debug!("[audio] CAPS event on appsink: {fmt:?}");
                        if let Ok(mut guard) = output_cell_for_probe.lock() {
                            *guard = Some(crate::pipeline_probe::PadCaps {
                                format: fmt.gst_format.clone(),
                                rate: fmt.sample_rate,
                                channels: fmt.channels,
                            });
                        }
                        let _ = probe_tx.try_send(WriterCommand::FormatHint(fmt));
                    }
                }
            }
            gst::PadProbeReturn::Ok
        });
    }

    // Appsink callback: extract PCM and forward to ALSA writer
    let chunk_gen = Arc::clone(&writer_gen);
    appsink.set_callbacks(
        gst_app::AppSinkCallbacks::builder()
            .new_sample(move |sink| {
                let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                let buffer = sample.buffer().ok_or(gst::FlowError::Error)?;
                let caps = sample.caps().ok_or(gst::FlowError::Error)?;
                let format = parse_pcm_format(caps).ok_or(gst::FlowError::Error)?;

                let map = buffer.map_readable().map_err(|_| gst::FlowError::Error)?;
                let data = map.as_slice().to_vec();
                let generation = chunk_gen.load(Ordering::Acquire);

                writer_tx
                    .send(WriterCommand::Data(AudioChunk {
                        data,
                        format,
                        generation,
                    }))
                    .map_err(|_| gst::FlowError::Error)?;

                Ok(gst::FlowSuccess::Ok)
            })
            .build(),
    );

    Ok((pipe, u_vol, n_vol))
}

// ── Device enumeration ─────────────────────────────────────────────────

/// Enumerate ALSA hardware devices. Does NOT use the audio pipeline,
/// so it is safe to call from any thread.
pub fn list_alsa_devices() -> Result<Vec<AudioDevice>, String> {
    list_alsa_devices_inner()
}

fn list_alsa_devices_inner() -> Result<Vec<AudioDevice>, String> {
    gst::init().map_err(|e| format!("GStreamer init failed: {e}"))?;
    let monitor = gst::DeviceMonitor::new();
    let caps = gst::Caps::new_empty_simple("audio/x-raw");
    monitor.add_filter(Some("Audio/Sink"), Some(&caps));
    monitor
        .start()
        .map_err(|e| format!("Failed to start device monitor: {e}"))?;

    // GStreamer 1.28+ starts providers async, so devices() may initially be empty.
    // On older versions start() blocks and devices are available immediately.
    let devices = {
        let mut devs = monitor.devices();
        let mut waited = 0u32;
        while devs.is_empty() && waited < 2000 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            devs = monitor.devices();
            waited += 100;
        }
        devs
    };

    monitor.stop();

    log::debug!(
        "[list_alsa_devices] DeviceMonitor found {} devices",
        devices.len()
    );

    let mut result = Vec::new();
    for dev in &devices {
        let Some(props) = dev.properties() else {
            continue;
        };

        let api = props.get::<String>("device.api").unwrap_or_default();
        if api != "alsa" {
            continue;
        }

        let path = props.get::<String>("api.alsa.path").ok().or_else(|| {
            let card = props.get::<String>("alsa.card").ok()?;
            let dev_num = props.get::<String>("alsa.device").ok()?;
            Some(format!("hw:{card},{dev_num}"))
        });

        if let Some(path) = path {
            let name = dev.display_name().to_string();
            log::debug!("[list_alsa_devices] found: '{}' -> {}", name, path);
            result.push(AudioDevice { id: path, name });
        }
    }

    log::debug!("[list_alsa_devices] returning {} devices", result.len());
    Ok(result)
}

/// Gapless (2b architecture) needs the `concat` element. The chain is legacy
/// `uridecodebin` then a per-branch `queue` then `concat`, which handle Tidal
/// `data:application/dash+xml` on any GStreamer with the legacy dash demuxer
/// (no GStreamer 1.24 or uridecodebin3 requirement). `concat` ships in
/// coreelements, so this is effectively always true.
pub fn gapless_supported() -> bool {
    gst::ElementFactory::find("concat").is_some()
}

#[cfg(test)]
mod proxy_source_tests {
    use super::*;
    use crate::proxy::{BlockReason, Capability, HostCaps, Route};

    #[test]
    fn the_probe_reports_the_registry_not_the_stand_in() {
        let probed = probe_host_caps();
        let (major, minor, micro, _nano) = gst::version();

        // The stand-in claims exactly the version floor, so asserting a
        // plausible version would pass against it. Assert the real one.
        assert_eq!(
            probed.gst_version,
            (major, minor, micro),
            "probe must report the linked GStreamer, not an assumption"
        );
        assert_eq!(
            probed.has_dashdemux,
            gst::ElementFactory::find("dashdemux").is_some()
        );
        assert_eq!(
            probed.has_curlhttpsrc,
            gst::ElementFactory::find("curlhttpsrc").is_some()
        );
    }

    fn http_proxy() -> crate::ProxySettings {
        crate::ProxySettings {
            enabled: true,
            proxy_type: crate::ProxyType::Http,
            host: "proxy.example".into(),
            port: 3128,
            username: None,
            password: None,
        }
    }

    #[test]
    fn a_usable_proxy_routes_both_tiers_identically() {
        let p = AudioProxy::new(http_proxy(), HostCaps::assume_all_present());
        let lossy = p.route_for(Capability::Lossy).expect("lossy is routable here");
        let dash = p.route_for(Capability::Dash).expect("dash is routable here");
        // They share one scheme arm, so when both succeed they are the same
        // value. This test exists to catch the day that stops being true.
        assert_eq!(lossy, dash);
        assert!(matches!(lossy, Route::Via { .. }));
    }

    #[test]
    fn a_tier_that_cannot_be_proxied_is_an_error_not_a_direct_route() {
        // The defect this type exists to prevent: collapsing "blocked" into
        // "no proxy" lets a refused tier stream on the user's own address.
        let mut caps = HostCaps::assume_all_present();
        caps.has_dashdemux = false;
        let p = AudioProxy::new(http_proxy(), caps);

        assert!(matches!(p.route_for(Capability::Dash), Err(BlockReason { .. })));
        assert!(
            p.route_for(Capability::Lossy).is_ok(),
            "lossy proxies fine here and must keep playing"
        );
    }

    #[test]
    fn settings_that_form_no_plan_are_an_error_not_a_direct_route() {
        let mut bad = http_proxy();
        bad.port = 0;
        let p = AudioProxy::new(bad, HostCaps::assume_all_present());
        for c in [Capability::Lossy, Capability::Dash] {
            assert!(matches!(p.route_for(c), Err(BlockReason { .. })));
        }
    }

    #[test]
    fn a_disabled_proxy_routes_directly_and_is_never_an_error() {
        let mut off = http_proxy();
        off.enabled = false;
        let p = AudioProxy::new(off, HostCaps::assume_all_present());
        for c in [Capability::Lossy, Capability::Dash] {
            assert_eq!(p.route_for(c).expect("direct is not a refusal"), Route::NoProxy);
        }
    }

    use crate::proxy::Creds;

    fn make(name: &str) -> Option<gst::Element> {
        let _ = gst::init();
        gst::ElementFactory::make(name).build().ok()
    }

    fn via(creds: Option<Creds>) -> Route {
        Route::Via {
            uri: "http://proxy.example:3128".into(),
            creds,
        }
    }

    #[test]
    fn both_credential_properties_are_set_together() {
        let src = make("souphttpsrc").expect("souphttpsrc is a base dependency");
        apply_route_to_source(
            &src,
            &via(Some(Creds {
                user: "bob".into(),
                pass: String::new(),
            })),
        );
        // This element normalizes the URI through GstUri on write, so the
        // readback gains a trailing slash. Measured, not assumed.
        assert_eq!(
            src.property::<Option<String>>("proxy").as_deref(),
            Some("http://proxy.example:3128/")
        );
        // It authenticates only when it has both properties, so an empty
        // password must still produce a pair rather than half of one.
        assert_eq!(
            src.property::<Option<String>>("proxy-id").as_deref(),
            Some("bob")
        );
        assert_eq!(
            src.property::<Option<String>>("proxy-pw").as_deref(),
            Some("")
        );
    }

    #[test]
    fn the_curl_source_receives_the_uri_byte_exact() {
        let Some(src) = make("curlhttpsrc") else {
            panic!("curlhttpsrc missing: it is a declared dependency of this app");
        };
        // Unlike souphttpsrc this one does not rewrite the value, so it is the
        // element that proves the port survives. Port 80 reaching libcurl
        // without its port is the original defect: libcurl then dials 1080.
        apply_route_to_source(
            &src,
            &Route::Via {
                uri: "http://127.0.0.1:80".into(),
                creds: None,
            },
        );
        assert_eq!(
            src.property::<Option<String>>("proxy").as_deref(),
            Some("http://127.0.0.1:80")
        );
    }

    #[test]
    fn a_noproxy_route_leaves_the_source_alone() {
        let src = make("souphttpsrc").expect("souphttpsrc is a base dependency");
        apply_route_to_source(&src, &Route::NoProxy);
        // This element's `proxy` defaults to an empty string, not NULL.
        assert!(src
            .property::<Option<String>>("proxy")
            .unwrap_or_default()
            .is_empty());
    }

    #[test]
    fn the_curl_source_gets_a_bounded_timeout_and_retry_count() {
        let Some(src) = make("curlhttpsrc") else {
            panic!("curlhttpsrc missing: it is a declared dependency of this app");
        };
        // Left at 0 and -1 a dead-but-reachable proxy produces no bus error at
        // all: playback stalls and nothing can be reported. Both are `gint` on
        // 1.24 and 1.26 alike — a `u32` panics on the streaming thread.
        apply_route_to_source(&src, &via(None));
        assert_eq!(src.property::<i32>("timeout"), 15);
        assert_eq!(src.property::<i32>("retries"), 3);
    }

    #[test]
    fn a_source_without_proxy_properties_is_left_untouched() {
        let src = make("dataurisrc").expect("dataurisrc is a base dependency");
        // The manifest for high-resolution audio arrives as a `data:` URI, and
        // the hook does see this element. `set_property` panics on a property
        // an element lacks, so the factory filter is load-bearing.
        apply_route_to_source(&src, &via(None));
    }

    #[test]
    fn the_autoplugged_https_source_is_one_we_can_configure() {
        let _ = gst::init();
        // If this is ever false on a supported host, the build sites refuse and
        // the user is told -- rather than streaming direct through a source
        // whose `proxy` property was never set because we did not recognise it.
        assert!(
            http_source_is_configurable(),
            "the winning https source is outside HTTP_SOURCE_FACTORIES"
        );
    }

    #[test]
    fn the_curl_source_is_promoted_only_while_credentials_are_in_use() {
        let _ = gst::init();
        let Some(curl) = gst::ElementFactory::find("curlhttpsrc") else {
            panic!("curlhttpsrc missing: it is a declared dependency of this app");
        };
        let original = curl.rank();

        promote_curl_source(
            &via(Some(Creds {
                user: "bob".into(),
                pass: "hunter2".into(),
            })),
            Some(original),
        );
        assert!(gst::ElementFactory::find("curlhttpsrc").unwrap().rank() > original);

        // Without credentials the soup source is correct: it handles more
        // authentication schemes and ignores an ambient `no_proxy`.
        promote_curl_source(&via(None), Some(original));
        assert_eq!(
            gst::ElementFactory::find("curlhttpsrc").unwrap().rank(),
            original,
            "rank must return to its pristine value, not merely go down"
        );

        promote_curl_source(&Route::NoProxy, Some(original));
        assert_eq!(
            gst::ElementFactory::find("curlhttpsrc").unwrap().rank(),
            original
        );
    }

    #[test]
    fn a_blocked_tier_yields_no_route_to_hand_a_pipeline() {
        // The contract the build sites rely on: when a tier is refused there is
        // no `Route` value at all, so there is nothing to accidentally apply.
        let mut caps = HostCaps::assume_all_present();
        caps.has_dashdemux = false;
        let p = AudioProxy::new(http_proxy(), caps);

        let err = p
            .route_for(capability_of(true))
            .expect_err("dash must be refused without the legacy demuxer");
        assert!(!err.cause.is_empty(), "a refusal must carry a reason to show");

        p.route_for(capability_of(false))
            .expect("lossy must still play");
    }

    #[test]
    fn the_dash_flag_is_not_inverted_on_the_way_to_a_capability() {
        // Both build sites derive the flag from this one prefix and hand the
        // result to `capability_of`. Inverting it there is silent: the refusals
        // still fire, just for the wrong tier, so hi-res would stream direct on
        // a host where only lossy is routable.
        let dash_uri = "data:application/dash+xml;base64,PE1QRD4=";
        let lossy_uri = "https://audio.example/track.flac";

        assert!(dash_uri.starts_with("data:application/dash"));
        assert!(!lossy_uri.starts_with("data:application/dash"));

        assert_eq!(
            capability_of(dash_uri.starts_with("data:application/dash")),
            Capability::Dash
        );
        assert_eq!(
            capability_of(lossy_uri.starts_with("data:application/dash")),
            Capability::Lossy
        );
    }

    #[test]
    fn the_pipeline_hook_configures_a_source_added_after_it_was_installed() {
        let _ = gst::init();
        // The hook is the whole containment mechanism for both build sites, and
        // it runs on the streaming thread where a failure is invisible. Adding
        // the source *after* the connect is the case that matters: every real
        // source appears long after the pipeline is built.
        let pipe = gst::Pipeline::new();
        watch_pipeline_sources(
            &pipe,
            via(Some(Creds {
                user: "bob".into(),
                pass: "hunter2".into(),
            })),
        );

        let src = make("souphttpsrc").expect("souphttpsrc is a base dependency");
        let bin = gst::Bin::new();
        bin.add(&src).expect("bin accepts the source");
        // Nested, so this also proves the signal reaches through a sub-bin --
        // which is how an adaptive demuxer's segment source actually arrives.
        pipe.add(&bin).expect("pipeline accepts the bin");

        assert_eq!(
            src.property::<Option<String>>("proxy").as_deref(),
            Some("http://proxy.example:3128/"),
            "a source added after the hook was installed must still be routed"
        );
        assert_eq!(
            src.property::<Option<String>>("proxy-id").as_deref(),
            Some("bob")
        );
    }

    #[test]
    fn a_stale_pipeline_is_refused_before_the_next_branch_is_prerolled() {
        let _ = gst::init();
        // `SetProxySettings` bumps the generation and only then queues the
        // rebuild on the self-sender, so a `SetNextTrack` landing in that gap is
        // served by the pipeline that is about to be replaced — whose hook still
        // applies the route the user just left. The refusal therefore has to
        // come before `attach_next_bin`, which prerolls up to fifteen seconds of
        // the next track.
        let Some(concat) = make("concat") else {
            panic!("concat ships in coreelements, and gapless is gated on it");
        };
        let pipeline = gst::Pipeline::new();
        pipeline.add(&concat).expect("pipeline accepts concat");

        let next_bin: Arc<Mutex<Option<NextBinState>>> = Arc::new(Mutex::new(None));
        let audio_proxy = Arc::new(Mutex::new(AudioProxy::new(
            crate::ProxySettings::default(),
            HostCaps::assume_all_present(),
        )));
        let route_generation = Arc::new(AtomicU64::new(7));
        let (tx, rx) = mpsc::channel::<AttachJob>();
        let executor = {
            let next_bin = Arc::clone(&next_bin);
            let route_generation = Arc::clone(&route_generation);
            std::thread::spawn(move || {
                run_attach_executor(rx, next_bin, audio_proxy, route_generation)
            })
        };

        // A file that does not exist: nothing is fetched, and the preroll
        // failing changes nothing here — `attach_next_bin` reports Ok once the
        // branch is linked into the pipeline.
        let job = |build_generation: u64, track_id: u64| AttachJob::Attach {
            pipeline: pipeline.clone(),
            concat: concat.clone(),
            build_generation,
            uri: "file:///nonexistent/sone-gapless-guard.flac".into(),
            is_dash: false,
            track_id,
            qid: track_id.to_string(),
            norm_gain: 1.0,
            replay_gain: f64::NAN,
            peak_amplitude: f64::NAN,
        };

        // The first job carries the current generation and must attach. Without
        // it a refusal proves nothing: a branch that could not be built here at
        // all would leave the same empty pipeline behind.
        tx.send(job(7, 1)).expect("the executor is running");
        tx.send(job(6, 2)).expect("the executor is running");
        drop(tx);
        executor
            .join()
            .expect("the executor thread finishes with the sender");

        let armed = next_bin
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
            .expect("the current-generation job must arm the slot");
        assert_eq!(
            armed.track_id, 1,
            "a job stamped with an older pipeline must not take the slot"
        );
        assert_eq!(
            pipeline.children().len(),
            3,
            "the stale job must add nothing: concat plus one branch (a \
             uridecodebin and its queue) is everything that may be here"
        );

        detach_bin(&pipeline, &concat, &armed.bin, &armed.branch_queue);
    }

    #[test]
    fn a_settings_change_that_alters_the_route_requires_a_rebuild() {
        let caps = HostCaps::assume_all_present();
        let off = AudioProxy::new(
            crate::ProxySettings {
                enabled: false,
                ..http_proxy()
            },
            caps,
        );
        let on = AudioProxy::new(http_proxy(), caps);
        assert!(
            audio_route_differs(&off, &on),
            "off -> proxied must force a rebuild"
        );
    }

    #[test]
    fn off_to_blocked_is_detected_as_a_change() {
        // The comparison a bare `Route` cannot make: both sides would spell
        // themselves `NoProxy`, so a route-equality test reports "no change"
        // and the direct stream continues.
        let caps = HostCaps::assume_all_present();
        let off = AudioProxy::new(
            crate::ProxySettings {
                enabled: false,
                ..http_proxy()
            },
            caps,
        );
        let blocked = AudioProxy::new(
            crate::ProxySettings {
                port: 0,
                ..http_proxy()
            },
            caps,
        );
        assert!(
            audio_route_differs(&off, &blocked),
            "off -> blocked must force a teardown, not be mistaken for no change"
        );
    }

    #[test]
    fn one_blocked_configuration_to_a_different_one_is_still_a_change() {
        // On any host below GStreamer 1.26.10 -- every non-Flatpak target in the
        // spec's table -- `route(Lossy)` is permanently Err for every credentialed
        // proxy. A comparison that treats two refusals as equal would let a user
        // switch from proxy A to proxy B mid-track and keep streaming through A.
        let mut caps = HostCaps::assume_all_present();
        caps.gst_version = (1, 24, 2);
        let with_creds = |host: &str| crate::ProxySettings {
            username: Some("bob".into()),
            password: Some("hunter2".into()),
            host: host.into(),
            ..http_proxy()
        };
        let a = AudioProxy::new(with_creds("proxy-a.example"), caps);
        let b = AudioProxy::new(with_creds("proxy-b.example"), caps);
        assert!(
            a.route_for(Capability::Lossy).is_err(),
            "precondition: lossy is gated below 1.26.10 when credentials are present"
        );
        // `BlockReason` carries no host, so the two Lossy refusals are byte
        // identical -- it is the `Dash` arm that catches this, which is exactly
        // why both capabilities have to be compared. A single-capability check
        // on `Lossy` would report "no change" and keep streaming through A.
        assert!(
            audio_route_differs(&a, &b),
            "a different blocked configuration is still a change"
        );
    }

    #[test]
    fn an_ambient_bypass_list_at_launch_blocks_audio_until_restart() {
        // `curlhttpsrc` reads `no_proxy` when the element is constructed and
        // forwards it as CURLOPT_NOPROXY, which overrides the `proxy` property
        // we set -- measured going direct. The variable can only be removed
        // before GTK threads exist, so within this session the honest answer
        // is to refuse and say why.
        let caps = HostCaps::assume_all_present();
        let p = AudioProxy::new(http_proxy(), caps).with_launch_bypass(true);

        for c in [Capability::Lossy, Capability::Dash] {
            let err = p.route_for(c).expect_err("a bypass list must block audio");
            assert!(
                err.cause.contains("restart"),
                "the reason must tell the user what to do, got: {}",
                err.cause
            );
        }
    }

    #[test]
    fn a_bypass_list_is_irrelevant_when_the_proxy_is_off() {
        // Direct means the system's own configuration applies -- including its
        // bypass list. Refusing here would break playback for a user who is not
        // proxying at all.
        let mut off = http_proxy();
        off.enabled = false;
        let p = AudioProxy::new(off, HostCaps::assume_all_present()).with_launch_bypass(true);
        for c in [Capability::Lossy, Capability::Dash] {
            assert_eq!(p.route_for(c).expect("direct is unaffected"), Route::NoProxy);
        }
    }
}
