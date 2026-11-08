//! Local HTTP server that hands DASH/playlist files to the receiver.
//!
//! [Maintainer walkthrough] The receiver cannot play a TIDAL CDN URL that the
//! app can fetch (the OAuth flow is per client), so Sone re-serves the media
//! descriptions locally: `play_tidal_track` feeds the track's DASH XML here,
//! the receiver is pushed `http://<lan-ip>:<port>/<name>.mpd` (or an `.m3u8`
//! playlist of several such entries), and the receiver HTML-fetches the
//! manifest, resolves segment URLs (which still point at TIDAL's CDN) and
//! decodes on its own. This crate serves exactly three things:
//!
//! - `/<name>.mpd` - the DASH manifest of the current track, byte-identical to
//!   what TIDAL returned (zero-copy: the server string-matches ranges, never
//!   reparses, so a TIDAL-side schema tweak cannot silently corrupt it);
//! - `/<name>.m3u8` - a native playlist manifest (audio entries), which makes
//!   the receiver preload upcoming entries ~20-40 s early and advance
//!   seamlessly (`QueueEntry::Manifest` lanes map to `/q<gen>-<i>.mpd`);
//! - trimmed `.mpd` variants (`/...-s<sec>.mpd`, built by `trim_mpd`) which is
//!   how seek works - the A98 cannot seek its own player.
//!
//! Rules honored here (see AGENTS.md 5.3):
//! - Generation counters in entry paths (`q<gen>-<i>.mpd`): the receiver
//!   caches by URL, so a re-push of an entry with the SAME URL is a no-op.
//! - Every HTTP body assembled by string surgery (trimmed manifests)
//!   passes a well-formedness gate; a silently truncated XML is the killer
//!   failure mode (receiver answers OK, then wedges with `totlen=0`).
//! - The server binds only when a cast needs it (`ensure_started`) and picks
//!   its port at bind time; the LAN IP comes from a UDP probe, not a
//!   guessed address.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::RwLock;

/// One entry of a served playlist.
///
/// The A98 receiver plays a native queue when it is handed an `.m3u8` list of
/// URLs (verified 2026-11-01: it preloads the next entry ~90 s before the
/// boundary and transitions with a continuous clock, no re-push and no gap).
/// A DASH track cannot be listed by CDN URL, so each DASH entry is served from
/// this endpoint instead, and non-DASH tracks are listed by their direct URL.
#[derive(Clone, Debug)]
pub enum QueueEntry {
    /// DASH manifest XML, served at `/q<gen>-<i>.mpd`.
    Manifest(String),
    /// Direct (non-DASH) stream URL, listed verbatim in the playlist.
    Direct(String),
}

impl QueueEntry {
    /// The manifest body when this entry is DASH-served.
    pub fn manifest(&self) -> Option<&str> {
        match self {
            QueueEntry::Manifest(xml) => Some(xml),
            QueueEntry::Direct(_) => None,
        }
    }
}

/// Tiny local HTTP endpoint that serves the current TIDAL DASH manifest so
/// the receiver can pull it over the LAN by plain URL. Segment URLs inside
/// TIDAL manifests are absolute (`audio.tidal.com`), so the only body we
/// ever serve is the manifest itself and the receiver fetches the segments
/// straight from the CDN.
///
/// The listener binds once on an ephemeral port and serves whatever manifest
/// `set()` stores at the time of the request; it lives for the process
/// lifetime. `set_queue()` additionally installs a playlist: every entry body
/// plus the `.m3u8` list that points at them.
pub struct ManifestServer {
    inner: Arc<Inner>,
}

struct Inner {
    base_url: RwLock<Option<String>>,
    body: RwLock<Vec<u8>>,
    /// Installed playlist (native queue cast), if any.
    queue: RwLock<Option<ServedQueue>>,
    /// Bumped by every `set_queue()` so entry paths never repeat: the
    /// receiver caches by URL (the single-manifest seek path already needs a
    /// `-s<secs>` suffix for exactly this reason).
    generation: AtomicU64,
}

