# Sone Download Queue Via tiddl-headless

## Goal

Add a download queue to Sone for TIDAL tracks, albums, playlists, artists, and
videos. Sone delegates actual downloading to the user-installed, modified
`tiddl-headless` CLI. Sone never stores or shares its own TIDAL credentials
with the downloader.

## Implementation Status (2026-08-21)

### Completed

- Commit `968b3a4` adds the initial end-to-end queue integration.
- Sone resolves `tiddl` from the user `PATH` and runs the JSONL capability
  check `tiddl download --events jsonl url --help` before showing the folder
  picker.
- The official Tauri dialog plugin provides the directory picker. Sone passes
  the selected path with `--path` and the source-specific template with
  `--output`; it does not edit `~/.tiddl/config.toml`.
- Rust allows one active process, reads JSONL stdout and stderr concurrently,
  validates schema version 1 and known event names, emits dedicated download
  events, terminates incompatible children, and never emits stderr diagnostics
  to the frontend.
- The independent Jotai download queue/drawer works without a playing track.
  It has a player-bar button, `Download`, and a disabled-while-running
  `Clear download queue` action.
- Tracks, albums, playlists, artists, and videos can be added through shared
  card/row controls, page headers, and context menus. Playlist resources stay
  playlist URLs when invoking tiddl.
- Queue entries now expand before downloading: tracks/videos are immediate;
  albums and playlists use their media tracks; artists load their albums and
  album tracks. A preview-load failure does not prevent tiddl from resolving
  the queued resource.
- Frontend tests cover preview expansion, duplicate playlist queue entries,
  empty-queue state, and `check_tiddl -> folder picker -> start_download_job`.

### Verification Completed

