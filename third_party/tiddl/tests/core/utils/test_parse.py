from base64 import b64encode
from json import dumps

from tiddl.core.api.models import TrackStream, VideoStream
from tiddl.core.utils import parse


def encoded_manifest(manifest: str | dict) -> str:
    if isinstance(manifest, dict):
        manifest = dumps(manifest)
    return b64encode(manifest.encode()).decode()


def track_stream(manifest: str | dict, mime_type: str, quality: str = "LOSSLESS") -> TrackStream:
    return TrackStream(
        trackId=1,
        assetPresentation="FULL",
        audioMode="STEREO",
        audioQuality=quality,
        manifestMimeType=mime_type,
        manifestHash="manifest-hash",
        manifest=encoded_manifest(manifest),
    )


def test_parses_bts_track_manifest():
    stream = track_stream(
        {
            "mimeType": "audio/flac",
            "codecs": "flac",
            "encryptionType": "NONE",
            "urls": ["https://media.invalid/track"],
        },
        "application/vnd.tidal.bts",
    )

    assert parse.parse_track_stream(stream) == (["https://media.invalid/track"], ".flac")


def test_parses_direct_hi_res_flac_track_manifest():
    stream = track_stream(
        {
            "mimeType": "audio/flac",
            "codecs": "flac",
            "encryptionType": "NONE",
            "urls": ["https://media.invalid/track"],
        },
        "application/vnd.tidal.bts",
        "HI_RES_LOSSLESS",
    )

    assert parse.parse_track_stream(stream) == (["https://media.invalid/track"], ".flac")


def test_parses_dash_flac_track_manifest_as_m4a_container():
    stream = track_stream(
        """<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet><Representation codecs="flac"><SegmentTemplate initialization="https://media.invalid/init.mp4" startNumber="1" media="https://media.invalid/$Number$.m4s"><SegmentTimeline><S d="1" /></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>""",
        "application/dash+xml",
        "HI_RES_LOSSLESS",
    )

    assert parse.parse_track_stream(stream) == (
        ["https://media.invalid/init.mp4", "https://media.invalid/1.m4s"],
        ".m4a",
    )


def test_parses_lossless_dash_representation_after_aac_fallback():
    stream = track_stream(
        """<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet><Representation codecs="mp4a.40.2"><SegmentTemplate initialization="https://media.invalid/aac-init.mp4" media="https://media.invalid/aac-$Number$.m4s"><SegmentTimeline><S d="1" /></SegmentTimeline></SegmentTemplate></Representation><Representation codecs="flac"><SegmentTemplate initialization="https://media.invalid/flac-init.mp4" media="https://media.invalid/flac-$Number$.m4s"><SegmentTimeline><S d="1" /></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>""",
        "application/dash+xml",
        "HI_RES_LOSSLESS",
    )

    assert parse.parse_track_stream(stream) == (
        ["https://media.invalid/flac-init.mp4", "https://media.invalid/flac-1.m4s"],
        ".m4a",
    )


def test_parses_dash_track_manifest_with_the_declared_segment_numbers():
    stream = track_stream(
        """<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet><Representation codecs="mp4a.40.2"><SegmentTemplate initialization="https://media.invalid/init.mp4" startNumber="7" media="https://media.invalid/$Number$.m4s"><SegmentTimeline><S d="1" r="1" /></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>""",
        "application/dash+xml",
        "HI_RES_LOSSLESS",
    )

    assert parse.parse_track_stream(stream) == (
        [
            "https://media.invalid/init.mp4",
            "https://media.invalid/7.m4s",
            "https://media.invalid/8.m4s",
        ],
        ".m4a",
    )


def test_parses_hls_video_manifest(monkeypatch):
    master_url = "https://media.invalid/master.m3u8"
    variant_url = "https://media.invalid/high.m3u8"
    stream = VideoStream(
        videoId=1,
        streamType="ON_DEMAND",
        assetPresentation="FULL",
        videoQuality="HIGH",
        manifestMimeType="application/vnd.tidal.emu",
        manifestHash="manifest-hash",
        manifest=encoded_manifest({"mimeType": "application/vnd.apple.mpegurl", "urls": [master_url]}),
    )

    class Response:
        def __init__(self, text: str):
            self.text = text

    class Session:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

        def get(self, url: str) -> Response:
            return Response({
                master_url: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://media.invalid/low.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nhttps://media.invalid/high.m3u8\n",
                variant_url: "#EXTM3U\n#EXTINF:1,\nhttps://media.invalid/first.ts\n#EXTINF:1,\nhttps://media.invalid/second.ts\n",
            }[url])

    monkeypatch.setattr(parse, "Session", Session)

    assert parse.parse_video_stream(stream) == [
        "https://media.invalid/first.ts",
        "https://media.invalid/second.ts",
    ]
