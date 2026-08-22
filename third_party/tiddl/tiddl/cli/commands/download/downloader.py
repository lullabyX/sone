import asyncio
import shutil
from dataclasses import dataclass
from logging import getLogger
from pathlib import Path
from tempfile import NamedTemporaryFile

import aiofiles
import aiohttp

from tiddl.cli.config import VIDEOS_FILTER_LITERAL, ATMOS_FILTER_LITERAL
from tiddl.cli.utils.download import get_existing_track_filename
from tiddl.cli.utils.path import resolve_existing_path_case
from tiddl.core.api import ApiError, TidalAPI
from tiddl.core.api.models import StreamVideoQuality, Track, TrackQuality, Video
from tiddl.core.utils import parse_track_stream, parse_video_stream
from tiddl.core.utils.const import (
    TRACK_QUALITY_LITERAL,
    VIDEO_QUALITY_LITERAL,
    track_qualities,
    video_qualities,
)

from .output import DownloadEventSink

log = getLogger(__name__)

CHUNK_SIZE = 1024**2


@dataclass
class DownloadResult:
    path: Path | None
    was_downloaded: bool
    status: str
    stream: object | None = None

track_qualities_color: dict[TrackQuality, str] = {
    "LOW": "[gray]96 kbps",
    "HIGH": "[gray]320 kbps",
    "LOSSLESS": "[cyan]",
    "HI_RES_LOSSLESS": "[yellow]",
}

video_qualities_color: dict[StreamVideoQuality, str] = {
    "LOW": "[gray]360p",
    "MEDIUM": "[cyan]720p",
    "HIGH": "[yellow]1080p",
}