struct ServedQueue {
    playlist: Vec<u8>,
    entries: Vec<QueueEntry>,
}

/// How a request path is served.
#[derive(Debug, PartialEq, Eq)]
enum Served {
    /// The installed `.m3u8` playlist.
    Playlist,
    /// One playlist entry body, by index.
    Entry(usize),
    /// The single installed manifest body (any other path).
    Single,
}

fn route(path: &str) -> Served {
    if path.ends_with(".m3u8") {
        return Served::Playlist;
    }
    match parse_entry_path(path) {
        Some(idx) => Served::Entry(idx),
        None => Served::Single,
    }
}

/// `/q<generation>-<index>[-*].mpd` -> index.
fn parse_entry_path(path: &str) -> Option<usize> {
    let name = path.trim_start_matches('/');
    let (generation, rest) = name.split_once('-')?;
    let generation = generation.strip_prefix('q')?;
    generation.parse::<u64>().ok()?;
    let stem = rest.strip_suffix(".mpd")?;
    let idx_str = stem.split('-').next()?;
    idx_str.parse().ok()
}

impl Default for ManifestServer {
    fn default() -> Self {
        Self::new()
    }
}

impl ManifestServer {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                base_url: RwLock::new(None),
                body: RwLock::new(Vec::new()),
                queue: RwLock::new(None),
                generation: AtomicU64::new(0),
            }),
        }
    }

    /// Bind the endpoint once and start the accept loop. Later calls are
    /// no-ops while the first listener is alive. Returns the pathless base
    /// URL (`http://<local-lan-ip>:<port>`); callers append the served path.
    pub async fn ensure_started(&self, receiver_ip: &str) -> Result<String, String> {
        if let Some(base) = self.inner.base_url.read().await.clone() {
            return Ok(base);
        }
        let listener = TcpListener::bind("0.0.0.0:0")
            .await
            .map_err(|e| format!("manifest server bind failed: {}", e))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("manifest server local_addr failed: {}", e))?
            .port();

        // Derive our LAN address as seen on the path to the receiver via a
        // UDP connect probe (no packet is sent; connect disallowed: route
        // lookup only).
        let local_ip = udp_probe_ip(receiver_ip)
            .or_else(|| udp_probe_ip("8.8.8.8"))
            .unwrap_or_else(|| "127.0.0.1".to_string());

        let base = format!("http://{}:{}", local_ip, port);
        *self.inner.base_url.write().await = Some(base.clone());

        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            loop {
                let (mut stream, _) = match listener.accept().await {
                    Ok(pair) => pair,
                    Err(_) => continue,
                };
                let inner = Arc::clone(&inner);
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let read = stream.read(&mut buf).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..read]);
                    let path = head
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_string();
                    let (body, content_type) = {
                        match route(&path) {
                            Served::Playlist => {
                                let guard = inner.queue.read().await;
                                match guard.as_ref() {
                                    Some(q) => (
                                        Some(q.playlist.clone()),
                                        "application/vnd.apple.mpegurl",
                                    ),
                                    None => (None, "text/plain"),
                                }
                            }
                            Served::Entry(idx) => {
                                let guard = inner.queue.read().await;
                                let body = guard
                                    .as_ref()
                                    .and_then(|q| q.entries.get(idx))
                                    .and_then(|e| e.manifest())
                                    .map(|xml| xml.as_bytes().to_vec());
                                if let Some(ref b) = body {
                                    *inner.body.write().await = b.clone();
                                }
                                (body, "application/dash+xml")
                            }
                            Served::Single => (
                                Some(inner.body.read().await.clone()),
                                "application/dash+xml",
                            ),
                        }
                    };
                    let body = match body {
                        Some(b) if !b.is_empty() => b,
                        _ => {
                            let _ = stream
                                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                                .await;
                            return;
                        }
                    };
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        content_type,
                        body.len()
                    );
                    let _ = stream.write_all(head.as_bytes()).await;
                    let _ = stream.write_all(&body).await;
                    let _ = stream.flush().await;
                });
            }
        });
        Ok(base)
    }

    /// Install the manifest to serve on the next request.
    pub async fn set(&self, manifest_xml: &str) -> Result<String, String> {
        // The base URL needs the receiver's LAN segment; it is set by the
        // first ensure_started() call. If not started yet, fall back to
        // binding now with a syntactically simple receiver address.
        let base = {
            let guard = self.inner.base_url.read().await;
            guard.clone()
        };
        match base {
            Some(b) => {
                *self.inner.body.write().await = manifest_xml.as_bytes().to_vec();
                Ok(b)
            }
            None => Err("manifest server not started".into()),
        }
    }

    /// Install a playlist and serve every entry body, returning the playlist
    /// URL to push. `name` only shapes the pushed path (the receiver displays
    /// the URL it was handed and ignores every metadata channel, see
    /// `push_display_name_from`), so it should read like `Artist - Title`.
    ///
    /// The receiver reads the playlist exactly ONCE at push time (verified
    /// 2026-11-01: a mid-play rewrite was ignored while it kept fetching the
    /// entries it had already seen), so the full list must be installed before
    /// the push.
    pub async fn set_queue(
        &self,
        name: &str,
        entries: Vec<QueueEntry>,
    ) -> Result<String, String> {
        self.set_queue_with_titles(name, entries, Vec::new()).await
    }

    /// Install a playlist and serve every entry body, returning the playlist
    /// URL to push. Generates standard #EXTM3U and #EXTINF tags so companion
    /// apps and receivers have clean metadata.
    pub async fn set_queue_with_titles(
        &self,
        name: &str,
        entries: Vec<QueueEntry>,
        titles: Vec<String>,
    ) -> Result<String, String> {
        let base = {
            let guard = self.inner.base_url.read().await;
            guard.clone()
        };
        let base = base.ok_or_else(|| "manifest server not started".to_string())?;
        if entries.is_empty() {
            return Err("playlist has no entries".into());
        }
        let generation = self.inner.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let mut playlist = String::with_capacity(entries.len() * 128);
        playlist.push_str("#EXTM3U\n#EXT-X-VERSION:3\n");
        for (idx, entry) in entries.iter().enumerate() {
            let title_opt = titles.get(idx).map(|s| s.as_str());
            match entry {
                QueueEntry::Manifest(_) => {
                    let path = match title_opt {
                        Some(t) => {
                            let clean = t.replace('/', "-");
                            format!("{}/q{}-{}-{}.mpd\n", base, generation, idx, clean)
                        }
                        None => format!("{}/q{}-{}.mpd\n", base, generation, idx),
                    };
                    if let Some(t) = title_opt {
                        playlist.push_str(&format!("#EXTINF:-1,{}\n", t));
                    }
                    playlist.push_str(&path);
                }
                QueueEntry::Direct(url) => {
                    if let Some(t) = title_opt {
                        playlist.push_str(&format!("#EXTINF:-1,{}\n", t));
                    }
                    playlist.push_str(url);
                    playlist.push('\n');
                }
            }
        }
        let url = format!("{}/{}.m3u8", base, name);
        if let Some(first_manifest) = entries.first().and_then(|e| e.manifest()) {
            *self.inner.body.write().await = first_manifest.as_bytes().to_vec();
        }
        *self.inner.queue.write().await = Some(ServedQueue {
            playlist: playlist.into_bytes(),
            entries,
        });
        Ok(url)
    }
}

