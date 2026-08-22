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
