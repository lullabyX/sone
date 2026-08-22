import json
import asyncio

from tiddl.cli.commands.download.downloader import Downloader
from tiddl.cli.commands.download.output import JsonlOutput


class HeadResponse:
    def __init__(self, content_length: int | None):
        self.content_length = content_length

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return None

    def raise_for_status(self):
        return None


class HeadSession:
    def __init__(self, content_lengths: dict[str, int | None]):
        self.content_lengths = content_lengths

    def head(self, url: str, **_: object) -> HeadResponse:
        return HeadResponse(self.content_lengths[url])


def test_total_bytes_requires_sizes_for_every_stream_segment():
    known = HeadSession({"first": 100, "second": 200})
    unknown = HeadSession({"first": 100, "second": None})

    assert asyncio.run(Downloader.get_total_bytes(None, known, ["first", "second"])) == 300
    assert asyncio.run(Downloader.get_total_bytes(None, unknown, ["first", "second"])) is None


def test_jsonl_output_is_valid_json_without_ansi_and_has_terminal_summary(capsys):
    output = JsonlOutput()
    output.job_started(resources=[{"type": "album", "id": "1", "url": "https://tidal.com/album/1"}], options={})
    output.item_discovered(item={"type": "track", "id": "1", "item_instance_id": "one", "title": "One"})
    output.item_started(item_id="1", item_type="track", item_instance_id="one", title="One", output_path="/music/one.flac", requested_quality="MAX")
    output.item_progress(None, item_id="1", item_type="track", item_instance_id="one", bytes_downloaded=0, bytes_total=10, progress=0, bytes_delta=0, final=True)
    output.item_completed(item_id="1", item_type="track", item_instance_id="one", title="One", output_path="/music/one.flac", quality="LOSSLESS")
    assert output.job_completed() is True

    captured = capsys.readouterr()
    records = [json.loads(line) for line in captured.out.splitlines()]
    assert [record["event"] for record in records] == ["job_started", "item_discovered", "item_started", "item_progress", "item_completed", "job_completed"]
    assert records[-1]["summary"] == {"discovered": 1, "completed": 1, "skipped": 0, "failed": 0}
    assert all("\x1b" not in json.dumps(record) for record in records)


def test_jsonl_output_counts_skips_and_failures_without_secrets(capsys):
    output = JsonlOutput()
    output.item_discovered(item={"type": "track", "id": "1", "item_instance_id": "one", "title": "One"})
    output.item_skipped(item_id="1", item_type="track", item_instance_id="one", title="One", reason="already_exists", output_path="/music/one.flac")
    output.item_discovered(item={"type": "track", "id": "2", "item_instance_id": "two", "title": "Two"})
    output.item_failed(item_id="2", item_type="track", item_instance_id="two", title="Two", stage="download", error={"code": "network_error", "message": "Network download failed"})
    # A failed item does not prevent subsequent terminal events in the same job.
    output.item_discovered(item={"type": "track", "id": "3", "item_instance_id": "three", "title": "Three"})
    output.item_completed(item_id="3", item_type="track", item_instance_id="three", title="Three", output_path="/music/three.flac")
    output.diagnostic("request failed: https://stream.example/token")
    assert output.job_completed() is False

    captured = capsys.readouterr()
    records = [json.loads(line) for line in captured.out.splitlines()]
    assert records[-1]["summary"] == {"discovered": 3, "completed": 1, "skipped": 1, "failed": 1}
    assert "https://stream.example/token" not in json.dumps(records)
    assert "https://stream.example/token" not in captured.err


def test_jsonl_diagnostics_do_not_expose_credentials_or_signed_urls(capsys):
    output = JsonlOutput()
    access_token = "access-token-not-for-output"
    output.diagnostic(
        f"Authorization: Bearer {access_token}; request failed: "
        f"https://stream.example/media?token={access_token}&signature=signed-value"
    )

    captured = capsys.readouterr()
    assert access_token not in captured.out
    assert access_token not in captured.err
    assert "signed-value" not in captured.out
    assert "signed-value" not in captured.err


def test_jsonl_output_marks_job_failures_unsuccessful(capsys):
    output = JsonlOutput()
    output.job_started(resources=[], options={})
    output.job_failed(
        code="authentication_required",
        message="Run 'tiddl auth login' before downloading.",
    )
    assert output.job_completed() is False

    records = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [record["event"] for record in records] == [
        "job_started",
        "job_failed",
        "job_completed",
    ]
    assert records[1]["error"]["code"] == "authentication_required"
    assert records[-1]["success"] is False
