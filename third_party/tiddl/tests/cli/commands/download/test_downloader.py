import asyncio
from pathlib import Path

import pytest

from tiddl.cli.commands.download.downloader import Downloader
from tiddl.core.api.models import Track, TrackStream


class Output:
    def item_started(self, **_):
        return None

    def item_progress(self, *_args, **_kwargs):
        return None


class Api:
    def get_track_stream(self, **_):
        return TrackStream(
            trackId=1,
            assetPresentation="FULL",
            audioMode="STEREO",
            audioQuality="LOSSLESS",
            manifestMimeType="application/vnd.tidal.bts",
            manifestHash="manifest-hash",
            manifest="unused",
        )


def test_interrupted_download_removes_only_its_temporary_file(tmp_path: Path, monkeypatch):
    downloader = Downloader(
        tidal_api=Api(),
        threads_count=1,
        output=Output(),
        track_quality="max",
        video_quality="fhd",
        videos_filter="none",
        skip_existing=True,
        download_path=tmp_path,
        scan_path=tmp_path,
    )
    track = Track.model_construct(
        id=1,
        title="Song",
        allowStreaming=True,
        audioQuality="LOSSLESS",
        album=Track.Album.model_construct(vibrantColor=None),
    )

    async def interrupted_total(*_):
        raise KeyboardInterrupt

    monkeypatch.setattr("tiddl.cli.commands.download.downloader.parse_track_stream", lambda _: (["https://media.invalid/track"], ".flac"))
    monkeypatch.setattr(downloader, "get_total_bytes", interrupted_total)

    with pytest.raises(KeyboardInterrupt):
        asyncio.run(downloader.download(track, Path("song.flac"), "item-1"))

    assert not list(tmp_path.glob(".song.flac.tiddl-part-*"))
    assert not (tmp_path / "song.flac").exists()
