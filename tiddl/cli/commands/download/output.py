import json
import re
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol
from uuid import uuid4

from rich.console import Console, Group
from rich.progress import (
    Progress,
    TransferSpeedColumn,
    SpinnerColumn,
    FileSizeColumn,
    MofNCompleteColumn,
    ProgressColumn,
    BarColumn,
    Task,
    TaskID,
)
from rich.text import Text
from rich.panel import Panel


class TimeElapsedColumn(ProgressColumn):
    """Renders time elapsed."""

    def render(self, task: Task) -> Text:
        """Show time elapsed."""
        elapsed = task.finished_time if task.finished else task.elapsed
        if elapsed is None:
            return Text("---", style="progress.elapsed")
        return Text(f"{elapsed:.2f}s", style="progress.elapsed")


class DownloadEventSink(Protocol):
    """Output boundary between download work and its presentation."""

    def job_started(self, *, resources: list[dict[str, str]], options: dict[str, Any]) -> None: ...
    def item_discovered(self, *, item: dict[str, Any]) -> None: ...
    def item_started(self, **kwargs: Any) -> Any: ...
    def item_progress(self, token: Any, **kwargs: Any) -> None: ...
    def transfer_finished(self, token: Any) -> Any: ...
    def item_completed(self, **kwargs: Any) -> None: ...
    def item_skipped(self, **kwargs: Any) -> None: ...
    def item_failed(self, **kwargs: Any) -> None: ...
    def job_failed(self, *, code: str, message: str) -> None: ...
    def job_completed(self) -> bool: ...
    def diagnostic(self, message: str) -> None: ...
    def total_increment(self, count: float = 1) -> None: ...
    def show_stats(self) -> None: ...


class RichOutput:
    def __init__(self, console: Console, download_height: int | None = None) -> None:
        self.console = console

        self.download_progress = Progress(
            SpinnerColumn(),
            "{task.description}",
            FileSizeColumn(),
            TransferSpeedColumn(),
            console=self.console,
        )
        self.total_progress = Progress(
            TimeElapsedColumn(),
            BarColumn(bar_width=None),
            MofNCompleteColumn(),
            console=self.console,
        )

        self.group = Group(
            Panel(
                self.download_progress,
                title="Downloading",
                border_style="magenta",
                title_align="left",
                height=download_height + 2 if download_height else None,
            ),
            Panel(
                self.total_progress,
                title="Total Progress",
                border_style="green",
                title_align="left",
            ),
        )

        self.total_task = self.total_progress.add_task("Total", total=0, start=True)
        self.total_downloads = 0

    def total_increment(self, count: float = 1):
        task = self.total_progress._tasks.get(self.total_task)

        assert task is not None
        assert task.total is not None

        self.total_progress.update(self.total_task, total=task.total + count)

    def download_start(self, description: str) -> TaskID:
        return self.download_progress.add_task(description=description, total=None)

    def download_advance(self, task_id: TaskID, size: float):
        self.download_progress.update(task_id=task_id, advance=size, refresh=True)

    def download_finish(self, task_id: TaskID) -> Task:
        task = self.download_progress._tasks.get(task_id)

        assert task is not None

        self.download_progress.remove_task(task_id=task_id)
        self.total_progress.advance(self.total_task, advance=1)
        self.total_downloads += 1

        return task

    # The event methods keep the existing human-oriented presentation unchanged.
    def job_started(self, *, resources: list[dict[str, str]], options: dict[str, Any]) -> None:
        pass

    def item_discovered(self, *, item: dict[str, Any]) -> None:
        pass

    def item_started(self, *, description: str, **_: Any) -> TaskID:
        return self.download_start(description)

    def item_progress(self, token: TaskID, *, bytes_delta: int, **_: Any) -> None:
        self.download_advance(token, bytes_delta)

    def transfer_finished(self, token: TaskID) -> Task:
        return self.download_finish(token)

    def item_completed(self, *, description: str, output_path: Path | None, **_: Any) -> None:
        self.show_item_result("[green]Downloaded", description, output_path)

    def item_skipped(self, *, title: str, output_path: Path | None, **_: Any) -> None:
        self.show_item_result("[yellow]Exists" if output_path else "[blue]Skipping", title, output_path)

    def item_failed(self, *, title: str, error: dict[str, str], **_: Any) -> None:
        self.console.print(f"[red]Error {title}[/] - {error['message']}")

    def job_failed(self, *, code: str, message: str) -> None:
        self.console.print(f"[red]Error[/] - {message}")

    def job_completed(self) -> bool:
        return True

    def diagnostic(self, message: str) -> None:
        self.console.print(message)

    def show_stats(self):
        self.console.print(f"[green]Total downloads: {self.total_downloads}")

    def show_item_result(
        self, result_message: str, item_description: str, item_path: Path | None
    ):
        if item_path:
            description = f"[link={item_path.as_uri()}]{item_description}[/link] [link={item_path.parent.as_uri()}]{item_path.parent}[/link]"
        else:
            description = item_description

        self.console.print(f"{result_message} {description}")


