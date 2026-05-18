use serde::Serialize;

use crate::tidal_api::{TidalAlbumDetail, TidalArtist, TidalArtistDetail, TidalPlaylist, TidalTrack};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SanitizedTrack {
    pub id: u64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_seconds: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SanitizedAlbum {
    pub id: u64,
    pub title: String,
    pub artist: String,
    pub track_count: u32,
    pub release_year: Option<u16>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SanitizedArtist {
    pub id: u64,
    pub name: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SanitizedPlaylist {
    pub uuid: String,
    pub title: String,
    pub track_count: u32,
}

impl SanitizedTrack {
    pub fn from_tidal(t: &TidalTrack) -> Self {
        Self {
            id: t.id,
            title: t.title.clone(),
            artist: t.artist.as_ref().map(|a| a.name.clone()).unwrap_or_default(),
            album: t.album.as_ref().map(|a| a.title.clone()).unwrap_or_default(),
            duration_seconds: t.duration,
        }
    }
}

impl SanitizedAlbum {
    pub fn from_tidal(a: &TidalAlbumDetail) -> Self {
        let artist = a
            .artist
            .as_ref()
            .map(|x| x.name.clone())
            .or_else(|| {
                a.artists
                    .as_ref()
                    .and_then(|v| v.first())
                    .map(|x| x.name.clone())
            })
            .unwrap_or_default();
        let release_year = a.release_date.as_ref().and_then(|d| {
            d.split('-').next().and_then(|y| y.parse::<u16>().ok())
        });
        Self {
            id: a.id,
            title: a.title.clone(),
            artist,
            track_count: a.number_of_tracks.unwrap_or(0),
            release_year,
        }
    }
}

impl SanitizedArtist {
    pub fn from_tidal(a: &TidalArtist) -> Self {
        Self { id: a.id, name: a.name.clone() }
    }

    pub fn from_tidal_detail(a: &TidalArtistDetail) -> Self {
        Self { id: a.id, name: a.name.clone() }
    }
}

impl SanitizedPlaylist {
    pub fn from_tidal(p: &TidalPlaylist) -> Self {
        Self {
            uuid: p.uuid.clone(),
            title: p.title.clone(),
            track_count: p.number_of_tracks.unwrap_or(0),
        }
    }
}

pub fn backfill_and_sanitize_tracks(mut tracks: Vec<TidalTrack>) -> Vec<SanitizedTrack> {
    for t in &mut tracks {
        t.backfill_artist();
    }
    tracks.iter().map(SanitizedTrack::from_tidal).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tidal_api::{TidalAlbum, TidalArtist, TidalTrack};

    fn make_track(artist: Option<TidalArtist>) -> TidalTrack {
        TidalTrack {
            id: 42,
            title: "Test Title".to_string(),
            duration: 180,
            version: None,
            artist,
            artists: None,
            album: Some(TidalAlbum {
                id: 99,
                title: "Test Album".to_string(),
                cover: None,
                vibrant_color: None,
                video_cover: None,
                release_date: None,
            }),
            audio_quality: None,
            track_number: None,
            volume_number: None,
            date_added: None,
            isrc: None,
            explicit: None,
            popularity: None,
            replay_gain: None,
            peak: None,
            copyright: None,
            url: None,
            stream_ready: None,
            allow_streaming: None,
            premium_streaming_only: None,
            stream_start_date: None,
            audio_modes: None,
            media_metadata: None,
            mixes: None,
        }
    }

    #[test]
    fn sanitized_track_keeps_only_public_fields() {
        let artist = TidalArtist {
            id: 7,
            name: "Test Artist".to_string(),
            picture: None,
            artist_type: None,
            handle: None,
        };
        let t = make_track(Some(artist));
        let s = SanitizedTrack::from_tidal(&t);
        assert_eq!(s.id, 42);
        assert_eq!(s.title, "Test Title");
        assert_eq!(s.artist, "Test Artist");
        assert_eq!(s.album, "Test Album");
        assert_eq!(s.duration_seconds, 180);
    }

    #[test]
    fn missing_artist_yields_empty_string_not_panic() {
        let t = make_track(None);
        let s = SanitizedTrack::from_tidal(&t);
        assert_eq!(s.artist, "");
    }
}
