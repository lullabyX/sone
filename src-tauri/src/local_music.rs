use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::path::Path;
use walkdir::WalkDir;

use base64::Engine;
use id3::TagLike;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalTrack {
    pub id: u64,
    pub file_path: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration: f64,
    pub track_number: Option<u32>,
    pub bit_depth: Option<u32>,
    pub sample_rate: Option<u32>,
    pub codec: Option<String>,
    pub cover_art_mime: Option<String>,
    pub cover_art_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedTrack {
    pub id: u64,
    pub file_path: String,
    #[serde(rename = "mtime_secs")]
    pub mtime_secs: u64,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration: f64,
    pub track_number: Option<u32>,
    pub bit_depth: Option<u32>,
    pub sample_rate: Option<u32>,
    pub codec: Option<String>,
}

impl CachedTrack {
    pub fn from_local(track: &LocalTrack, mtime_secs: u64) -> Self {
        Self {
            id: track.id,
            file_path: track.file_path.clone(),
            mtime_secs,
            title: track.title.clone(),
            artist: track.artist.clone(),
            album: track.album.clone(),
            duration: track.duration,
            track_number: track.track_number,
            bit_depth: track.bit_depth,
            sample_rate: track.sample_rate,
            codec: track.codec.clone(),
        }
    }

    pub fn to_local(&self) -> LocalTrack {
        LocalTrack {
            id: self.id,
            file_path: self.file_path.clone(),
            title: self.title.clone(),
            artist: self.artist.clone(),
            album: self.album.clone(),
            duration: self.duration,
            track_number: self.track_number,
            bit_depth: self.bit_depth,
            sample_rate: self.sample_rate,
            codec: self.codec.clone(),
            cover_art_mime: None,
            cover_art_base64: None,
        }
    }
}

pub fn compute_file_id(path: &str) -> u64 {
    let canonical = std::fs::canonicalize(path)
        .unwrap_or_else(|_| Path::new(path).to_path_buf());
    let mut hasher = DefaultHasher::new();
    canonical.to_string_lossy().hash(&mut hasher);
    "sone.local".hash(&mut hasher);
    hasher.finish()
}

pub fn is_supported_file(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            let ext = ext.to_lowercase();
            ext == "flac" || ext == "mp3"
        }
        None => false,
    }
}

fn get_codec(path: &Path) -> Option<String> {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => match ext.to_lowercase().as_str() {
            "flac" => Some("FLAC".to_string()),
            "mp3" => Some("MP3".to_string()),
            _ => None,
        },
        None => None,
    }
}

// ── FLAC STREAMINFO parsing ────────────────────────────────────────────

struct FlacStreamInfo {
    sample_rate: u32,
    bits_per_sample: u32,
    channels: u32,
    total_samples: u64,
}

fn parse_flac_streaminfo(data: &[u8]) -> Option<FlacStreamInfo> {
    if data.len() < 42 || &data[0..4] != b"fLaC" {
        return None;
    }
    // STREAMINFO is always the first metadata block, at offset 4
    let header = &data[4..8];
    let block_type = header[0] & 0x7F;
    if block_type != 0 {
        return None; // not STREAMINFO
    }
    let block_data = &data[8..42]; // 34 bytes
    if block_data.len() < 34 {
        return None;
    }

    // Sample rate: bits 40-59 within the 34-byte block (bytes 4-7 high 4 bits + byte 8 low 4 bits)
    // Using bytes as read:
    //   block_data[4..7] = 3 bytes (frame size data), then
    //   sample_rate_high = block_data[4] & 0x0F  (top 4 bits of 20-bit sample rate)
    //   sample_rate_mid  = block_data[5]
    //   sample_rate_low  = block_data[6]
    // Actually, the layout is:
    //   bytes 0-1: min block size (16 bits)
    //   bytes 2-3: max block size (16 bits)
    //   bytes 4-6: min frame size (24 bits)
    //   bytes 7-9: max frame size (24 bits)
    //   bytes 10-12+ (20 bits): sample rate
    //   next 3 bits: channels - 1
    //   next 5 bits: bits per sample - 1
    //   next 36 bits: total samples

    // Read 64-bit chunk starting at offset 10
    let b10 = block_data[10] as u64;
    let b11 = block_data[11] as u64;
    let b12 = block_data[12] as u64;
    let b13 = block_data[13] as u64;
    let b14 = block_data[14] as u64;
    let b15 = block_data[15] as u64;
    let b16 = block_data[16] as u64;
    let b17 = block_data[17] as u64;

    let combined = (b10 << 56)
        | (b11 << 48)
        | (b12 << 40)
        | (b13 << 32)
        | (b14 << 24)
        | (b15 << 16)
        | (b16 << 8)
        | b17;

    let sample_rate = ((combined >> 44) & 0xFFFFF) as u32;
    let channels = (((combined >> 41) & 0x7) + 1) as u32;
    let bits_per_sample = (((combined >> 36) & 0x1F) + 1) as u32;
    let total_samples = combined & 0xFFFFFFFFF;

    if sample_rate == 0 {
        return None;
    }

    Some(FlacStreamInfo {
        sample_rate,
        bits_per_sample,
        channels,
        total_samples,
    })
}

