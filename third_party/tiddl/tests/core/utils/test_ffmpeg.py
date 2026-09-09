from pathlib import Path

import pytest

from tiddl.core.utils import ffmpeg


def test_convert_to_mp4_removes_partial_output_when_interrupted(tmp_path: Path, monkeypatch):
    source = tmp_path / "video.ts"
    source.write_bytes(b"source")
    partial = source.with_suffix(".tiddl-part.mp4")

    def interrupted(command: list[str]):
        Path(command[-1]).write_bytes(b"partial")
        raise KeyboardInterrupt

    monkeypatch.setattr(ffmpeg, "run", interrupted)

    with pytest.raises(KeyboardInterrupt):
        ffmpeg.convert_to_mp4(source)

    assert source.exists()
    assert not partial.exists()


def test_extract_flac_preserves_aac_as_m4a(tmp_path: Path, monkeypatch):
    source = tmp_path / "track.m4a"
    source.write_bytes(b"source")

    monkeypatch.setattr(ffmpeg, "_probe_audio_codec", lambda _: "aac")

    assert ffmpeg.extract_flac(source) == source
    assert source.exists()
    assert not (tmp_path / "track.flac").exists()


def test_extract_flac_remuxes_flac_to_flac(tmp_path: Path, monkeypatch):
    source = tmp_path / "track.m4a"
    source.write_bytes(b"source")

    monkeypatch.setattr(ffmpeg, "_probe_audio_codec", lambda _: "flac")

    def remux(command: list[str]):
        Path(command[-1]).write_bytes(b"flac")

    monkeypatch.setattr(ffmpeg, "run", remux)

    target = ffmpeg.extract_flac(source)

    assert target == tmp_path / "track.flac"
    assert target.read_bytes() == b"flac"
    assert not source.exists()