class Downloader:
    api: TidalAPI
    output: DownloadEventSink
    semaphore: asyncio.Semaphore
    track_quality: TrackQuality
    video_quality: StreamVideoQuality
    videos_filter: VIDEOS_FILTER_LITERAL
    skip_existing: bool
    download_path: Path
    scan_path: Path
    match_existing_path_case: bool
    dolby_atmos_filter: ATMOS_FILTER_LITERAL

    def __init__(
        self,
        tidal_api: TidalAPI,
        threads_count: int,
        output: DownloadEventSink,
        track_quality: TRACK_QUALITY_LITERAL,
        video_quality: VIDEO_QUALITY_LITERAL,
        videos_filter: VIDEOS_FILTER_LITERAL,
        skip_existing: bool,
        download_path: Path,
        scan_path: Path,
        match_existing_path_case: bool = False,
        dolby_atmos_filter: ATMOS_FILTER_LITERAL = "none",
    ) -> None:
        self.api = tidal_api
        self.output = output
        self.semaphore = asyncio.Semaphore(threads_count)
        self.track_quality = track_qualities[track_quality]
        self.video_quality = video_qualities[video_quality]
        self.videos_filter = videos_filter
        self.skip_existing = skip_existing
        self.download_path = download_path
        self.scan_path = scan_path
        self.match_existing_path_case = match_existing_path_case
        self.dolby_atmos_filter = dolby_atmos_filter

    def get_path(self, base_path: Path, relative_path: Path) -> Path:
        if self.match_existing_path_case:
            return resolve_existing_path_case(base_path, relative_path)

        return base_path / relative_path

    async def get_total_bytes(
        self, session: aiohttp.ClientSession, urls: list[str]
    ) -> int | None:
        """Return a total only when every stream segment reports its size."""

        semaphore = asyncio.Semaphore(8)

        async def content_length(url: str) -> int | None:
            try:
                async with semaphore:
                    async with session.head(url, allow_redirects=True) as response:
                        response.raise_for_status()
                        return response.content_length
            except aiohttp.ClientError:
                return None

        lengths = await asyncio.gather(*(content_length(url) for url in urls))
        if any(length is None for length in lengths):
            return None
        return sum(lengths)

    async def download(
        self, item: Track | Video, file_path: Path, item_instance_id: str
    ) -> DownloadResult:
        """
        returns
        - Path `item_path` path of existing/downloaded item
        - bool `was_downloaded`
        """

        if not item.allowStreaming:
            self.output.item_skipped(
                item_id=str(item.id), item_type="track" if isinstance(item, Track) else "video",
                item_instance_id=item_instance_id, title=item.title, reason="not_streamable", output_path=None,
            )
            return DownloadResult(None, False, "skipped")

        if isinstance(item, Track):
            filename = get_existing_track_filename(
                item.audioQuality, self.track_quality, file_path
            )
            existing_file_path = self.get_path(self.scan_path, filename)
            vibrant_color = item.album.vibrantColor

        elif isinstance(item, Video):
            filename = file_path.with_suffix(".ts")
            existing_file_path = self.get_path(self.scan_path, filename)
            vibrant_color = item.vibrantColor

        vibrant_color = vibrant_color or "gray"

        log.debug(f"{file_path=}, {filename=}, {existing_file_path=}")

        if existing_file_path.exists():
            if self.skip_existing:
                self.output.item_skipped(
                    item_id=str(item.id), item_type="track" if isinstance(item, Track) else "video",
                    item_instance_id=item_instance_id, title=item.title, reason="already_exists",
                    output_path=existing_file_path,
                )
                return DownloadResult(existing_file_path, False, "skipped")

        elif (isinstance(item, Video) and self.videos_filter == "none") or (
            isinstance(item, Track) and self.videos_filter == "only"
        ):
            log.debug(f"skipping {item.id} due to {self.videos_filter=}")
            self.output.item_skipped(
                item_id=str(item.id), item_type="track" if isinstance(item, Track) else "video",
                item_instance_id=item_instance_id, title=item.title, reason="video_filter", output_path=None,
            )
            return DownloadResult(None, False, "skipped")

        async with self.semaphore:
            if isinstance(item, Track):
                try:
                    stream = self.api.get_track_stream(
                        track_id=item.id, quality=self.track_quality
                    )

                    log.debug(
                        f"{stream.trackId=}, {stream.audioQuality=}, {stream.audioMode=}"
                    )

                    if (
                        self.dolby_atmos_filter == "none"
                        and stream.audioMode == "DOLBY_ATMOS"
                    ) or (
                        self.dolby_atmos_filter == "only"
                        and stream.audioMode == "STEREO"
                    ):
                        self.output.item_skipped(
                            item_id=str(item.id), item_type="track", item_instance_id=item_instance_id,
                            title=item.title, reason="dolby_atmos_filter", output_path=None,
                        )
                        return DownloadResult(None, False, "skipped")

                except ApiError as e:
                    log.error(f"{item.id=} {e=}")
                    self.output.item_failed(
                        item_id=str(item.id), item_type="track", item_instance_id=item_instance_id,
                        title=item.title, stage="stream", error={"code": "api_error", "message": e.user_message},
                    )
                    return DownloadResult(None, False, "failed")

                urls, extension = parse_track_stream(stream)
                # Preserve TIDAL's original container and encoded bytes. In
                # particular, Hi-Res streams may be FLAC in an MP4 container.
                download_path = self.get_path(self.download_path, filename).with_suffix(extension)

                quality_string = track_qualities_color[stream.audioQuality]

                if (
                    stream.audioQuality in ["HI_RES_LOSSLESS", "LOSSLESS"]
                    and stream.audioMode == "STEREO"
                ):
                    quality_string = f"{quality_string} {stream.bitDepth}-bit, {(stream.sampleRate or 0) / 1000:.1f} kHz"
                elif stream.audioMode == "DOLBY_ATMOS":
                    quality_string = "[blue]Dolby Atmos[/]"

            elif isinstance(item, Video):
                stream = self.api.get_video_stream(
                    video_id=item.id, quality=self.video_quality
                )

                urls, ext = parse_video_stream(stream), ".ts"
                download_path = self.get_path(self.download_path, filename).with_suffix(
                    ext
                )
                quality_string = video_qualities_color[stream.videoQuality]

            item_type = "track" if isinstance(item, Track) else "video"
            task_id = self.output.item_started(
                item_id=str(item.id), item_type=item_type, item_instance_id=item_instance_id,
                title=item.title, output_path=str(download_path),
                requested_quality=str(self.track_quality if isinstance(item, Track) else self.video_quality),
                description=f"[{vibrant_color}]{item.title} {quality_string}",
            )
            bytes_downloaded = 0

            download_path.parent.mkdir(exist_ok=True, parents=True)

            # TODO shouldnt session be reused instead of
            # creating new one on every download?

            temp_path: str | None = None
            try:
                with NamedTemporaryFile(
                    "wb", delete=False, dir=download_path.parent,
                    prefix=f".{download_path.name}.tiddl-part-",
                ) as tmp:
                    temp_path = tmp.name
                    async with aiohttp.ClientSession(trust_env=True) as session:
                        bytes_total = await self.get_total_bytes(session, urls)
                        progress = 0 if bytes_total else None
                        self.output.item_progress(task_id, item_id=str(item.id), item_type=item_type,
                            item_instance_id=item_instance_id, bytes_downloaded=0,
                            bytes_total=bytes_total, progress=progress, bytes_delta=0, final=True)
                        try:
                            async with aiofiles.open(tmp.name, "wb") as f:
                                for url in urls:
                                    async with session.get(url) as resp:
                                        resp.raise_for_status()
                                        async for chunk in resp.content.iter_chunked(CHUNK_SIZE):
                                            await f.write(chunk)
                                            bytes_downloaded += len(chunk)
                                            progress = bytes_downloaded / bytes_total if bytes_total else None
                                            self.output.item_progress(task_id, item_id=str(item.id), item_type=item_type,
                                                item_instance_id=item_instance_id, bytes_downloaded=bytes_downloaded,
                                                bytes_total=bytes_total, progress=progress,
                                                bytes_delta=len(chunk))
                        except (aiohttp.ClientError, OSError) as exc:
                            self.output.item_failed(item_id=str(item.id), item_type=item_type,
                                item_instance_id=item_instance_id, title=item.title, stage="download",
                                error={"code": "network_error", "message": "Network download failed"})
                            return DownloadResult(None, False, "failed")

                shutil.move(tmp.name, download_path)
                temp_path = None
            finally:
                # Sone cancels tiddl's process group. Only remove the temporary
                # file created for this item; never touch user media files.
                if temp_path:
                    Path(temp_path).unlink(missing_ok=True)

            try:
                download_path.chmod(0o644)
            except OSError:
                pass

            self.output.item_progress(task_id, item_id=str(item.id), item_type=item_type,
                item_instance_id=item_instance_id, bytes_downloaded=bytes_downloaded, bytes_total=bytes_total,
                progress=1 if bytes_total else None, bytes_delta=0, final=True)
            self.output.transfer_finished(task_id)

            return DownloadResult(download_path, True, "downloaded", stream)