// ── FLAC Vorbis Comment tag reading ─────────────────────────────────────

fn read_flac_tags(data: &[u8]) -> (Option<String>, Option<String>, Option<String>, Option<u32>) {
    let mut title: Option<String> = None;
    let mut artist: Option<String> = None;
    let mut album: Option<String> = None;
    let mut track_number: Option<u32> = None;

    if data.len() < 42 || &data[0..4] != b"fLaC" {
        return (title, artist, album, track_number);
    }

    let mut offset = 4;
    let mut last_block = false;

    while !last_block && offset + 4 <= data.len() {
        let header = u32::from_be_bytes([
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
        ]);
        last_block = (header & 0x8000_0000) != 0;
        let block_type = ((header >> 24) & 0x7F) as u8;
        let block_len = (header & 0x00FF_FFFF) as usize;
        offset += 4;

        if offset + block_len > data.len() {
            break;
        }

        if block_type == 4 {
            // VORBIS_COMMENT
            let block = &data[offset..offset + block_len];
            if let Some(t) = parse_vorbis_comment_field(block, b"TITLE=") {
                title = Some(t);
            }
            if let Some(a) = parse_vorbis_comment_field(block, b"ARTIST=") {
                artist = Some(a);
            }
            if let Some(a) = parse_vorbis_comment_field(block, b"ALBUM=") {
                album = Some(a);
            }
            if let Some(tn) = parse_vorbis_comment_field(block, b"TRACKNUMBER=") {
                track_number = tn.parse::<u32>().ok();
            }
            break; // Vorbis comment found, done
        }

        offset += block_len;
    }

    (title, artist, album, track_number)
}

fn parse_vorbis_comment_field(block: &[u8], field: &[u8]) -> Option<String> {
    if block.len() < 8 {
        return None;
    }
    // Skip vendor length (4 bytes LE) + vendor string
    let vendor_len = u32::from_le_bytes([block[0], block[1], block[2], block[3]]) as usize;
    let mut pos = 4 + vendor_len;
    if pos + 4 > block.len() {
        return None;
    }
    let num_comments = u32::from_le_bytes([
        block[pos],
        block[pos + 1],
        block[pos + 2],
        block[pos + 3],
    ]) as usize;
    pos += 4;

    for _ in 0..num_comments {
        if pos + 4 > block.len() {
            break;
        }
        let comment_len =
            u32::from_le_bytes([block[pos], block[pos + 1], block[pos + 2], block[pos + 3]])
                as usize;
        pos += 4;
        if pos + comment_len > block.len() {
            break;
        }
        let comment_bytes = &block[pos..pos + comment_len];
        if comment_bytes.len() >= field.len()
            && comment_bytes[..field.len()].eq_ignore_ascii_case(field)
        {
            let value = String::from_utf8_lossy(&comment_bytes[field.len()..]).to_string();
            return Some(value);
        }
        pos += comment_len;
    }

    None
}

// ── MP3 frame header parsing ────────────────────────────────────────────

const MP3_BITRATES: [[u16; 16]; 4] = [
    // MPEG 2.5 (unused)
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // reserved
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // MPEG 2
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
    // MPEG 1
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
];