/// Trim a TIDAL DASH manifest so its first segment is the one covering
/// `offset_s`. This is how a push-URL cast seeks on A98 firmware: the
/// receiver cannot seek its own player (`setPlayerCmd:seek` wedges it
/// permanently, see AGENTS.md 5.3), but it happily plays a manifest that
/// simply starts further into the media (verified 2026-10-24 with an
/// unsupervised push: the receiver began playback within one poll tick and
/// reported the trimmed `mediaPresentationDuration` as its `totlen`).
///
/// TIDAL audio manifests are uniformly the narrow shape this assumes: one
/// Period, one Representation, `<SegmentTemplate timescale=".."
/// initialization=".." media=".." startNumber="N">` with one
/// `<SegmentTimeline>` of self-closing `<S d=".." (r="k")?/>` entries. The
/// signed CDN URL attributes are long and must stay byte-identical, so the
/// rewrite is three anchored edits (timeline body, startNumber,
/// mediaPresentationDuration value) instead of a full XML
/// re-serialization.
///
/// Segments are quantized (~3.968 s on this build): playback starts at or
/// slightly before the requested offset, never after it. Returns the
/// trimmed XML and the remaining duration in seconds, or None when the
/// shape does not match or the offset lands at or past the track end.
pub fn trim_mpd(manifest_xml: &str, offset_s: f64) -> Option<(String, f64)> {
    if !offset_s.is_finite() || offset_s <= 0.0 || !manifest_xml.contains("<SegmentTimeline>") {
        return None;
    }
    const TIMELINE_OPEN: &str = "<SegmentTimeline>";
    const TIMELINE_CLOSE: &str = "</SegmentTimeline>";

    let open_end = manifest_xml.find(TIMELINE_OPEN)?;
    let timescale = extract_int(&manifest_xml[..open_end], "timescale")?;
    let start_number = extract_int(&manifest_xml[..open_end], "startNumber")?;
    if timescale == 0 {
        return None;
    }

    let tl_start = open_end + TIMELINE_OPEN.len();
    let tl_end = manifest_xml[tl_start..]
        .find(TIMELINE_CLOSE)
        .map(|rel| tl_start + rel + TIMELINE_CLOSE.len())?;
    let timeline = &manifest_xml[tl_start..tl_end];

    // Walk the <S .../> entries into (d, repeat) rows, preserving order.
    let mut rows: Vec<(u64, u64)> = Vec::new();
    let mut cursor = 0;
    while let Some(rel) = timeline[cursor..].find("<S ") {
        let at = cursor + rel;
        let close = timeline[at..].find("/>")? + at + 2;
        let entry = &timeline[at..close];
        let d = extract_int(entry, "d")?;
        let r = extract_int(entry, "r").unwrap_or(0);
        rows.push((d, r));
        cursor = close;
    }
    if rows.is_empty() {
        return None;
    }

    // Expand rows into period-relative segment durations (the receiver's
    // clock restarts at the first kept segment, so numbering offsets in the
    // URL template carry the media identity; period ticks define position).
    let mut segs: Vec<u64> = Vec::new();
    for &(d, r) in &rows {
        for _ in 0..r + 1 {
            segs.push(d);
        }
    }

    // First segment whose period-relative end tick covers the offset. The
    // tick window is [1, end) so an exact boundary lands on the NEXT
    // segment (the one that actually contains the tick after the join).
    let offset_ticks = ((offset_s.max(0.0) * timescale as f64) as u64).max(1);
    let mut first: Option<usize> = None;
    let mut tick: u64 = 0;
    for (idx, &d) in segs.iter().enumerate() {
        let end = tick + d;
        if offset_ticks < end {
            first = Some(idx);
            break;
        }
        tick = end;
    }
    let first = first?;

    // Drop the leading segments, merge equal durations back into d + repeat
    // runs, and compute the remaining period-relative length.
    let kept: Vec<u64> = segs[first..].to_vec();
    let kept_dur: u64 = kept.iter().sum();
    let remaining_s = kept_dur as f64 / timescale as f64;

    let mut out = String::with_capacity(timeline.len());
    let mut i = 0;
    while i < kept.len() {
        let d = kept[i];
        let mut run = i;
        while run + 1 < kept.len() && kept[run + 1] == d {
            run += 1;
        }
        let repeats = run - i;
        if repeats > 0 {
            out.push_str(&format!("<S d=\"{}\" r=\"{}\"/>", d, repeats));
        } else {
            out.push_str(&format!("<S d=\"{}\"/>", d));
        }
        i = run + 1;
    }

    let mut result = String::with_capacity(manifest_xml.len());
    result.push_str(&manifest_xml[..tl_start]);
    result.push_str(&out);
    result.push_str(TIMELINE_CLOSE);
    result.push_str(&manifest_xml[tl_end..]);

    // Renumber startNumber: the kept span resumes the original media
    // numbering so the CDN `$Number$` template resolves existing files.
    let new_start = start_number + first as u64;
    let old_attr = format!("startNumber=\"{}\"", start_number);
    let new_attr = format!("startNumber=\"{}\"", new_start);
    if result.matches(&old_attr).count() != 1 {
        return None;
    }
    let span = {
        let at = result.find(&old_attr)?;
        at..at + old_attr.len()
    };
    result.replace_range(span, &new_attr);

    // Shrink the advertised duration to the kept span; the receiver maps
    // PT..S straight onto its `totlen` field.
    let attr_pat = "mediaPresentationDuration=\"";
    let value = format!("PT{:.3}S", remaining_s);
    let span = {
        let at = result.find(attr_pat)? + attr_pat.len();
        let end = result[at..].find('"')? + at;
        at..end
    };
    result.replace_range(span, &value);

    Some((result, remaining_s))
}

