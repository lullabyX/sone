import os
import sys
import typer
import asyncio
from contextlib import nullcontext
from uuid import uuid4

from pathlib import Path
from logging import getLogger
from rich.live import Live

from typing_extensions import Annotated

from tiddl.core.metadata import add_track_metadata, add_video_metadata, Cover
from tiddl.core.api import ApiError
from tiddl.core.api.models import Album, Track, Video, AlbumItemsCredits
from tiddl.core.utils.format import format_template
from tiddl.core.utils.m3u import save_tracks_to_m3u
from tiddl.cli.config import (
    CONFIG,
    TRACK_QUALITY_LITERAL,
    VIDEO_QUALITY_LITERAL,
    ARTIST_SINGLES_FILTER_LITERAL,
    VALID_M3U_RESOURCE_LITERAL,
    VIDEOS_FILTER_LITERAL,
    ATMOS_FILTER_LITERAL,
)
from tiddl.cli.utils.resource import TidalResource
from tiddl.cli.ctx import Context
from tiddl.cli.commands.auth import refresh
from tiddl.cli.commands.subcommands import register_subcommands


from .downloader import Downloader
from .output import JsonlOutput, RichOutput

download_command = typer.Typer(name="download")
register_subcommands(download_command)

log = getLogger(__name__)