const MP3_SAMPLERATES: [[u32; 4]; 4] = [
    [11025, 12000, 8000, 0],   // MPEG 2.5
    [0, 0, 0, 0],              // reserved
    [22050, 24000, 16000, 0],  // MPEG 2
    [44100, 48000, 32000, 0],  // MPEG 1
];

fn find_mp3_sync(data: &[u8], offset: usize) -> Option<usize> {
    let mut i = offset;
    while i + 2 <= data.len() {
        if data[i] == 0xFF && (data[i + 1] & 0xE0) == 0xE0 {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn parse_mp3_frame(data: &[u8], offset: usize) -> Option<(u32, u32, u32)> {
    if offset + 4 > data.len() {
        return None;
    }
    let b1 = data[offset + 1];
    let b2 = data[offset + 2];

    let mpeg_version = ((b1 >> 3) & 0x03) as usize; // bits 19-20
    let layer = ((b1 >> 1) & 0x03) as usize; // bits 17-18
    let bitrate_idx = ((b2 >> 4) & 0x0F) as usize; // bits 12-15
    let sample_rate_idx = ((b2 >> 2) & 0x03) as usize; // bits 10-11

    if mpeg_version == 1 || mpeg_version == 0 || layer != 3 {
        // layer == 3 means Layer III (MP3). 1 is reserved.
        // mpeg_version: 3=MPEG 1, 2=MPEG 2, 0=MPEG 2.5
        return None;
    }

    let version_row = if mpeg_version == 3 { 3 } else { 2 };
    let bitrate = MP3_BITRATES[version_row][bitrate_idx] as u32;
    let sample_rate = MP3_SAMPLERATES[mpeg_version][sample_rate_idx];

    if bitrate == 0 || sample_rate == 0 {
        return None;
    }

    Some((bitrate * 1000, sample_rate, 16)) // MP3 decodes to 16-bit
}

fn probe_mp3(path: &Path) -> Option<(u32, u32, u32, f64)> {
    let data = std::fs::read(path).ok()?;
    let file_len = data.len() as u64;

    let sync_offset = find_mp3_sync(&data, 0)?;
    let (bitrate_bps, sample_rate, bit_depth) = parse_mp3_frame(&data, sync_offset)?;

    if bitrate_bps == 0 {
        return None;
    }

    // Estimate duration: assume CBR. file_size * 8 / bitrate
    let duration = (file_len as f64 * 8.0) / (bitrate_bps as f64);

    Some((sample_rate, bit_depth, 2, duration))
}

// ── Scanning ────────────────────────────────────────────────────────────

pub fn scan_directory(dir_path: &str) -> Result<Vec<LocalTrack>, String> {
    let mut tracks = Vec::new();
    let scan_root = Path::new(dir_path);

    if !scan_root.is_dir() {
        return Err(format!("Not a directory: {}", dir_path));
    }

    for entry in WalkDir::new(dir_path)
        .follow_links(true)
        .sort_by_file_name()
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() || !is_supported_file(path) {
            continue;
        }

        let track = probe_file(path);
        tracks.push(track);
    }

    log::info!(
        "[local_music] Scanned {} — found {} tracks",
        dir_path,
        tracks.len()
    );

    Ok(tracks)
}

pub fn count_files(dir_path: &str) -> usize {
    WalkDir::new(dir_path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|entry| entry.path().is_file() && is_supported_file(entry.path()))
        .count()
}

pub fn scan_directory_with_progress<F>(
    dir_path: &str,
    on_progress: F,
) -> Result<Vec<LocalTrack>, String>
where
    F: Fn(usize, &str),
{
    let scan_root = Path::new(dir_path);

    if !scan_root.is_dir() {
        return Err(format!("Not a directory: {}", dir_path));
    }

    let entries: Vec<_> = WalkDir::new(dir_path)
        .follow_links(true)
        .sort_by_file_name()
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|entry| entry.path().is_file() && is_supported_file(entry.path()))
        .collect();

    let mut tracks = Vec::with_capacity(entries.len());

    for (i, entry) in entries.iter().enumerate() {
        let path = entry.path();
        let track = probe_file(path);
        on_progress(i + 1, &track.file_path);
        tracks.push(track);
    }

    log::info!(
        "[local_music] Scanned {} — found {} tracks",
        dir_path,
        tracks.len()
    );

    Ok(tracks)
}

fn probe_file(path: &Path) -> LocalTrack {
    let path_str = path.to_string_lossy().to_string();
    let id = compute_file_id(&path_str);

    let mut title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string();

    let mut artist: Option<String> = None;
    let mut album: Option<String> = None;
    let mut duration: f64 = 0.0;
    let mut track_number: Option<u32> = None;
    let mut bit_depth: Option<u32> = None;
    let mut sample_rate: Option<u32> = None;
    let codec = get_codec(path);

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "flac" => {
            if let Ok(data) = std::fs::read(path) {
                if let Some(info) = parse_flac_streaminfo(&data) {
                    sample_rate = Some(info.sample_rate);
                    bit_depth = Some(info.bits_per_sample);
                    if info.sample_rate > 0 {
                        duration = info.total_samples as f64 / info.sample_rate as f64;
                    }
                }
                let (tag_title, tag_artist, tag_album, tag_track) = read_flac_tags(&data);
                if let Some(t) = tag_title {
                    title = t;
                }
                artist = tag_artist;
                album = tag_album;
                track_number = tag_track;
            }
        }
        "mp3" => {
            if let Some((sr, bd, _ch, dur)) = probe_mp3(path) {
                sample_rate = Some(sr);
                bit_depth = Some(bd);
                duration = dur;
            }
            if let Ok(data) = std::fs::read(path) {
                if let Ok(tag) = id3::Tag::read_from2(Cursor::new(&data[..])) {
                    if let Some(t) = tag.title() {
                        title = t.to_string();
                    }
                    if let Some(a) = tag.artist() {
                        artist = Some(a.to_string());
                    }
                    if let Some(a) = tag.album() {
                        album = Some(a.to_string());
                    }
                    if let Some(tn) = tag.track() {
                        track_number = Some(tn);
                    }
                }
            }
        }
        _ => {}
    }

    LocalTrack {
        id,
        file_path: path_str,
        title,
        artist,
        album,
        duration,
        track_number,
        bit_depth,
        sample_rate,
        codec,
        cover_art_mime: None,
        cover_art_base64: None,
    }
}