fn extract_int(s: &str, name: &str) -> Option<u64> {
    let pat = format!("{}=\"", name);
    let at = s.find(&pat)? + pat.len();
    let end = s[at..].find('"')? + at;
    s[at..end].parse().ok()
}

fn udp_probe_ip(dst: &str) -> Option<String> {
    match std::net::UdpSocket::bind("0.0.0.0:0") {
        Ok(sock) => {
            if sock.connect((dst, 53)).is_ok() {
                sock.local_addr().ok().map(|a| a.ip().to_string())
            } else {
                None
            }
        }
        Err(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{route, trim_mpd, ManifestServer, QueueEntry, Served};

    /// Real shape captured from a served TIDAL HI_RES_LOSSLESS manifest
    /// (2026-10-24, Jellybelly 24/96): 57 segments (56 x 380928 + 164482
    /// ticks at timescale 96000, ~3.968 s each), signed absolute CDN URL
    /// attributes. The URL blobs are abbreviated to keep the sample short
    /// but the attribute grammar intact.
    fn sample_segments() -> String {
        format!("<S d=\"380928\" r=\"55\"/><S d=\"164482\"/>")
    }

    fn sample_mpd() -> String {
        format!(
            "<MPD profiles=\"p\" type=\"static\" minBufferTime=\"PT3.968S\" \
             mediaPresentationDuration=\"PT223.921S\"><Period id=\"0\">\
<AdaptationSet id=\"0\" contentType=\"audio\"><Representation id=\"R\" codecs=\"flac\">\
<SegmentTemplate timescale=\"96000\" initialization=\"{init}\" media=\"{media}\" startNumber=\"1\">\
<SegmentTimeline>{segs}</SegmentTimeline></SegmentTemplate>\
</Representation></AdaptationSet></Period></MPD>",
            init = "https://cdn.example/init/0.mp4?Policy=SIG",
            media = "https://cdn.example/media/$Number$.mp4?Policy=SIG",
            segs = sample_segments()
        )
    }

    /// Hand-rolled well-formedness gate: every close must mirror the most
    /// recent open. Self-closing tags are skipped; the declaration tag is
    /// ignored. Walks raw bytes so no XML dependency is needed; this exists
    /// because string surgery in trim_mpd dropped `</SegmentTimeline>` in a
    /// way that only showed up as a wedged receiver engine (the malformed
    /// body still looks plausible and the receivers swallows the parse
    /// error silently), not as a failing string assertion.
    fn assert_wellformed(xml: &str) {
        let mut stack: Vec<String> = Vec::new();
        let mut rest = xml;
        while let Some(at) = rest.find('<') {
            let after = &rest[at + 1..];
            if after.starts_with('?') {
                // Declaration/processing tag: skip to its end.
                let end = after.find('>').expect("processing tag closed");
                rest = &after[end + 1..];
                continue;
            }
            let end_rel = after.find('>').expect("tag closed");
            let inner = &after[..end_rel];
            rest = &after[end_rel + 1..];
            if inner.starts_with('!') {
                continue; // DOCTYPE/comment are out of scope for these bodies
            }
            if let Some(name) = inner.strip_prefix('/') {
                let name = name.trim();
                let top = stack.pop().expect("close tag without matching open");
                assert_eq!(
                    top, name,
                    "expected </{}> got </{}>; near: ...{}",
                    top,
                    name,
                    &xml[(xml.len() - xml.len().max(rest.len()))..][..160.min(xml.len())]
                );
            } else if !inner.ends_with('/') {
                // do not treat attribute-embedded '/' as self-close: only a
                // trailing '/' right before '>' is.
                let name: String = inner
                    .chars()
                    .take_while(|c| *c != ' ' && *c != '\t' && *c != '\n')
                    .collect();
                assert!(!name.is_empty(), "empty tag name near: {}", xml.len() - rest.len());
                stack.push(name);
            }
        }
        assert!(
            stack.is_empty(),
            "unclosed tags remain: {:?} in\n{}",
            stack,
            xml
        );
    }

    #[test]
    fn every_trim_output_is_wellformed_xml() {
        // The missing </SegmentTimeline> regression produced bodies that
        // passed every fragment assertion here and still wedged the receiver
        // (XML parse error). Every trim path result must balance tags.
        for offset in [1.0, 30.0, 60.0, 120.0, 222.0, 223.0] {
            if let Some((trimmed, _)) = trim_mpd(&sample_mpd(), offset) {
                assert_wellformed(&trimmed);
            }
        }
    }

    #[test]
    #[should_panic(expected = "expected </")]
    fn gate_rejects_missing_close_tag() {
        // Shape of the 2026-10-24 bug: timeline close tag dropped.
        assert_wellformed("<MPD><a><SegmentTimeline><s/></a></SegmentTimeline></MPD>");
    }

    #[test]
    fn trims_to_containing_segment() {
        let xml = sample_mpd();
        let (trimmed, remaining) = trim_mpd(&xml, 60.0).expect("trim succeeds");
        // 59.52 < 60 -> first kept segment is the 16th (ticks 5,760,000
        // falls inside segment 16: ticks 5,579,520..5,960,448).
        assert!(trimmed.contains("startNumber=\"16\""), "{}", trimmed);
        // 41 full segments + the tail: 41*380928 + 164482 = 15,782,530 ticks
        // = 164.401 s.
        let expected_remaining = (41.0 * 380928.0 + 164482.0) / 96000.0;
        assert!((remaining - expected_remaining).abs() < 1e-6, "{}", remaining);
        // Timeline restarts the equal-duration run without the dropped ones.
        assert!(trimmed.contains("<S d=\"380928\" r=\"40\"/><S d=\"164482\"/>"));
        assert!(trimmed.contains(r#"mediaPresentationDuration="PT164.401S""#));
    }

    #[test]
    fn renumbers_and_shrinks_duration() {
        let (trimmed, remaining) = trim_mpd(&sample_mpd(), 120.0).expect("trim succeeds");
        assert!(trimmed.contains("startNumber=\"31\""));
        let expected_remaining = (26.0 * 380928.0 + 164482.0) / 96000.0;
        assert!((remaining - expected_remaining).abs() < 1e-6);
        assert!(trimmed.contains(r#"mediaPresentationDuration="PT104.881S""#));
    }

    #[test]
    fn keeps_url_attributes_byte_identical() {
        let xml = sample_mpd();
        let (trimmed, _) = trim_mpd(&xml, 120.0).expect("trim succeeds");
        for url in [
            "initialization=\"https://cdn.example/init/0.mp4?Policy=SIG\"",
            "media=\"https://cdn.example/media/$Number$.mp4?Policy=SIG\"",
        ] {
            assert_eq!(xml.matches(url).count(), trimmed.matches(url).count());
            assert!(trimmed.contains(url));
        }
    }

    #[test]
    fn trim_is_only_for_offsets_after_zero() {
        // offset <= 0 is a no-op by contract: the caller re-pushes unchanged.
        assert!(trim_mpd(&sample_mpd(), 0.0).is_none());
        assert!(trim_mpd(&sample_mpd(), -5.0).is_none());
    }

    #[test]
    fn offset_inside_first_segment_keeps_everything() {
        let (trimmed, remaining) = trim_mpd(&sample_mpd(), 1.0).expect("trim succeeds");
        assert!(trimmed.contains("startNumber=\"1\""));
        assert!((remaining - 223.921f64).abs() < 0.1);
        // Nothing was dropped, so the timeline body is unchanged.
        assert!(trimmed.contains("<S d=\"380928\" r=\"55\"/><S d=\"164482\"/>"));
    }

    #[test]
    fn offset_in_tail_segment_keeps_only_tail() {
        // 223 s exceeds every full segment; only the final 1.7 s remains.
        let (trimmed, remaining) = trim_mpd(&sample_mpd(), 223.0).expect("trim succeeds");
        assert!(trimmed.contains("startNumber=\"57\""));
        assert!(remaining < 2.0);
    }

    #[test]
    fn offset_past_end_fails_closed() {
        assert!(trim_mpd(&sample_mpd(), 999.0).is_none());
        assert!(trim_mpd("not a manifest", 10.0).is_none());
    }

    /// Playlist routing: the receiver fetches the `.m3u8` once and then each
    /// entry body by its generated path, while a plain single-manifest cast
    /// keeps using an arbitrary path (the seek path appends `-s<secs>`).
    #[test]
    fn routes_playlist_entries_and_single_body() {
        assert_eq!(route("/q3-0.mpd"), Served::Entry(0));
        assert_eq!(route("/q3-0-First Song.mpd"), Served::Entry(0));
        assert_eq!(route("/q12-11.mpd"), Served::Entry(11));
        assert_eq!(route("/q12-11-Second Song.mpd"), Served::Entry(11));
        assert_eq!(route("/Smashing Pumpkins - Tonight, Tonight.m3u8"), Served::Playlist);
        assert_eq!(route("/Smashing Pumpkins - Tonight, Tonight-s30.mpd"), Served::Single);
        // Not an entry path: no generation prefix, wrong extension, bad index.
        assert_eq!(route("/q-3.mpd"), Served::Single);
        assert_eq!(route("/q3-3.mp4"), Served::Single);
        assert_eq!(route("/q3-x.mpd"), Served::Single);
    }

    #[tokio::test]
    async fn set_queue_with_titles_generates_extinf_and_named_paths() {
        let server = ManifestServer::new();
        *server.inner.base_url.write().await = Some("http://127.0.0.1:35443".to_string());
        let entries = vec![
            QueueEntry::Manifest("<MPD>1</MPD>".into()),
            QueueEntry::Direct("https://tidal.com/stream2.mp4".into()),
        ];
        let titles = vec![
            "Ariana Grande - hate that i made you love me".to_string(),
            "Ariana Grande - petal".to_string(),
        ];
        let playlist_url = server
            .set_queue_with_titles("Ariana Grande - Album", entries, titles)
            .await
            .unwrap();
        assert_eq!(
            playlist_url,
            "http://127.0.0.1:35443/Ariana Grande - Album.m3u8"
        );

        let queue_guard = server.inner.queue.read().await;
        let queue = queue_guard.as_ref().unwrap();
        let body = String::from_utf8(queue.playlist.clone()).unwrap();
        assert!(body.starts_with("#EXTM3U\n#EXT-X-VERSION:3\n"));
        assert!(body.contains("#EXTINF:-1,Ariana Grande - hate that i made you love me\n"));
        assert!(body.contains("http://127.0.0.1:35443/q1-0-Ariana Grande - hate that i made you love me.mpd\n"));
        assert!(body.contains("#EXTINF:-1,Ariana Grande - petal\nhttps://tidal.com/stream2.mp4\n"));
    }
}
