# Download events (JSONL)

`tiddl download --events jsonl url <TIDAL_URL>` writes one self-contained UTF-8 JSON object per line to stdout. It is intended for desktop applications and other streaming consumers. Human output remains the default (`--events human`). Technical diagnostics are written to stderr in JSONL mode.

Every event has `schema_version` (currently `1`), `event`, an RFC 3339 UTC `timestamp`, and a per-invocation UUID `job_id`. Consumers must validate `schema_version` before relying on fields added by a future release.

Events are emitted in this minimum order: `job_started`, one `item_discovered` per processable item, exactly one terminal item event (`item_completed`, `item_skipped`, or `item_failed`) per discovered item, then `job_completed`. A job-level failure that prevents a resource from being enumerated emits `job_failed` before `job_completed`. Concurrent downloads may interleave events. `item_id`, `item_type`, and the per-occurrence UUID `item_instance_id` identify every item; the last is required when a playlist contains a duplicate track.

## Event contract

`job_started` contains `resources` (`type`, `id`, `url`) and effective `options`: `download_path`, `track_quality`, `video_quality`, `threads_count`, and `skip_existing`.

`item_discovered` contains `item`: `type`, `id`, `item_instance_id`, `title`, `version`, `artist`, `artists`, `album`, `track_number`, `volume_number`, `playlist`, and `source_resource`. Fields inapplicable to videos are `null`; `playlist` is `null` outside playlists.

`item_started` contains `item_id`, `item_type`, `item_instance_id`, `title`, `output_path`, and `requested_quality`. The path is the final expected filename once the stream format is known.

`item_progress` contains `item_id`, `item_type`, `item_instance_id`, `bytes_downloaded`, `bytes_total`, and `progress`. It is emitted at start, at most about every 500 ms during transfer, and at finish. `bytes_total` and `progress` may be `null`; this is expected for segmented streams whose full size is unavailable before downloading completes.

`item_completed` contains item identity, `title`, `output_path`, and, for audio, `quality`, `audio_mode`, `bit_depth`, and `sample_rate`. Video completions provide `video_quality` when available.

`item_skipped` contains item identity, `title`, `reason`, and `output_path` when an existing file was found. Stable reasons are `already_exists`, `not_streamable`, `video_filter`, and `dolby_atmos_filter`.

`item_failed` contains item identity, `title`, a `stage` (`metadata`, `stream`, `download`, `conversion`, `tagging`, `filesystem`, or `unknown`), and `error` with stable `code` and a safe display `message`. Codes include `api_error`, `network_error`, `ffmpeg_not_found`, `ffmpeg_failed`, `filesystem_error`, and `unknown_error`. Events and diagnostics never intentionally include credentials, headers, tokens, or signed stream URLs.

`job_failed` is emitted when no individual item can represent the error, such as missing authentication, an invalid output template, or failure to enumerate a requested resource. It contains `error.code` and a safe display `error.message`. Codes include `authentication_required`, `invalid_output_template`, `api_error`, and `resource_error`.

`job_completed` is always the final event and contains `summary` (`discovered`, `completed`, `skipped`, `failed`) and `success`. The process exits with zero only when `failed` is zero and no `job_failed` event was emitted. Existing files skipped through `skip_existing` are successful skips.

## Examples

```console
tiddl download --events jsonl url https://tidal.com/track/103805726
tiddl download --events jsonl url https://tidal.com/album/103805723
tiddl download --events jsonl url https://tidal.com/playlist/playlist-uuid
tiddl download --events jsonl url https://tidal.com/artist/1234
tiddl download --events jsonl url https://tidal.com/video/5678
```

Example events:

```json
{"schema_version":1,"event":"item_discovered","timestamp":"2026-08-21T12:34:56.789Z","job_id":"1d23962d-4ea1-485d-8f1c-d3ce99589671","item":{"type":"track","id":"103805726","item_instance_id":"a452a0b2-16c0-42a0-8f90-6306fcd5de33","title":"Track Title","version":null,"artist":"Artist","artists":["Artist","Featured Artist"],"album":{"id":"103805723","title":"Album Title","artist":null},"track_number":1,"volume_number":1,"playlist":null,"source_resource":{"type":"album","id":"103805723","url":"https://listen.tidal.com/album/103805723"}}}
{"schema_version":1,"event":"item_completed","timestamp":"2026-08-21T12:35:10.100Z","job_id":"1d23962d-4ea1-485d-8f1c-d3ce99589671","item_id":"103805726","item_type":"track","item_instance_id":"a452a0b2-16c0-42a0-8f90-6306fcd5de33","title":"Track Title","output_path":"/music/Artist/Album/01 - Track Title.flac","quality":"HI_RES_LOSSLESS","audio_mode":"STEREO","bit_depth":24,"sample_rate":192000}
```