// ── Cache persistence ──────────────────────────────────────────────────

pub fn cached_to_locals(cached: &[CachedTrack]) -> Vec<LocalTrack> {
    cached.iter().map(|c| c.to_local()).collect()
}

fn file_mtime(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

pub fn delta_scan<F>(
    watched_folders: &[String],
    previous_cache: &[CachedTrack],
    on_progress: F,
) -> (Vec<CachedTrack>, Vec<LocalTrack>, Vec<u64>)
where
    F: Fn(usize, &str),
{
    let cache_map: HashMap<&str, &CachedTrack> = previous_cache
        .iter()
        .map(|c| (c.file_path.as_str(), c))
        .collect();

    let mut new_cache: Vec<CachedTrack> = Vec::new();
    let mut added: Vec<LocalTrack> = Vec::new();
    let mut removed_ids: Vec<u64> = Vec::new();

    // Collect all current file paths and their mtimes
    let mut current_files: Vec<(std::path::PathBuf, u64)> = Vec::new();
    for folder in watched_folders {
        for entry in WalkDir::new(folder)
            .follow_links(true)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if !path.is_file() || !is_supported_file(path) {
                continue;
            }
            if let Some(mtime) = file_mtime(path) {
                current_files.push((path.to_path_buf(), mtime));
            }
        }
    }

    // Mark removed: in cache but not in current filesystem
    let current_set: std::collections::HashMap<String, u64> = current_files
        .iter()
        .map(|(p, m)| {
            let canonical = std::fs::canonicalize(p)
                .unwrap_or_else(|_| p.clone());
            (canonical.to_string_lossy().to_string(), *m)
        })
        .collect();

    for cached in previous_cache {
        let canonical =
            std::fs::canonicalize(&cached.file_path).unwrap_or_else(|_| {
                Path::new(&cached.file_path).to_path_buf()
            });
        let key = canonical.to_string_lossy().to_string();
        if !current_set.contains_key(&key) {
            removed_ids.push(cached.id);
        }
    }

    // Process current files
    let mut idx = 0;
    for (path, mtime) in &current_files {
        idx += 1;
        let path_str = path.to_string_lossy().to_string();

        // Check if file exists in cache with same mtime
        if let Some(cached) = cache_map.get(path_str.as_str()) {
            if cached.mtime_secs == *mtime {
                new_cache.push((*cached).clone());
                on_progress(idx, &path_str);
                continue;
            }
        }

        // New or modified: probe the file
        let track = probe_file(path);
        let cached = CachedTrack::from_local(&track, *mtime);
        added.push(track);
        new_cache.push(cached);
        on_progress(idx, &path_str);
    }

    (new_cache, added, removed_ids)
}