- `tiddl` was found at `/home/mikele/.local/bin/tiddl`.
- The non-destructive capability command completed successfully.
- `pnpm test`: 198 tests passed.
- `pnpm build`: passed.
- `cargo check --manifest-path src-tauri/Cargo.toml --lib`: passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`: 124 tests passed.
- A release Tauri build passed with `pnpm tauri build --no-bundle`; the runnable
  binary is `src-tauri/target/release/sone`.
- The validation pass left the worktree clean. An existing Sone process was
  already running, so no second application instance was started.

### Remaining Manual Validation

#### Authenticated CLI Validation (2026-08-21)

- Started `src-tauri/target/release/sone`; its home view loaded and displayed
  the Download Queue icon in the player bar.
- A real authenticated `tiddl` track download completed successfully using the
  proposed album output template. Its JSONL stream included discovery, start,
  indeterminate progress, item completion, and `job_completed(success = true)`.
- A nonexistent numeric track emitted `job_failed(error.code = "api_error")`
  followed by `job_completed(success = false)`, without creating media files.
- These checks validate the installed downloader contract directly, not the
  queue drawer interaction. This validation environment can capture the Tauri
  window but its compositor does not expose virtual keyboard or pointer input,
  so it cannot operate the folder picker or queue controls programmatically.
- Re-launching the release binary on the same compositor confirmed that Sone
  restores its authenticated home session. Plasma's window-information API
  requires a manual selection and the environment has no pointer-injection
  tool, so queue controls were not activated blindly and no additional files
  were created.
- Follow-up drawer validation exposed a missing Tauri dialog ACL permission,
  which is now granted with `dialog:allow-open`.
- The drawer now waits for all download-event listeners before enabling
  `Download`. Backend job failures also reject the IPC call, so an error is
  shown even if an event cannot be delivered.
- The selected folder is passed to both `tiddl --path` and `--scan-path`.
  This prevents tiddl from finding an existing file in its configured default
  scan folder and skipping a requested copy in the selected folder.
- A real authenticated non-Atmos track was downloaded successfully to the
  selected folder. The drawer and terminal report the final output path.
- A Dolby Atmos track completed without a new file because the installed
  tiddl configuration filters Atmos media. This is a tiddl `skipped` outcome,
  not an Sone path or process failure.

#### How To Continue UI Validation

1. Use the running `src-tauri/target/release/sone` instance. If it is closed,
   start that binary from this checkout after confirming no other Sone instance
   is running.
2. Add a small track through its download icon or context menu, open Download
   Queue from the player bar, and confirm the queued resource and its preview
   are shown without starting playback or navigation.
3. Select a disposable directory when prompted by `Download`. Confirm the
   drawer shows `discovering`, `downloading`, and the final `success`,
   `skipped`, or `error` state; `Clear` must remain disabled while the job is
   running.
4. Repeat with an album, playlist, artist, and video chosen to keep the output
   size acceptable. Confirm albums/artists use the album layout, playlists use
   their playlist index, and videos use the Videos layout.
5. Exercise an item-level failure where feasible. Do not log out of `tiddl` to
   test authentication failure. The direct validation above already verified a
   job-level resource failure.
6. Record the observed results here, then run `git diff --check` before
   committing any documentation-only update.

For terminal diagnostics during further validation, start the release binary
from this checkout with:

```sh
RUST_LOG=tauri_app_lib::commands::downloads=debug ./src-tauri/target/release/sone
```

The logs include invocation counts, terminal item output paths, and safe
job-level errors, but not downloader diagnostics, credentials, or signed URLs.

1. Use the existing Sone instance (or launch
   `src-tauri/target/release/sone` after closing it), authenticate the
   separately installed downloader with `tiddl auth login`, and download a
   track, album, playlist, artist, and video to a disposable directory.
2. Confirm each JSONL terminal state renders correctly: success, skipped,
   item error, authentication failure, resource failure, and incompatible
   JSONL/schema failure.
3. Check dense card and virtualized-row layouts at desktop and narrow window
   widths to confirm download controls neither trigger playback nor navigation.
4. If this becomes an upstream PR, inspect
   `git diff upstream/master...HEAD` and keep generated build artifacts out of
   the PR.

The remaining steps require an authenticated user account and create real files;
they were intentionally not run during the automated validation pass.

The user must install and authenticate the downloader separately:

```sh
tiddl auth login
```

At development time the modified downloader lives at:

```text
/opt/tiddl-headless/tiddl
```

Its executable is:

```text
/opt/tiddl-headless/tiddl/.venv/bin/tiddl
```

For Sone releases, do not hard-code this development path. The integration
should launch the `tiddl` executable found in the user process `PATH` unless a
future downloader-command setting is explicitly added.

## User-Facing Requirements

- Every artist, album, track, playlist, and video exposes an icon button to
  add it to the download queue. Include the same action in existing context
  menus for accessibility and surfaces where an icon cannot fit.
- Add a global Download Queue button in the player bar, between Play Queue and
  Open Miniplayer.
- The button opens a dedicated queue view visually consistent with the current
  Play Queue drawer. It must work even when no track is playing; the current
  `NowPlayingDrawer` returns `null` without a playing track, so download queue
  cannot simply be another tab in that component without restructuring it.
- The view shows queued entries and their expanded tracks/videos, plus
  `Download` and `Clear download queue` buttons.
- `Download` opens a folder picker before creating a job.
- During a job, each discovered track/video updates live to `downloading`,
  `success`, `skipped`, or `error` according to `tiddl` JSONL events.
- If `tiddl` is missing, is too old to support JSONL, lacks authentication,
  exits unsuccessfully, or emits malformed JSONL, show a clear error prompt.

## tiddl-headless Contract

The modified downloader implements:

```sh
tiddl download --events jsonl [download options] url <tidal-url>...
```

`stdout` in JSONL mode is one UTF-8 JSON record per line. It must not contain
Rich output or ANSI escape sequences. Diagnostics are on `stderr`.

Read the complete contract before integrating:

```text
/opt/tiddl-headless/tiddl/docs/events.md
```

Relevant events, each with `schema_version`, `timestamp`, and `job_id`:

- `job_started`: accepted resources and effective options.
- `item_discovered`: full metadata for each track/video, including
  `item_instance_id`. This is the stable row key because a playlist may
  contain the same track more than once.
- `item_started`: resolved output path and requested quality.
- `item_progress`: downloaded byte count. `bytes_total` and `progress` may be
  `null` for segmented streams; do not manufacture a percentage in Sone.
- `item_completed`: final output path and negotiated quality data.
- `item_skipped`: terminal successful skip, including `already_exists`.
- `item_failed`: terminal failure for one discovered item.
- `job_failed`: authentication, resource enumeration, or invalid-template
  failure that cannot be attached to an individual item.
- `job_completed`: always the final event. Use `success`, not merely summary
  counts, to determine whether the process succeeded.

Important observed behavior after the local tiddl-headless changes:

- Missing authentication emits `job_started`,
  `job_failed(error.code = "authentication_required")`, and
  `job_completed(success = false)`, then exits with code 1.
- `tiddl download --events jsonl url --help` does not create an empty job.
- A resource failure makes `job_completed.success` false even when no item was
  discovered.

Sone must validate `schema_version === 1`. An unknown schema or malformed
event is a job-level error: terminate/await the process and explain that an
incompatible tiddl-headless version is installed.

## Required Output Templates

Pass `--path <folder selected by the user>` and `--output <template>` for each
job. Do not edit `~/.tiddl/config.toml`.

Tiddl templates omit the file extension; tiddl chooses it from the negotiated
stream (`.flac`, `.m4a`, or `.mp4`).

| Queue source | tiddl output template |
| --- | --- |
| Album | `{album.artist}/{album.title}/{item.number} - {item.title}` |
| Artist album tracks | `{album.artist}/{album.title}/{item.number} - {item.title}` |
| Playlist | `{playlist.title}/{playlist.index} - {item.artist} - {item.title}` |
| Video | `{item.artist}/Videos/{item.artist} - {item.title}` |

The individual-track convention remains unresolved. Proposed default, when
the item belongs to an album:

```text
{album.artist}/{album.title}/{item.number} - {item.title}
```

Run distinct tiddl invocations by source/template where necessary. A playlist
must be downloaded as a playlist resource so tiddl can populate
`playlist.index`; converting it to individual track URLs loses this context.

## Existing Sone Integration Points

Frontend:

- `src/components/PlayerBar.tsx`: player-bar right-side controls. Add the
  Download Queue button between `DrawerButtons` (Play Queue) and
  `MiniPlayerButton`.
- `src/components/NowPlayingDrawer.tsx`: reference for the queue UI, rows,
  virtualizer, theme classes, dismissal behavior, and track navigation. Do
  not make Download Queue dependent on `currentTrack`.
- `src/components/TrackContextMenu.tsx`: add `Add to download queue` for
  tracks and videos.
- `src/components/MediaContextMenu.tsx`: add the same action for albums,
  playlists, artists, and videos. Its existing `fetchMediaTracks` behavior is
  useful for display, but retain original resource URLs for invoking tiddl.
- `src/components/MediaCard.tsx`, `src/components/TrackList.tsx`, and page
  headers/views: add a visible download icon button. Reuse their established
  event-stop propagation conventions so the download action does not play or
  navigate the item.
- `src/atoms/ui.ts`: add independent download drawer/modal state; do not
  overload the stringly typed playback drawer state.
- `src/types.ts`: add download queue entry, expanded item, status, and parsed
  event types.
- `src/api/tidal.ts`: conventional home for typed Tauri `invoke` wrappers.

Backend:

- `src-tauri/src/commands/mod.rs`: register a new `downloads` command module.
- `src-tauri/src/lib.rs`: register its Tauri commands in
  `tauri::generate_handler!`.
- Existing commands use `SoneError` in `src-tauri/src/error.rs`; add a
  downloader-appropriate variant only if a structured IPC error needs one.
- Existing Tauri events provide the project pattern for streaming backend state
  to React. Emit dedicated names such as `download:job-started`,
  `download:item-discovered`, `download:item-started`,
  `download:item-progress`, `download:item-completed`,
  `download:item-skipped`, `download:item-failed`, `download:job-failed`, and
  `download:job-completed`.
- The project does not currently have a filesystem picker plugin. Add the
  official Tauri dialog plugin and use its frontend directory picker. The
  selected absolute path is passed to the backend download command.

## Backend Design

1. Implement `check_tiddl`:
   - Resolve `tiddl` using `std::process::Command` without a shell.
   - Invoke a harmless capability check such as
     `tiddl download --events jsonl url --help` and validate it exits zero.
   - Treat a missing executable, nonzero exit, absent JSONL support, or a help
     output incompatible with the expected CLI as a user-facing dependency
     error.

2. Implement one active download job at a time:
   - Prevent concurrent `tiddl` processes to avoid duplicate writes and
     ambiguous queue status.
   - Receive a queue snapshot, selected destination, and a list of invocation
     groups containing TIDAL URLs plus output options/templates.
   - Spawn with `tokio::process::Command`, args only, and piped `stdout` /
     `stderr`; never concatenate a shell command.
   - Read stdout line by line, parse JSON, validate `schema_version`, and emit
     the matching Tauri event immediately.
   - Read stderr concurrently, redact/log it, and preserve a short safe tail
     for the error prompt. Never expose signed stream URLs or credentials.
   - If a child exits without `job_completed`, emit a synthesized job failure.
   - Do not call the TIDAL API or open media streams from Rust solely for
     downloading; tiddl owns its own authenticated TIDAL interaction.

3. Do not make native file existence the source of truth. Tiddl emits final
   paths and skip/failure states. Sone displays those events.

4. Cancellation was not requested. Do not add it unless the product decision
   below changes. If added later, terminate the child process, wait for it,
   and emit a clearly distinct cancelled terminal job state.

## Frontend State Design

Use a separate atom family/module, for example `src/atoms/downloads.ts`:

- `downloadQueueAtom`: user-enqueued source resources, preserving insertion
  order and duplicate entries.
- `downloadJobAtom`: `idle | choosing-folder | checking | downloading |
  complete | failed` plus destination, job ID, diagnostics, and started time.
- `downloadItemsAtom`: keyed by `item_instance_id`, with source reference,
  metadata, output path, byte count, and terminal status.

Suggested statuses:

```ts
type DownloadItemStatus =
  | "queued"
  | "discovering"
  | "downloading"
  | "success"
  | "skipped"
  | "error";