class JsonlOutput:
    """Stable, line-buffered JSONL event stream written exclusively to stdout."""

    schema_version = 1

    def __init__(self) -> None:
        self.job_id = str(uuid4())
        self.summary = {"discovered": 0, "completed": 0, "skipped": 0, "failed": 0}
        self._last_progress: dict[str, float] = {}
        self._job_failed = False

    def _emit(self, event: str, **payload: Any) -> None:
        record = {
            "schema_version": self.schema_version,
            "event": event,
            "timestamp": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "job_id": self.job_id,
            **payload,
        }
        print(json.dumps(record, ensure_ascii=False, separators=(",", ":")), file=sys.stdout, flush=True)

    def job_started(self, *, resources: list[dict[str, str]], options: dict[str, Any]) -> None:
        self._emit("job_started", resources=resources, options=options)

    def item_discovered(self, *, item: dict[str, Any]) -> None:
        self.summary["discovered"] += 1
        self._emit("item_discovered", item=item)

    def item_started(self, **kwargs: Any) -> None:
        kwargs.pop("description", None)
        self._emit("item_started", **kwargs)
        return None

    def item_progress(self, token: Any, **kwargs: Any) -> None:
        item_instance_id = kwargs.get("item_instance_id", kwargs["item_id"])
        now = time.monotonic()
        if not kwargs.pop("final", False) and now - self._last_progress.get(item_instance_id, 0) < 0.5:
            return
        self._last_progress[item_instance_id] = now
        kwargs.pop("bytes_delta", None)
        self._emit("item_progress", **kwargs)

    def transfer_finished(self, token: Any) -> None:
        return None

    def item_completed(self, **kwargs: Any) -> None:
        kwargs.pop("description", None)
        kwargs["output_path"] = str(kwargs["output_path"])
        self.summary["completed"] += 1
        self._emit("item_completed", **kwargs)

    def item_skipped(self, **kwargs: Any) -> None:
        if kwargs.get("output_path") is not None:
            kwargs["output_path"] = str(kwargs["output_path"])
        self.summary["skipped"] += 1
        self._emit("item_skipped", **kwargs)

    def item_failed(self, **kwargs: Any) -> None:
        self.summary["failed"] += 1
        self._emit("item_failed", **kwargs)

    def job_failed(self, *, code: str, message: str) -> None:
        self._emit("job_failed", error={"code": code, "message": message})
        self._job_failed = True

    def job_completed(self) -> bool:
        success = self.summary["failed"] == 0 and not self._job_failed
        self._emit("job_completed", summary=self.summary, success=success)
        return success

    def diagnostic(self, message: str) -> None:
        # Signed manifest URLs must never escape through structured-mode diagnostics.
        safe_message = re.sub(r"https?://\S+", "[redacted URL]", message)
        print(safe_message, file=sys.stderr, flush=True)

    def total_increment(self, count: float = 1) -> None:
        pass

    def show_stats(self) -> None:
        pass