// ── Cover art ───────────────────────────────────────────────────────────

pub fn read_cover_art(path: &str) -> Result<Option<String>, String> {
    let file_path = Path::new(path);
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "mp3" => extract_mp3_cover(path),
        "flac" => extract_flac_cover(path),
        _ => Ok(None),
    }
}

fn extract_mp3_cover(path: &str) -> Result<Option<String>, String> {
    let data =
        std::fs::read(path).map_err(|e| format!("Failed to read file: {e}"))?;
    let tag = id3::Tag::read_from2(Cursor::new(&data[..]));

    let tag = match tag {
        Ok(t) => t,
        Err(_) => return Ok(None),
    };

    for picture in tag.pictures() {
        let mime = picture.mime_type.clone();
        let base64_data = base64::engine::general_purpose::STANDARD.encode(&picture.data);
        return Ok(Some(format!("data:{};base64,{}", mime, base64_data)));
    }

    Ok(None)
}

fn extract_flac_cover(path: &str) -> Result<Option<String>, String> {
    let data =
        std::fs::read(path).map_err(|e| format!("Failed to read file: {e}"))?;
    if data.len() < 42 || &data[0..4] != b"fLaC" {
        return Ok(None);
    }

    let mut offset = 4;
    let mut last_block = false;

    while !last_block && offset + 4 <= data.len() {
        let header = u32::from_be_bytes([
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
        ]);
        last_block = (header & 0x8000_0000) != 0;
        let block_type = ((header >> 24) & 0x7F) as u8;
        let block_len = (header & 0x00FF_FFFF) as usize;
        offset += 4;

        if offset + block_len > data.len() {
            break;
        }

        if block_type == 6 {
            if let Some(result) = parse_flac_picture(&data[offset..offset + block_len]) {
                return Ok(Some(result));
            }
        }

        offset += block_len;
    }

    Ok(None)
}

fn parse_flac_picture(block_data: &[u8]) -> Option<String> {
    if block_data.len() < 32 {
        return None;
    }

    let mime_len = u32::from_be_bytes([
        block_data[4],
        block_data[5],
        block_data[6],
        block_data[7],
    ]) as usize;
    let mime_start = 8;
    if mime_start + mime_len > block_data.len() {
        return None;
    }
    let mime =
        String::from_utf8_lossy(&block_data[mime_start..mime_start + mime_len]).to_string();

    let desc_base = mime_start + mime_len;
    if desc_base + 4 > block_data.len() {
        return None;
    }
    let desc_len = u32::from_be_bytes([
        block_data[desc_base],
        block_data[desc_base + 1],
        block_data[desc_base + 2],
        block_data[desc_base + 3],
    ]) as usize;

    let pic_data_start = desc_base + 4 + desc_len + 4 + 4 + 4 + 4;
    if pic_data_start > block_data.len() {
        return None;
    }

    if pic_data_start + 4 > block_data.len() {
        return None;
    }
    let pic_len = u32::from_be_bytes([
        block_data[pic_data_start],
        block_data[pic_data_start + 1],
        block_data[pic_data_start + 2],
        block_data[pic_data_start + 3],
    ]) as usize;
    let pic_data_offset = pic_data_start + 4;

    if pic_data_offset + pic_len > block_data.len() {
        return None;
    }

    let pic_data = &block_data[pic_data_offset..pic_data_offset + pic_len];
    let base64_data = base64::engine::general_purpose::STANDARD.encode(pic_data);
    Some(format!("data:{};base64,{}", mime, base64_data))
}