```

Queue additions should be optimistic and deduplicate only if the product
decision calls for it. Do not reuse playback IDs such as `_qid`; download and
play queues have independent lifetimes and semantics.

On `Download`:

1. Reject an empty queue locally.
2. Call `check_tiddl`; show a modal/prompt with installation and
   `tiddl auth login` guidance if it fails.
3. Open the folder picker only after dependency validation succeeds.
4. Build invocation groups using original TIDAL resource URLs and the required
   templates.
5. Subscribe to download events before calling `start_download_job` to avoid
   losing early events.
6. Start the job and update state from Tauri events.
7. Clear only the completed job's transient expanded rows after an explicit
   user action; preserve results long enough for inspection.

`Clear download queue` must be disabled while a job runs unless cancellation
is implemented. Clearing must never delete files already downloaded.

## Tests And Verification

Sone tests should mock Tauri `invoke`, directory picker, and `listen` events.

- Unit-test queue addition for every supported entity type.
- Test duplicate playlist tracks use distinct `item_instance_id` rows.
- Test all JSONL terminal states and job-level authentication/resource errors.
- Test malformed/unknown-schema events show a compatibility failure.
- Test the picker is opened only after `check_tiddl` passes.
- Test empty queue and active-job button states.
- Test the global button position and a download queue view with no playback.
- Test that visible icon buttons do not trigger card navigation/playback.

Run after implementation:

```sh
pnpm test
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml --lib
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

## Decisions Still Required

Do not silently choose these in the implementation session:

1. Which executable is the release dependency: `tiddl` in `PATH`, a specific
   `tiddl-headless` binary name, or a configurable path?
2. Required minimum tiddl-headless version/capability check beyond JSONL.
3. Individual-track output convention. The proposed album-based layout is
   above.
4. Artist scope: albums only, albums + EPs/singles, and whether to include
   videos. Tiddl defaults to albums only; `--singles include` and
   `--videos allow` change this.
5. Audio/video quality: use the user's tiddl config or expose Sone controls
   that pass `--track-quality` and `--video-quality`.
6. Remember the last selected destination or require a folder picker for every
   job.
7. Persist the queue and completed statuses across Sone restarts.
8. Allow individual removal, retry, and cancellation. Only `Download` and
   `Clear download queue` are required now.
9. Exact visible-button coverage on dense list rows versus only headers/cards
   plus context menus. The original requirement asks for every entity.

## Non-Goals

- Do not install, update, authenticate, or configure tiddl on the user's
  behalf.
- Do not rewrite `~/.tiddl/config.toml`.
- Do not download through Sone's streaming pipeline.
- Do not claim downloaded media is playable offline in Sone; that is a
  separate local-library feature.
