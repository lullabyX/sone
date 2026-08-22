import subprocess
from pathlib import Path


class FFmpegError(RuntimeError):
    pass


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    """Run a process; raise `FFmpegError` on non-zero exit with stderr."""
    # Force UTF-8 encoding to prevent UnicodeDecodeError on Windows
    r = subprocess.run(
        cmd, 
        capture_output=True, 
        text=True, 
        encoding="utf-8", 
        errors="replace",  # Added as a safety net
        # The Sone credential socket is inherited only by this process.
        close_fds=True,
    )
    if r.returncode != 0:
        raise FFmpegError(
            f"{cmd[0]} failed (rc={r.returncode}): {r.stderr.strip()}"
        )
    return r


def is_ffmpeg_installed() -> bool:
    """Checks if `ffmpeg` is installed."""

    try:
        run(["ffmpeg", "-version"])
        return True
    except (FileNotFoundError, FFmpegError):
        return False


def _probe_audio_codec(source: Path) -> str:
    """Return first audio stream's codec_name, or "" if ffprobe is unavailable."""
    try:
        r = run([
            "ffprobe", "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=codec_name",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(source),
        ])
        return r.stdout.strip()
    except (FileNotFoundError, FFmpegError):
        return ""


def convert_to_mp4(source: Path) -> Path:
    output_path = source.with_suffix(".mp4")
    temporary_path = source.with_suffix(".tiddl-part.mp4")

    try:
        run(["ffmpeg", "-y", "-i", str(source), "-c", "copy", str(temporary_path)])
        temporary_path.replace(output_path)
        source.unlink()
        return output_path
    finally:
        temporary_path.unlink(missing_ok=True)


def extract_flac(source: Path) -> Path:
    """
    Extract FLAC audio from an MP4 container.

    Tidal can serve AAC-in-MP4 for tracks without a lossless master, so the
    input may not actually contain FLAC.
    """

    codec = _probe_audio_codec(source)
    if codec and codec != "flac":
        target = source.with_suffix(".m4a")
        if target != source:
            source.replace(target)
        return target

    target = source.with_suffix(".flac")
    temporary_path = source.with_suffix(".tiddl-part.flac")

    try:
        run(["ffmpeg", "-y", "-i", str(source), "-c", "copy", str(temporary_path)])
        temporary_path.replace(target)
        if source != target and source.exists():
            source.unlink()
        return target
    finally:
        temporary_path.unlink(missing_ok=True)