@download_command.callback(no_args_is_help=True)
def download_callback(
    ctx: Context,
    TRACK_QUALITY: Annotated[
        TRACK_QUALITY_LITERAL,
        typer.Option(
            "--track-quality",
            "-q",
        ),
    ] = CONFIG.download.track_quality,
    VIDEO_QUALITY: Annotated[
        VIDEO_QUALITY_LITERAL,
        typer.Option(
            "--video-quality",
            "-vq",
        ),
    ] = CONFIG.download.video_quality,
    SKIP_EXISTING: Annotated[
        bool,
        typer.Option(
            "--no-skip",
            "-ns",
            help="Don't skip downloading existing files.",
        ),
    ] = not CONFIG.download.skip_existing,
    REWRITE_METADATA: Annotated[
        bool,
        typer.Option(
            "--rewrite-metadata",
            "-r",
            help="Rewrite metadata for already downloaded tracks.",
        ),
    ] = CONFIG.download.rewrite_metadata,
    THREADS_COUNT: Annotated[
        int,
        typer.Option(
            "--threads-count",
            "-t",
            help="Number of concurrent download threads.",
            min=1,
        ),
    ] = CONFIG.download.threads_count,
    DOWNLOAD_PATH: Annotated[
        Path,
        typer.Option(
            "--path",
            "-p",
            help="Base directory path for all downloads.",
        ),
    ] = CONFIG.download.download_path,
    SCAN_PATH: Annotated[
        Path,
        typer.Option(
            "--scan-path",
            "--sp",
            help="Directory to search for your existing downloads.",
        ),
    ] = CONFIG.download.scan_path,
    TEMPLATE: Annotated[
        str,
        typer.Option(
            "--output",
            "-o",
            help="Format output file template.",
        ),
    ] = "",
    SINGLES_FILTER: Annotated[
        ARTIST_SINGLES_FILTER_LITERAL,
        typer.Option(
            "--singles",
            "-s",
            help="Filter for including artists' singles, used while downloading artist.",
        ),
    ] = CONFIG.download.singles_filter,
    VIDEOS_FILTER: Annotated[
        VIDEOS_FILTER_LITERAL,
        typer.Option(
            "--videos",
            "-vid",
            help="Videos handling: 'none' to exclude, 'allow' to include, 'only' to download videos only.",
        ),
    ] = CONFIG.download.videos_filter,
    RAISE_ERRORS: Annotated[
        bool,
        typer.Option(
            "--raise-errors",
            "-err",
            help="Raise an error on resource download failure. Use for debugging",
        ),
    ] = False,
    DOLBY_ATMOS_FILTER: Annotated[
        ATMOS_FILTER_LITERAL,
        typer.Option(
            "--dolby-atmos",
            "-da",
            help="Dolby Atmos filter, 'none' to exclude, 'allow' to include, 'only' to download only Dolby Atmos, if available.",
        ),
    ] = CONFIG.download.atmos_filter,
    EVENTS: Annotated[
        str,
        typer.Option("--events", help="Output mode: human (default) or jsonl."),
    ] = "human",
):
    """
    Download Tidal resources.
    """

    if EVENTS not in {"human", "jsonl"}:
        raise typer.BadParameter("must be 'human' or 'jsonl'", param_hint="--events")

    # Typer invokes this callback for child-command help too. A help request
    # must not authenticate or produce an empty download job.
    if "--help" in sys.argv:
        return

    output = JsonlOutput() if EVENTS == "jsonl" else RichOutput(ctx.obj.console)
    try:
        ctx.invoke(refresh, EARLY_EXPIRE_TIME=600, SILENT=EVENTS == "jsonl")
    except typer.Exit:
        if EVENTS == "jsonl":
            output.job_started(
                resources=[],
                options={
                    "download_path": str(DOWNLOAD_PATH),
                    "track_quality": TRACK_QUALITY,
                    "video_quality": VIDEO_QUALITY,
                    "threads_count": THREADS_COUNT,
                    "skip_existing": not SKIP_EXISTING,
                },
            )
            output.job_failed(
                code="authentication_required",
                message="Run 'tiddl auth login' before downloading.",
            )
            output.job_completed()
            raise typer.Exit(1) from None
        raise

    log.debug(f"{ctx.params=}")

    def write_lrc_file(track: Track, lyrics: str, file_path: Path):
        if not CONFIG.download.write_lrc_file or not lyrics.strip():
            return

        lrc_file_path = file_path.with_suffix(".lrc")

        try:
            with open(lrc_file_path, "w", encoding="utf-8") as f:
                f.write(lyrics)
        except Exception as e:
            log.error(
                f"Failed to write LRC file for track {track.title} (ID: {track.id}): {e}"
            )

    def save_m3u(
        resource_type: VALID_M3U_RESOURCE_LITERAL,
        filename: str,
        tracks_with_path: list[tuple[Path, Track]],
    ):
        if not CONFIG.m3u.save:
            return

        if resource_type not in CONFIG.m3u.allowed:
            return

        tracks_with_existing_paths = [
            (path, track)
            for (path, track) in tracks_with_path
            if path and isinstance(track, Track)
        ]

        log.debug(f"{resource_type=}, {filename=}, {len(tracks_with_existing_paths)=}")

        save_tracks_to_m3u(
            tracks_with_path=tracks_with_existing_paths, path=DOWNLOAD_PATH / filename
        )

    def get_item_quality(item: Track | Video):
        def predict_item_quality() -> TRACK_QUALITY_LITERAL | VIDEO_QUALITY_LITERAL:
            if isinstance(item, Track):
                if TRACK_QUALITY in ["low", "normal"]:
                    return TRACK_QUALITY

                if (
                    TRACK_QUALITY == "max"
                    and "HIRES_LOSSLESS" not in item.mediaMetadata.tags
                ):
                    return "high"

                return TRACK_QUALITY

            elif isinstance(item, Video):
                # TODO add missing Video.quality literals so this function can work properly
                return VIDEO_QUALITY

            raise TypeError("Unsupported item type")

        return predict_item_quality().upper()

    async def download_resources():
        downloader = Downloader(
            tidal_api=ctx.obj.api,
            threads_count=THREADS_COUNT,
            output=output,
            track_quality=TRACK_QUALITY,
            video_quality=VIDEO_QUALITY,
            videos_filter=VIDEOS_FILTER,
            skip_existing=not SKIP_EXISTING,
            download_path=DOWNLOAD_PATH,
            scan_path=SCAN_PATH,
            match_existing_path_case=CONFIG.download.match_existing_path_case,
            dolby_atmos_filter=DOLBY_ATMOS_FILTER,
        )
        output.job_started(
            resources=[{"type": resource.type, "id": resource.id, "url": resource.url} for resource in ctx.obj.resources],
            options={
                "download_path": str(DOWNLOAD_PATH), "track_quality": TRACK_QUALITY,
                "video_quality": VIDEO_QUALITY, "threads_count": THREADS_COUNT,
                "skip_existing": not SKIP_EXISTING,
            },
        )

        def item_type(item: Track | Video) -> str:
            return "track" if isinstance(item, Track) else "video"

        def discovered_item(
            item: Track | Video, resource: TidalResource, item_instance_id: str,
            playlist=None, playlist_index: int | None = None,
        ) -> dict:
            album = getattr(item, "album", None)
            artists = [artist.name for artist in item.artists]
            return {
                "type": item_type(item), "id": str(item.id), "item_instance_id": item_instance_id,
                "title": item.title, "version": getattr(item, "version", None),
                "artist": item.artist.name if item.artist else None, "artists": artists,
                "album": ({"id": str(album.id), "title": album.title, "artist": None} if album else None),
                "track_number": getattr(item, "trackNumber", None),
                "volume_number": getattr(item, "volumeNumber", None),
                "playlist": (
                    {"id": playlist.uuid, "title": playlist.title, "index": playlist_index}
                    if playlist else None
                ),
                "source_resource": {"type": resource.type, "id": resource.id, "url": resource.url},
            }

        class Metadata:
            def __init__(
                self,
                date: str = "",
                artist: str = "",
                credits: list[AlbumItemsCredits.ItemWithCredits.CreditsEntry] = [],
                cover: Cover | None = None,
                album_review: str = "",
            ) -> None:
                self.date = date
                self.artist = artist
                self.credits = credits
                self.cover = cover
                self.album_review = album_review

        async def handle_resource(resource: TidalResource):
            async def handle_item(
                item: Track | Video,
                file_path: str,
                track_metadata: Metadata | None = None,
                playlist=None,
                playlist_index: int | None = None,
            ) -> tuple[Path | None, Track | Video]:
                log.debug(f"{item.id=}, {file_path=}")
                item_instance_id = str(uuid4())
                output.item_discovered(item=discovered_item(item, resource, item_instance_id, playlist, playlist_index))
                output.total_increment()

                if not track_metadata:
                    track_metadata = Metadata()

                try:
                    result = await downloader.download(
                        item=item, file_path=Path(file_path), item_instance_id=item_instance_id
                    )
                except Exception as exc:
                    log.exception("item download failed")
                    output.item_failed(
                        item_id=str(item.id), item_type=item_type(item), item_instance_id=item_instance_id,
                        title=item.title, stage="unknown",
                        error={"code": "unknown_error", "message": "Download failed unexpectedly"},
                    )
                    if RAISE_ERRORS:
                        raise
                    return None, item

                download_path, was_downloaded = result.path, result.was_downloaded

                log.debug(f"{download_path=}, {was_downloaded=}")

                if result.status != "downloaded":
                    return download_path, item

                try:
                    if CONFIG.metadata.enable and download_path:
                        if isinstance(item, Track):
                            lyrics_subtitles = ""

                            if CONFIG.metadata.lyrics or CONFIG.download.write_lrc_file:
                                try:
                                    lyrics_subtitles = ctx.obj.api.get_track_lyrics(
                                        item.id
                                    ).subtitles
                                except Exception as e:
                                    log.error(e)

                            if (
                                not track_metadata.cover
                                and item.album.cover
                                and CONFIG.metadata.cover
                            ):
                                track_metadata.cover = Cover(item.album.cover)

                            if track_metadata.cover and track_metadata.cover.data is None:
                                track_metadata.cover.fetch_data()

                            write_lrc_file(item, lyrics_subtitles, download_path)

                            add_track_metadata(
                                path=download_path,
                                track=item,
                                lyrics=lyrics_subtitles,
                                album_artist=track_metadata.artist,
                                cover_data=(
                                    track_metadata.cover.data
                                    if track_metadata.cover
                                    else None
                                ),
                                date=track_metadata.date,
                                credits_contributors=track_metadata.credits,
                                comment=track_metadata.album_review,
                            )

                        elif isinstance(item, Video):
                            add_video_metadata(path=download_path, video=item)
                except Exception:
                    log.exception("metadata processing failed")
                    output.item_failed(
                        item_id=str(item.id), item_type=item_type(item), item_instance_id=item_instance_id,
                        title=item.title, stage="tagging",
                        error={"code": "filesystem_error", "message": "Could not write media metadata"},
                    )
                    if RAISE_ERRORS:
                        raise
                    return None, item

                if download_path and CONFIG.download.update_mtime:
                    try:
                        os.utime(download_path, None)
                    except Exception:
                        log.warning(f"could not update mtime for {download_path}")

                stream = result.stream
                completed = {
                    "item_id": str(item.id), "item_type": item_type(item),
                    "item_instance_id": item_instance_id, "title": item.title,
                    "output_path": download_path, "description": item.title,
                }
                if isinstance(item, Track) and stream:
                    completed.update({
                        "quality": stream.audioQuality, "audio_mode": stream.audioMode,
                        "bit_depth": stream.bitDepth, "sample_rate": stream.sampleRate,
                    })
                elif isinstance(item, Video) and stream:
                    completed.update({"video_quality": stream.videoQuality})
                output.item_completed(**completed)
                return download_path, item

            async def download_album(album: Album):
                offset = 0
                futures = []

                cover: Cover | None = None
                save_cover = ("album" in CONFIG.cover.allowed) and CONFIG.cover.save

                if album.cover and (CONFIG.metadata.cover or save_cover):
                    cover = Cover(album.cover, size=CONFIG.cover.size)

                album_review = ""

                if CONFIG.metadata.album_review:
                    try:
                        album_review = ctx.obj.api.get_album_review(
                            album_id=resource.id
                        ).normalized_text()
                    except Exception as e:
                        log.error(e)

                while True:
                    album_items = ctx.obj.api.get_album_items_credits(
                        album_id=album.id, offset=offset
                    )

                    for album_item in album_items.items:
                        try:
                            template = TEMPLATE or CONFIG.templates.album
                            file_path = format_template(
                                template=template,
                                item=album_item.item,
                                album=album,
                                quality=get_item_quality(album_item.item),
                            )

                        except AttributeError as exc:
                            log.error(f"{exc=}")
                            output.diagnostic(f"Wrong Album Template: {exc} ({template=}, {album.id=}, {album_item.item.id=})")
                            output.job_failed(
                                code="invalid_output_template",
                                message="The output template could not be applied.",
                            )
                            continue

                        try:
                            futures.append(
                                handle_item(
                                    item=album_item.item,
                                    file_path=file_path,
                                    track_metadata=Metadata(
                                        cover=cover,
                                        date=str(album.releaseDate),
                                        artist=(
                                            album.artist.name if album.artist else ""
                                        ),
                                        credits=album_item.credits,
                                        album_review=album_review,
                                    ),
                                )
                            )
                        except ApiError as e:
                            item = album_item.item
                            track_info = f"Track: {getattr(item, 'title', 'Unknown')} (ID: {item.id})"
                            if hasattr(item, "album") and item.album:
                                track_info += f", Album ID: {item.album.id}"
                            output.diagnostic(f"API Error: {e} ({track_info})")
                            if RAISE_ERRORS:
                                raise
                        except Exception as e:
                            item = album_item.item
                            track_info = f"Track: {getattr(item, 'title', 'Unknown')} (ID: {item.id})"
                            output.diagnostic(f"Error: {e} ({track_info})")
                            if RAISE_ERRORS:
                                raise

                    offset += album_items.limit
                    if offset >= album_items.totalNumberOfItems:
                        break

                tracks_with_path = await asyncio.gather(*futures)

                save_m3u(
                    resource_type="album",
                    filename=format_template(
                        CONFIG.m3u.templates.album,
                        album=album,
                        type="album",
                    ),
                    tracks_with_path=tracks_with_path,
                )

                if save_cover and cover:
                    cover.save_to_directory(
                        path=DOWNLOAD_PATH
                        / format_template(
                            template=CONFIG.cover.templates.album, album=album
                        )
                    )

            # resources should be collected from a distinct function
            # that would yield the resources.
            # then we would be able to reuse the logic in the export command

            match resource.type:

                case "track":
                    track = ctx.obj.api.get_track(resource.id)
                    album = ctx.obj.api.get_album(track.album.id)

                    cover: Cover | None = None
                    save_cover = ("track" in CONFIG.cover.allowed) and CONFIG.cover.save

                    if album.cover and (CONFIG.metadata.cover or save_cover):
                        cover = Cover(album.cover, size=CONFIG.cover.size)

                    await handle_item(
                        item=track,
                        file_path=format_template(
                            template=TEMPLATE or CONFIG.templates.track,
                            item=track,
                            album=album,
                            quality=get_item_quality(track),
                        ),
                        track_metadata=Metadata(
                            cover=cover,
                            date=str(album.releaseDate),
                            artist=album.artist.name if album.artist else "",
                            # credits are missing
                        ),
                    )

                    if (
                        CONFIG.cover.save
                        and ("track" in CONFIG.cover.allowed)
                        and track.album.cover
                    ):
                        Cover(
                            track.album.cover, size=CONFIG.cover.size
                        ).save_to_directory(
                            path=DOWNLOAD_PATH
                            / format_template(
                                CONFIG.cover.templates.track, item=track, album=album
                            )
                        )

                case "video":
                    video = ctx.obj.api.get_video(resource.id)
                    template = TEMPLATE or CONFIG.templates.video

                    if (
                        "{album" in template
                        and video.album
                        and video.album.id is not None
                    ):
                        album = ctx.obj.api.get_album(video.album.id)
                    else:
                        album = None

                    await handle_item(
                        item=video,
                        file_path=format_template(
                            template=template,
                            item=video,
                            album=album,
                            quality=get_item_quality(video),
                        ),
                    )

                case "mix":
                    offset = 0
                    futures = []

                    while True:
                        mix_items = ctx.obj.api.get_mix_items(resource.id, offset=0)

                        for mix_item in mix_items.items:
                            template = TEMPLATE or CONFIG.templates.mix

                            try:
                                if "{album" in template:
                                    album = ctx.obj.api.get_album(
                                        mix_item.item.album.id
                                    )
                                else:
                                    album = None

                                futures.append(
                                    handle_item(
                                        item=mix_item.item,
                                        file_path=format_template(
                                            template=template,
                                            item=mix_item.item,
                                            album=album,
                                            mix_id=resource.id,
                                            quality=get_item_quality(mix_item.item),
                                        ),
                                    )
                                )
                            except ApiError as e:
                                item = mix_item.item
                                track_info = f"Track: {getattr(item, 'title', 'Unknown')} (ID: {item.id})"
                                output.diagnostic(f"API Error: {e} ({track_info})")
                                output.job_failed(
                                    code="api_error",
                                    message="Could not prepare a mix item.",
                                )
                                if RAISE_ERRORS:
                                    raise
                            except Exception as e:
                                item = mix_item.item
                                track_info = f"Track: {getattr(item, 'title', 'Unknown')} (ID: {item.id})"
                                output.diagnostic(f"Error: {e} ({track_info})")
                                output.job_failed(
                                    code="resource_error",
                                    message="Could not prepare a mix item.",
                                )
                                if RAISE_ERRORS:
                                    raise

                        offset += mix_items.limit
                        if offset >= mix_items.totalNumberOfItems:
                            break

                    tracks_with_path = await asyncio.gather(*futures)

                    save_m3u(
                        resource_type="mix",
                        filename=format_template(
                            CONFIG.m3u.templates.mix,
                            mix_id=resource.id,
                            type="mix",
                        ),
                        tracks_with_path=tracks_with_path,
                    )

                case "album":
                    album = ctx.obj.api.get_album(album_id=resource.id)
                    await download_album(album)

                case "artist":
                    futures = []

                    async def safe_download_album(album: Album):
                        try:
                            await download_album(album)
                        except ApiError as e:
                            output.diagnostic(f"API Error: {e} (Album: {album.title}, ID: {album.id})")
                            output.job_failed(
                                code="api_error",
                                message="Could not prepare an artist album.",
                            )
                            if RAISE_ERRORS:
                                raise
                        except Exception as e:
                            output.diagnostic(f"Error: {e} (Album: {album.title}, ID: {album.id})")
                            output.job_failed(
                                code="resource_error",
                                message="Could not prepare an artist album.",
                            )
                            if RAISE_ERRORS:
                                raise

                    def get_all_albums(singles: bool):
                        offset = 0

                        while True:
                            artist_albums = ctx.obj.api.get_artist_albums(
                                artist_id=resource.id,
                                offset=offset,
                                filter="EPSANDSINGLES" if singles else "ALBUMS",
                            )

                            for album in artist_albums.items:
                                futures.append(safe_download_album(album))

                            offset += artist_albums.limit
                            if offset >= artist_albums.totalNumberOfItems:
                                break

                    def get_all_videos():
                        offset = 0

                        while True:
                            artist_videos = ctx.obj.api.get_artist_videos(
                                resource.id, offset=offset
                            )

                            for video in artist_videos.items:
                                template = TEMPLATE or CONFIG.templates.video

                                try:
                                    if "{album" in template and video.album:
                                        album = ctx.obj.api.get_album(video.album.id)
                                    else:
                                        album = None

                                    futures.append(
                                        handle_item(
                                            item=video,
                                            file_path=format_template(
                                                template=template,
                                                item=video,
                                                album=album,
                                                quality=get_item_quality(video),
                                            ),
                                        )
                                    )
                                except ApiError as e:
                                    output.diagnostic(f"API Error: {e} (Video: {video.title}, ID: {video.id})")
                                    output.job_failed(
                                        code="api_error",
                                        message="Could not prepare an artist video.",
                                    )
                                    if RAISE_ERRORS:
                                        raise
                                except Exception as e:
                                    output.diagnostic(f"Error: {e} (Video: {video.title}, ID: {video.id})")
                                    output.job_failed(
                                        code="resource_error",
                                        message="Could not prepare an artist video.",
                                    )
                                    if RAISE_ERRORS:
                                        raise

                            if offset > artist_videos.totalNumberOfItems:
                                break

                            offset += artist_videos.limit

                    if VIDEOS_FILTER != "none":
                        get_all_videos()

                    if VIDEOS_FILTER != "only":
                        if SINGLES_FILTER == "include":
                            get_all_albums(False)
                            get_all_albums(True)
                        else:
                            get_all_albums(SINGLES_FILTER == "only")

                    await asyncio.gather(*futures)

                case "playlist":
                    offset = 0
                    futures = []
                    playlist_index = 0
                    playlist = ctx.obj.api.get_playlist(playlist_uuid=resource.id)

                    while True:
                        playlist_items = ctx.obj.api.get_playlist_items(
                            playlist_uuid=resource.id, offset=offset
                        )

                        for playlist_item in playlist_items.items:
                            playlist_index += 1
                            template = TEMPLATE or CONFIG.templates.playlist

                            try:
                                if "{album" in template:
                                    album = ctx.obj.api.get_album(
                                        playlist_item.item.album.id
                                    )
                                else:
                                    album = None

                                futures.append(
                                    handle_item(
                                        item=playlist_item.item,
                                        file_path=format_template(
                                            template=template,
                                            item=playlist_item.item,
                                            album=album,
                                            playlist=playlist,
                                            playlist_index=playlist_index,
                                            quality=get_item_quality(
                                                playlist_item.item
                                            ),
                                        ),
                                        track_metadata=Metadata(),
                                        playlist=playlist,
                                        playlist_index=playlist_index,
                                    )
                                )
                            except ApiError as e:
                                item = playlist_item.item
                                track_info = f"Track: {getattr(item, 'title', 'Unknown')} (ID: {item.id})"
                                if hasattr(item, "album") and item.album:
                                    track_info += f", Album ID: {item.album.id}"
                                output.diagnostic(f"API Error: {e} ({track_info})")
                                output.job_failed(
                                    code="api_error",
                                    message="Could not prepare a playlist item.",
                                )
                                if RAISE_ERRORS:
                                    raise
                            except Exception as e:
                                item = playlist_item.item
                                track_info = f"Track: {getattr(item, 'title', 'Unknown')} (ID: {item.id})"
                                output.diagnostic(f"Error: {e} ({track_info})")
                                output.job_failed(
                                    code="resource_error",
                                    message="Could not prepare a playlist item.",
                                )
                                if RAISE_ERRORS:
                                    raise

                        offset += playlist_items.limit
                        if offset >= playlist_items.totalNumberOfItems:
                            break

                    tracks_with_path = await asyncio.gather(*futures)

                    save_m3u(
                        resource_type="playlist",
                        filename=format_template(
                            CONFIG.m3u.templates.playlist,
                            playlist=playlist,
                            type="playlist",
                        ),
                        tracks_with_path=tracks_with_path,
                    )

                    if (
                        CONFIG.cover.save
                        and ("playlist" in CONFIG.cover.allowed)
                        and playlist.squareImage
                    ):
                        Cover(
                            playlist.squareImage, size=min(CONFIG.cover.size, 1080)
                        ).save_to_directory(
                            path=DOWNLOAD_PATH
                            / format_template(
                                template=CONFIG.cover.templates.playlist,
                                playlist=playlist,
                            )
                        )

        live_context = (
            Live(output.group, refresh_per_second=10, console=ctx.obj.console, transient=True)
            if isinstance(output, RichOutput)
            else nullcontext()
        )
        with live_context:

            async def wrapper(r: TidalResource):
                try:
                    await handle_resource(r)
                except ApiError as e:
                    output.diagnostic(f"API Error: {e} ({r})")
                    output.job_failed(
                        code="api_error",
                        message="Could not load a requested TIDAL resource.",
                    )
                    if RAISE_ERRORS:
                        raise
                except Exception as e:
                    log.exception("resource download failed")
                    output.diagnostic(f"Error: resource {r} could not be processed")
                    output.job_failed(
                        code="resource_error",
                        message="Could not process a requested TIDAL resource.",
                    )
                    if RAISE_ERRORS:
                        raise

            await asyncio.gather(*(wrapper(r) for r in ctx.obj.resources))

        output.show_stats()
        return output.job_completed()

    def run():
        if not asyncio.run(download_resources()):
            raise typer.Exit(1)

    ctx.call_on_close(run)
